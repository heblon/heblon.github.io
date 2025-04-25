// Add Apache Arrow import at the top
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm"; // Using 1.29.0
import * as arrow from "https://cdn.jsdelivr.net/npm/apache-arrow@latest/+esm";

// 🔐 Replace with your real Client ID
const CLIENT_ID = "561411244038-36ta31kbti2gmnugj5cvqvhb6ro15ors.apps.googleusercontent.com";

let conn = null; // Initialize explicitly to null
let duckDBInstance = null; // Keep track of the main DB instance
let duckReady = false;
let accessToken = null;
let sourceSheetId = null;
let destSheetId = null;
let gridInstance = null; // To hold the Grid.js instance

// --- UI Elements (cache for performance) ---
let loginButton, sourceSelect, tabSelect, rangeInput, loadButton, sqlInput, runButton, outputArea, destSelect, createDestButton, saveButton;
let loadingIndicator, errorMessage, loadStatus, queryStatus, saveStatus;
// Add new elements
let columnNamesArea, columnNamesList, copyColumnsButton;

// --- Helper Function for Displaying Errors ---
function displayError(message, error = null) {
  const fullMessage = message + (error ? `\nDetails: ${error.message || error}` : '');
  console.error("❌ ERROR:", message, error); // Log error with details
  errorMessage.textContent = fullMessage;
  errorMessage.style.display = 'block';
  // Hide loading indicator if an error occurs
  hideLoading();
}

// --- Helper Function for Status Updates ---
function showLoading(message = "⏳ Loading...") {
    loadingIndicator.textContent = message;
    loadingIndicator.style.display = 'block';
    errorMessage.style.display = 'none'; // Hide previous errors
}

function hideLoading() {
    loadingIndicator.style.display = 'none';
}

function showStatus(element, message, isError = false) {
    element.textContent = message;
    element.className = `status-indicator ${isError ? 'error' : 'success'}`; // Use CSS classes
    element.style.display = 'block';
}

function hideStatus(element) {
    element.style.display = 'none';
}


// --- DuckDB Initialization ---
async function setupDuckDB() {
  console.log("🦆 STEP 1: Starting setupDuckDB (Blob URL Worker Creation)...");
  showLoading("⏳ Initializing DuckDB...");
  duckReady = false;
  conn = null;
  duckDBInstance = null;
  let workerUrl = null;

  try {
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING); // Keep WARNING for production
    console.log("🦆 STEP 2: Logger created.");

    const bundles = duckdb.getJsDelivrBundles();
    const bundle = bundles.mvp;
    if (!bundle || !bundle.mainModule || !bundle.mainWorker) {
        throw new Error("Could not find MVP bundle configuration.");
    }
    console.log(`🦆 STEP 3: Using MVP bundle - Module: ${bundle.mainModule}, Worker Script Source: ${bundle.mainWorker}`);

    console.log("🦆 STEP 4: Creating Blob URL for worker script:", bundle.mainWorker);
    const workerScriptContent = `try { importScripts("${bundle.mainWorker}"); } catch (e) { console.error("Error importing worker script:", e); throw e; }`;
    const blob = new Blob([workerScriptContent], { type: 'text/javascript' });
    workerUrl = URL.createObjectURL(blob);
    console.log("🦆 STEP 4.1: Blob URL created:", workerUrl);

    console.log("🦆 STEP 4.2: Creating Worker instance from Blob URL...");
    const worker = new Worker(workerUrl);
    console.log("🦆 STEP 4.3: Worker instance created:", worker);

    duckDBInstance = new duckdb.AsyncDuckDB(logger, worker);
    console.log("🦆 STEP 5: AsyncDuckDB instance created with worker:", duckDBInstance);

    console.log("🦆 STEP 6: Calling db.instantiate with ONLY mainModule:", bundle.mainModule);
    await duckDBInstance.instantiate(bundle.mainModule);
    console.log("🦆 STEP 7: db.instantiate completed.");

    console.log("🦆 STEP 7.1: Revoking Blob URL:", workerUrl);
    URL.revokeObjectURL(workerUrl);
    workerUrl = null;

    try {
        console.log("🦆 STEP 7.2: Attempting db.getVersion()...");
        const version = await duckDBInstance.getVersion();
        console.log(`🦆 STEP 7.3: DuckDB WASM Version Check SUCCESS: ${version}`);
    } catch (versionError) {
        console.warn("🦆 STEP 7.3: Warning during initial version check:", versionError);
    }

    console.log("🦆 STEP 8: Calling db.connect...");
    conn = await duckDBInstance.connect();
    console.log("🦆 STEP 9: db.connect completed. Connection object:", conn);

    if (conn && conn._conn !== undefined) {
        console.log("🦆 STEP 10: Connection object obtained and internal handle (_conn) is defined.");
        duckReady = true;
        console.log("✅ DuckDB is ready (using Blob URL created MVP Web Worker)!");
        hideLoading(); // Hide general loading indicator
        outputArea.textContent = "DuckDB ready. Please sign in to load Google Sheets data."; // Update status
        runButton.disabled = false; // Enable run button now
    } else {
         throw new Error("Failed to obtain a valid connection object from db.connect().");
    }

  } catch (err) {
    displayError("❌ Failed to initialize DuckDB.", err);
    duckReady = false;
    conn = null;
    duckDBInstance = null;
    console.error("🦆 DuckDB Initialization Error Details:", err);
    if (workerUrl) {
        console.log("🦆 Cleaning up Blob URL after error...");
        URL.revokeObjectURL(workerUrl);
    }
    outputArea.textContent = "DuckDB initialization failed. Check console."; // Update status
  }
}

// --- Google Authentication ---
let tokenClient;

function initializeGoogleAuth() {
  console.log("🔑 GAuth STEP 1: Initializing Google Auth...");
  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
      callback: async (response) => {
        console.log("🔑 GAuth STEP 2: Token Client Callback received.");
        if (response.error) {
          displayError("Authentication error", response.error);
          console.error("🔑 GAuth STEP 2.1: Token response error:", response.error);
          return;
        }
        accessToken = response.access_token;
        console.log("🔑 GAuth STEP 3: Access Token obtained.");
        showLoading("⏳ Initializing Google API Client...");

        gapi.load("client", async () => {
          console.log("🔑 GAuth STEP 5: GAPI client library loaded. Initializing...");
          try {
            await gapi.client.init({
              discoveryDocs: [
                "https://sheets.googleapis.com/$discovery/rest?version=v4",
                "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"
              ]
            });
            gapi.client.setToken({ access_token: accessToken });
            console.log("🔑 GAuth STEP 6: GAPI client initialized successfully.");

            await loadSpreadsheets(); // Load spreadsheets after successful auth & init

            console.log("🔑 GAuth STEP 7: Enabling UI elements.");
            sourceSelect.disabled = false;
            // tabSelect, rangeInput, loadButton enabled when source is selected
            destSelect.disabled = false;
            createDestButton.disabled = false;
            // saveButton enabled when destination is selected
            loginButton.textContent = "🔓 Signed In";
            loginButton.disabled = true;
            hideLoading();

          } catch (err) {
            displayError("❌ Failed to initialize Google API client.", err);
            console.error("🔑 GAuth STEP 6.1: GAPI client init error:", err);
          }
        });
      }
    });
    console.log("🔑 GAuth STEP 1.1: Token Client initialized structure.");
  } catch (err) {
    displayError("❌ Failed to initialize Google Sign-In.", err);
    console.error("🔑 GAuth STEP 1.2: initTokenClient error:", err);
  }
}

// --- Spreadsheet and Tab Loading ---
async function loadSpreadsheets() {
  console.log("📄 Drive STEP 1: Loading spreadsheets...");
  showLoading("⏳ Loading your spreadsheets...");
  sourceSelect.innerHTML = "<option value=''>Loading...</option>";
  destSelect.innerHTML = "<option value=''>Loading...</option>";
  sourceSelect.disabled = true;
  destSelect.disabled = true;
  try {
    const res = await gapi.client.drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed = false", // Exclude trashed files
      fields: "files(id, name)",
      orderBy: "name" // Request sorting by name from the API
    });
    console.log("📄 Drive STEP 2: Received spreadsheet list response.");

    sourceSelect.innerHTML = "<option value=''>-- Select Source Sheet --</option>";
    destSelect.innerHTML = "<option value=''>-- Select Destination Sheet --</option>";

    if (!res.result.files || res.result.files.length === 0) {
        console.log("📄 Drive STEP 3: No spreadsheets found.");
        sourceSelect.disabled = false;
        destSelect.disabled = false;
        hideLoading();
        return;
    }

    console.log(`📄 Drive STEP 3: Found ${res.result.files.length} spreadsheets. Populating dropdowns...`);
    // Files are already sorted by name due to `orderBy: "name"` in the API call
    res.result.files.forEach(file => {
      sourceSelect.appendChild(new Option(file.name, file.id));
      destSelect.appendChild(new Option(file.name, file.id));
    });
    console.log(`📄 Drive STEP 4: Dropdowns populated.`);
    sourceSelect.disabled = false;
    destSelect.disabled = false;
    hideLoading();

    // Add change listener for source selection
    sourceSelect.onchange = async e => {
      sourceSheetId = e.target.value;
      console.log(`📄 Drive Event: Source selection changed to ID: ${sourceSheetId}`);
      // Disable load button until tab is selected
      loadButton.disabled = true;
      tabSelect.innerHTML = "<option value=''>-- Select Tab --</option>";
      tabSelect.disabled = true;
      if (sourceSheetId) {
        console.log(`   Source URL: https://docs.google.com/spreadsheets/d/${sourceSheetId}/edit`);
        rangeInput.disabled = false; // Enable range input
        await populateTabs(sourceSheetId); // Load tabs for the selected sheet
      } else {
        rangeInput.disabled = true;
        console.log("   Source selection cleared, disabling tab select and range.");
      }
    };

    // Add change listener for destination selection
    destSelect.onchange = e => {
        destSheetId = e.target.value;
        console.log(`🎯 Drive Event: Destination selection changed to ID: ${destSheetId}`);
        saveButton.disabled = !destSheetId; // Enable save button only if a destination is selected
        if(destSheetId) {
            console.log(`   Destination URL: https://docs.google.com/spreadsheets/d/${destSheetId}/edit`);
        }
    };

  } catch (err) {
    displayError("❌ Failed to load spreadsheets from Google Drive.", err);
    console.error("📄 Drive STEP ERR: Error loading spreadsheets:", err);
    sourceSelect.innerHTML = "<option value=''>Error loading</option>";
    destSelect.innerHTML = "<option value=''>Error loading</option>";
    sourceSelect.disabled = false;
    destSelect.disabled = false;
    hideLoading();
  }
}

async function populateTabs(spreadsheetId) {
  console.log(`📄 Tabs STEP 1: Loading tabs for sheet ID: ${spreadsheetId}`);
  showLoading(`⏳ Loading tabs for selected sheet...`);
  tabSelect.innerHTML = "<option value=''>Loading tabs...</option>";
  tabSelect.disabled = true;
  loadButton.disabled = true; // Keep load disabled while tabs load
  try {
    const res = await gapi.client.sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties(title)' // Only request titles
    });
    console.log(`📄 Tabs STEP 2: Received tabs metadata response for sheet ID: ${spreadsheetId}`);
    tabSelect.innerHTML = ""; // Clear loading message

    if (!res.result.sheets || res.result.sheets.length === 0) {
        tabSelect.appendChild(new Option("No tabs found", ""));
        console.log("📄 Tabs STEP 3: No tabs found in the selected spreadsheet.");
        hideLoading();
        return;
    }

    console.log(`📄 Tabs STEP 3: Found ${res.result.sheets.length} tabs. Populating dropdown...`);
    // Sort tabs alphabetically by title
    const sortedSheets = res.result.sheets.sort((a, b) =>
        a.properties.title.localeCompare(b.properties.title)
    );
    tabSelect.appendChild(new Option("-- Select Tab --", "")); // Add placeholder
    sortedSheets.forEach(sheet => {
      tabSelect.appendChild(new Option(sheet.properties.title, sheet.properties.title));
    });
    tabSelect.disabled = false; // Enable dropdown now that it has options
    console.log(`📄 Tabs STEP 4: Tabs dropdown populated and enabled.`);

    // Add change listener for tab selection
    tabSelect.onchange = e => {
        const selectedTab = e.target.value;
        console.log(`📄 Tabs Event: Tab selection changed to: ${selectedTab}`);
        loadButton.disabled = !selectedTab; // Enable load button only if a tab is selected
    };
    hideLoading();

  } catch (err) {
    displayError(`❌ Failed to load tabs for spreadsheet ID: ${spreadsheetId}.`, err);
    console.error(`📄 Tabs STEP ERR: Error loading tabs for sheet ID ${spreadsheetId}:`, err);
    tabSelect.innerHTML = "<option value=''>Error loading tabs</option>";
    tabSelect.disabled = true;
    hideLoading();
  }
}

// --- Core Data Operations ---
async function loadSheet() {
  // +++ Log entry and variable state +++
  console.log("🚀 LoadSheet ENTRY: Function called.");
  console.log(`   Current state: duckReady=${duckReady}, sourceSheetId=${sourceSheetId}, tabSelect.value=${tabSelect?.value}`);
  // +++ END +++

  outputArea.textContent = "Starting data load...";
  hideStatus(loadStatus);
  showLoading("⏳ Loading data from sheet...");
  loadButton.disabled = true;
  // Hide column names area when starting a new load
  columnNamesArea.style.display = 'none';
  columnNamesList.textContent = '';
  copyColumnsButton.disabled = true;
  copyColumnsButton.textContent = '📋 Copy'; // Reset button text

  // --- Initial Checks ---
  if (!duckReady) { /* ... */ displayError("DuckDB not ready."); hideLoading(); loadButton.disabled = false; return; }
  console.log("🚀 LoadSheet STEP 1.2: DuckDB ready check passed.");
  if (!sourceSheetId) { /* ... */ displayError("Source sheet not selected."); hideLoading(); loadButton.disabled = false; return; }
  console.log("🚀 LoadSheet STEP 1.4: Source sheet selected:", sourceSheetId);
  const tab = tabSelect.value;
  const range = rangeInput.value || "A1:Z1000";
  if (!tab) { /* ... */ displayError("Sheet tab not selected."); hideLoading(); loadButton.disabled = false; return; }
  console.log(`🚀 LoadSheet STEP 1.6: Tab selected: '${tab}', Range: '${range}'`);
  const fullRange = `'${tab}'!${range}`;

  // --- Combined GAPI Fetch and DuckDB Processing Block ---
  let transactionStarted = false;
  try {
      // --- Fetch Data from Google Sheets ---
      console.log(`🚀 LoadSheet STEP 2: Requesting data from Google Sheets range: ${fullRange}`);
      outputArea.textContent = `Loading data from ${fullRange}...`;
      const params = { spreadsheetId: sourceSheetId, range: fullRange, valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' };
      console.log("   GAPI Params:", JSON.stringify(params));
      if (!sourceSheetId) { throw new Error("Internal Error: sourceSheetId became null before GAPI call."); }
      const res = await gapi.client.sheets.spreadsheets.values.get(params);
      console.log("🚀 LoadSheet STEP 3: Received data from Google Sheets.");
      const values = res.result.values;

      // --- Check if data was returned ---
      if (!values || values.length < 1) {
          displayError("No data found in the selected range or sheet.");
          console.warn("🚀 LoadSheet STEP 3.1: No data returned from Sheets API.");
          outputArea.textContent = "No data found in range.";
          try { await conn.query("DROP TABLE IF EXISTS sheet_data;"); } catch(e){}
          // No return here, proceed to finally block
      } else {
          console.log(`🚀 LoadSheet STEP 3.5: Received ${values.length} rows from Sheets.`);
          showLoading("⏳ Processing data and loading into DuckDB...");

          // --- Process Data for DuckDB ---
          console.log("🚀 LoadSheet STEP 4: Processing fetched data for DuckDB...");
          const headers = values[0].map((h, idx) => String(h || `col_${idx}_${Date.now()}`));
          const dataRows = values.length > 1 ? values.slice(1) : [];
          console.log(`🚀 LoadSheet STEP 4.1: Headers identified (${headers.length}):`, headers);

          // +++ NEW: Display Column Names +++
          columnNamesList.textContent = headers.join(', '); // Display comma-separated
          columnNamesArea.style.display = 'block'; // Show the area
          copyColumnsButton.disabled = false; // Enable copy button
          // +++ END NEW +++

          const objects = dataRows.map((row) => {
              const obj = {};
              headers.forEach((h, i) => { obj[h] = (row && row[i] !== undefined && row[i] !== null) ? row[i] : null; });
              return obj;
          });
          console.log(`🚀 LoadSheet STEP 4.2: Converted ${objects.length} data rows to objects.`);

          // --- DuckDB Operations within Transaction ---
          console.log("🚀 LoadSheet STEP 5: Starting DuckDB transaction...");
          await conn.query("BEGIN TRANSACTION;");
          transactionStarted = true;
          console.log("🚀 LoadSheet STEP 5.0.1: BEGIN TRANSACTION executed.");

          const dropSQL = "DROP TABLE IF EXISTS sheet_data;";
          console.log("🚀 LoadSheet STEP 5.1: Attempting to execute:", dropSQL);
          await conn.query(dropSQL);
          console.log("🚀 LoadSheet STEP 5.2: Successfully executed:", dropSQL);

          const quotedHeaders = headers.map(h => `"${h.replace(/"/g, '""')}"`);
          const createTableSQL = `CREATE TABLE sheet_data (${quotedHeaders.map(h => `${h} VARCHAR`).join(", ")});`;
          console.log("🚀 LoadSheet STEP 5.3: Attempting to execute:", createTableSQL);
          await conn.query(createTableSQL);
          console.log("🚀 LoadSheet STEP 5.4: Successfully executed:", createTableSQL);

          // --- Use INSERT INTO ... VALUES for ALL rows (as Arrow was problematic) ---
          if (objects.length > 0) {
              const numRowsToInsert = objects.length;
              console.log(`🚀 LoadSheet STEP 5.5: Attempting to insert ${numRowsToInsert} rows using conn.query(INSERT INTO)...`);

              for (let i = 0; i < numRowsToInsert; i++) {
                  const rowObject = objects[i];
                  const valuesString = headers.map(h => {
                      const value = rowObject[h];
                      if (value === null || value === undefined) { return "NULL"; }
                      const escapedValue = String(value).replace(/'/g, "''");
                      return `'${escapedValue}'`;
                  }).join(", ");

                  const insertSQL = `INSERT INTO sheet_data (${quotedHeaders.join(", ")}) VALUES (${valuesString});`;
                  if (i === 0 || (i + 1) % 100 === 0 || i === numRowsToInsert - 1) {
                     console.log(`   Executing INSERT for row ${i + 1}/${numRowsToInsert}...`);
                  }
                  try {
                      await conn.query(insertSQL);
                  } catch (insertErr) {
                      console.error(`   ERROR inserting row ${i}:`, insertErr);
                      console.error(`   Failed SQL (showing first 500 chars): ${insertSQL.substring(0, 500)}...`);
                      throw insertErr;
                  }
              }
              console.log(`🚀 LoadSheet STEP 5.7: Successfully executed ${numRowsToInsert} INSERT statements.`);

          } else {
              console.log("🚀 LoadSheet STEP 5.5-SKIP: No data rows to insert.");
          }
          // --- END INSERT INTO ---

          // --- Commit Transaction ---
          console.log("🚀 LoadSheet STEP 5.8: Attempting to COMMIT transaction...");
          await conn.query("COMMIT;");
          transactionStarted = false;
          console.log("🚀 LoadSheet STEP 5.8.1: COMMIT executed successfully.");

          // --- Row Count Check (AFTER COMMIT) ---
          let finalRowCount = 0;
          try {
              console.log("🚀 LoadSheet STEP 5.9: Attempting row count check (post-commit)...");
              const countResult = await conn.query("SELECT COUNT(*) as count FROM sheet_data;");
              const countArray = countResult.toArray();
              if (countArray && countArray.length > 0) {
                  finalRowCount = Number(countArray[0].count);
                  console.log(`🚀 LoadSheet STEP 5.9.1: Post-commit count check result: ${finalRowCount} rows.`);
                  if (finalRowCount !== objects.length) {
                      console.warn(`   WARN: Post-commit count (${finalRowCount}) does not match expected objects (${objects.length})!`);
                      showStatus(loadStatus, `Warning: Loaded ${finalRowCount} rows, expected ${objects.length}.`, true);
                  } else {
                      showStatus(loadStatus, `✅ Successfully loaded ${finalRowCount} rows into table 'sheet_data'.`);
                  }
              } else { /* ... count check failed log ... */ }
          } catch (countErr) { /* ... count check error log ... */ }

          // --- Success ---
          console.log("🚀 LoadSheet STEP 6: DuckDB operations completed successfully.");
          outputArea.textContent = `Data loaded successfully!\n${objects.length} rows processed and inserted via SQL.\nTable 'sheet_data' created/updated.\nReady to run queries.`;
          // alert("Data loaded into DuckDB!"); // Replaced by status
      } // End of else block (if values were found)

  } catch (err) { // Catch errors from GAPI, DuckDB operations, or COMMIT
      console.error("🚀 LoadSheet Processing/DB ERR:", err);
      if (transactionStarted) {
          try {
              console.warn("   Attempting to ROLLBACK transaction due to error...");
              await conn.query("ROLLBACK;");
              console.warn("   ROLLBACK executed.");
          } catch (rollbackErr) {
              console.error("   ERROR during ROLLBACK:", rollbackErr);
          }
      }
      if (err.result && err.result.error) {
          displayError(`❌ Failed to get data from sheet '${tab}'. Check range and permissions.`, err.result.error);
          showStatus(loadStatus, `Error fetching data: ${err.result.error.message || err}`, true);
      } else {
          displayError(`❌ Error during sheet loading/processing.`, err);
          showStatus(loadStatus, `Processing/DB Error: ${err.message || err}`, true);
      }
  } finally {
      hideLoading();
      loadButton.disabled = false;
  }
}


async function runQuery() {
  console.log("🚀 RunQuery STEP 1: Starting runQuery function.");
  hideStatus(queryStatus); // Clear previous status
  showLoading("⏳ Running query...");
  runButton.disabled = true; // Disable button during query

  // Clear previous Grid.js table if it exists
  if (gridInstance) {
      try {
          gridInstance.destroy();
      } catch(e) { console.warn("Could not destroy previous grid instance", e); }
      gridInstance = null;
      outputArea.innerHTML = ''; // Clear the container
  }

  if (!duckReady) { /* ... */ displayError("DuckDB not ready."); hideLoading(); runButton.disabled = false; return; }
  const sql = sqlInput.value;
  if (!sql.trim()) { /* ... */ displayError("SQL query cannot be empty."); hideLoading(); runButton.disabled = false; return; }
  console.log(`🚀 RunQuery STEP 2: SQL to execute: ${sql}`);

  try {
    console.log("🚀 RunQuery STEP 3: Attempting conn.query...");
    const result = await conn.query(sql); // Returns Arrow Table
    console.log("🚀 RunQuery STEP 4: conn.query completed. Processing results...");
    const resultArray = result.toArray(); // Convert to array of objects
    console.log(`🚀 RunQuery STEP 5: Query returned ${resultArray.length} rows.`);

    // --- Render results using Grid.js ---
    if (resultArray.length === 0) {
        if (result.schema.fields.length > 0) {
             showStatus(queryStatus, `Query OK. Columns: ${result.schema.fields.map(f => f.name).join(', ')}. Rows returned: 0.`);
        } else {
             showStatus(queryStatus, "Query OK, no rows returned or affected.");
        }
        outputArea.innerHTML = ''; // Ensure output area is empty
    } else {
        const headers = result.schema.fields.map(field => field.name);
        // Map data for Grid.js (array of arrays)
        const dataForGrid = resultArray.map(row => headers.map(header => row[header]));

        console.log("🚀 RunQuery STEP 6: Rendering results with Grid.js...");
        // Ensure the outputArea is empty before rendering
        outputArea.innerHTML = '';
        gridInstance = new gridjs.Grid({
            columns: headers,
            data: dataForGrid,
            search: true, // Enable search
            sort: true,   // Enable sorting
            pagination: { // Optional: Add pagination for large results
                enabled: true,
                limit: 15,
                summary: true
            },
            style: { // Use Grid.js styling capabilities
                table: {
                  'font-size': '13px',
                  border: '1px solid #ccc'
                },
                th: {
                  'background-color': '#f2f2f2',
                  'border': '1px solid #ccc',
                  'padding': '8px'
                },
                td: {
                  'border': '1px solid #eee',
                  'padding': '8px'
                }
            }
        }).render(outputArea); // Render the grid into the output div
        console.log("🚀 RunQuery STEP 7: Grid.js rendering complete.");
        showStatus(queryStatus, `✅ Query successful, ${resultArray.length} rows displayed.`);
    }
    // --- END Grid.js Rendering ---

    console.log(`✅ Query executed successfully.`);
    hideLoading();
    runButton.disabled = false; // Re-enable button

  } catch (err) {
    displayError("❌ SQL Query Error.", err);
    console.error("🚀 RunQuery STEP 3.ERR: conn.query failed:", err);
    showStatus(queryStatus, `SQL Error: ${err.message || err}`, true);
    outputArea.innerHTML = ''; // Clear output on error
    hideLoading();
    runButton.disabled = false; // Re-enable button
  }
}

async function createDestinationSheet() {
    console.log("💾 CreateDest STEP 1: Starting createDestinationSheet...");
    hideStatus(saveStatus);
    showLoading("⏳ Creating new spreadsheet...");
    createDestButton.disabled = true;
    saveButton.disabled = true; // Also disable save while creating

    try {
        const res = await gapi.client.sheets.spreadsheets.create({
            resource: {
                properties: {
                    title: "DuckDB Export " + new Date().toLocaleString()
                }
            }
        });
        console.log("💾 CreateDest STEP 2: Received response from create API.");

        destSheetId = res.result.spreadsheetId;
        const newSheetTitle = res.result.properties.title;
        const newSheetUrl = res.result.spreadsheetUrl;
        console.log(`💾 CreateDest STEP 3: New sheet created - Title: "${newSheetTitle}", ID: ${destSheetId}, URL: ${newSheetUrl}`);

        console.log("💾 CreateDest STEP 4: Adding new sheet to dropdowns...");
        const optSource = new Option(newSheetTitle, destSheetId);
        const optDest = new Option(newSheetTitle, destSheetId);
        // Insert the new option after the placeholder
        if (sourceSelect.options.length > 0) {
            sourceSelect.insertBefore(optSource, sourceSelect.options[1]);
        } else {
            sourceSelect.appendChild(optSource);
        }
         if (destSelect.options.length > 0) {
            destSelect.insertBefore(optDest, destSelect.options[1]);
        } else {
            destSelect.appendChild(optDest);
        }

        destSelect.value = destSheetId; // Select the new sheet
        console.log("💾 CreateDest STEP 5: New sheet selected in destination dropdown.");
        showStatus(saveStatus, `✅ New sheet "${newSheetTitle}" created and selected.`);
        // alert(`New spreadsheet "${newSheetTitle}" created and selected as destination!`); // Replaced by status

    } catch (err) {
        displayError("❌ Failed to create new spreadsheet.", err);
        console.error("💾 CreateDest STEP ERR: Error creating spreadsheet:", err);
        showStatus(saveStatus, `Error creating sheet: ${err.message || err}`, true);
    } finally {
        hideLoading();
        createDestButton.disabled = false; // Re-enable create button
        saveButton.disabled = !destSheetId; // Re-enable save button only if a destination is now selected
    }
}

async function saveResults() {
  console.log("💾 SaveResults STEP 1: Starting saveResults function.");
  hideStatus(saveStatus);
  showLoading("⏳ Saving results...");
  saveButton.disabled = true; // Disable button during save

  if (!duckReady) { /* ... */ displayError("DuckDB not ready."); hideLoading(); saveButton.disabled = false; return; }
  if (!destSheetId) { /* ... */ displayError("Destination sheet not selected."); hideLoading(); saveButton.disabled = false; return; }
  const sql = sqlInput.value;
   if (!sql.trim()) { /* ... */ displayError("Cannot save results of an empty SQL query."); hideLoading(); saveButton.disabled = false; return; }
  console.log(`💾 SaveResults STEP 2: SQL for results: ${sql}`);

  let result;
  let rows;
  try {
      console.log("💾 SaveResults STEP 3: Attempting conn.query to get results...");
      result = await conn.query(sql);
      console.log("💾 SaveResults STEP 4: conn.query completed. Converting results...");
      rows = result.toArray();
      console.log(`💾 SaveResults STEP 4.1: Query returned ${rows.length} rows.`);

      if (rows.length === 0 && result.schema.fields.length === 0) {
          showStatus(saveStatus, "Query returned no data/columns. Nothing to save.", true);
          console.warn("💾 SaveResults STEP 4.2: Query returned no data/columns.");
          hideLoading();
          saveButton.disabled = false;
          return;
      }

  } catch (queryErr) {
      displayError("❌ Failed to execute query before saving.", queryErr);
      console.error("💾 SaveResults STEP 3.ERR: conn.query failed:", queryErr);
      showStatus(saveStatus, `SQL Error fetching results: ${queryErr.message || queryErr}`, true);
      hideLoading();
      saveButton.disabled = false;
      return;
  }

  // --- Format Data and Interact with Google Sheets ---
  try {
      console.log("💾 SaveResults STEP 5: Formatting data for Google Sheets API...");
      const headers = result.schema.fields.map(f => f.name);
      const values = [
          headers,
          ...rows.map(row => headers.map(header => {
              const val = row[header];
              // Handle BigInt specifically if DuckDB returns it for counts etc.
              if (typeof val === 'bigint') {
                  return val.toString();
              }
              return (val !== null && val !== undefined) ? String(val) : "";
          }))
      ];
      console.log(`💾 SaveResults STEP 5.1: Formatted ${values.length} rows (incl. header) for Sheets.`);

      const newSheetName = `Query Result ${new Date().toISOString().replace(/[:.]/g, '-')}`; // Make filename safe
      console.log(`💾 SaveResults STEP 6: Attempting to create new tab named "${newSheetName}" in sheet ID: ${destSheetId}`);
      showLoading(`⏳ Creating new tab "${newSheetName}"...`);

      const batchUpdateRequest = { requests: [ { addSheet: { properties: { title: newSheetName } } } ] };
      const batchUpdateResponse = await gapi.client.sheets.spreadsheets.batchUpdate({
          spreadsheetId: destSheetId,
          resource: batchUpdateRequest
      });
      console.log("💾 SaveResults STEP 7: Received response from batchUpdate (addSheet).");
      const createdSheetProps = batchUpdateResponse.result.replies[0].addSheet.properties;
      console.log(`💾 SaveResults STEP 7.1: New tab "${createdSheetProps.title}" created with ID ${createdSheetProps.sheetId}.`);

      const targetRange = `'${createdSheetProps.title}'!A1`;
      console.log(`💾 SaveResults STEP 8: Attempting to write ${values.length} rows to range: ${targetRange}`);
      showLoading(`⏳ Writing data to tab "${createdSheetProps.title}"...`);

      await gapi.client.sheets.spreadsheets.values.update({
          spreadsheetId: destSheetId,
          range: targetRange,
          valueInputOption: "USER_ENTERED",
          resource: { values }
      });
      console.log("💾 SaveResults STEP 9: Received response from values.update.");

      const sheetUrl = `https://docs.google.com/spreadsheets/d/${destSheetId}/edit#gid=${createdSheetProps.sheetId}`;
      console.log(`✅ Query results saved successfully to new tab! URL: ${sheetUrl}`);
      showStatus(saveStatus, `✅ Results saved to tab "${createdSheetProps.title}"!`);
      // alert(`Query results saved to new tab "${createdSheetProps.title}" in the destination spreadsheet!`); // Replaced by status

  } catch (saveErr) {
      displayError("❌ Failed to save query results to Google Sheet.", saveErr);
      console.error("💾 SaveResults STEP ERR: Error during Sheets update:", saveErr);
      showStatus(saveStatus, `Error saving results: ${saveErr.message || saveErr}`, true);
  } finally {
      hideLoading();
      saveButton.disabled = false; // Re-enable button
  }
}


// --- Initialization ---
window.addEventListener("DOMContentLoaded", async () => {
  console.log("🚀 DOMContentLoaded: Page loaded. Starting initialization...");

  // Cache UI elements
  console.log("🚀 DOMContentLoaded: Caching UI elements...");
  loginButton = document.getElementById("login-button");
  sourceSelect = document.getElementById("source-select");
  tabSelect = document.getElementById("tab-select");
  rangeInput = document.getElementById("range-input");
  loadButton = document.getElementById("load");
  sqlInput = document.getElementById("sql");
  runButton = document.getElementById("run");
  outputArea = document.getElementById("output");
  destSelect = document.getElementById("dest-select");
  createDestButton = document.getElementById("create-dest");
  saveButton = document.getElementById("save");
  loadingIndicator = document.getElementById("loading-indicator");
  errorMessage = document.getElementById("error-message");
  loadStatus = document.getElementById("load-status");
  queryStatus = document.getElementById("query-status");
  saveStatus = document.getElementById("save-status");
  columnNamesArea = document.getElementById("column-names-area");
  columnNamesList = document.getElementById("column-names-list");
  copyColumnsButton = document.getElementById("copy-columns-button");
  console.log("🚀 DOMContentLoaded: UI elements cached.");

  // Initial UI state
  console.log("🚀 DOMContentLoaded: Setting initial UI disabled state...");
  outputArea.textContent = "Initializing DuckDB...";
  columnNamesArea.style.display = 'none';
  copyColumnsButton.disabled = true;
  console.log("🚀 DOMContentLoaded: Initial UI state set.");

  // Initialize DuckDB first
  console.log("🚀 DOMContentLoaded: Calling setupDuckDB()...");
  await setupDuckDB();
  console.log("🚀 DOMContentLoaded: setupDuckDB() finished.");

  // Update UI based on DuckDB status (already handled inside setupDuckDB)

  // Setup Google Auth
  console.log("🚀 DOMContentLoaded: Calling initializeGoogleAuth()...");
  initializeGoogleAuth();
  console.log("🚀 DOMContentLoaded: initializeGoogleAuth() called.");

  // Attach button event listeners
  console.log("🚀 DOMContentLoaded: Attaching button event listeners...");
  loginButton.onclick = () => {
      console.log("🚀 Event: Login button clicked.");
      errorMessage.style.display = 'none'; // Clear errors on new action
      if (tokenClient) {
          console.log("   Requesting access token...");
          showLoading("🔑 Requesting Google Sign-In...");
          tokenClient.requestAccessToken({ prompt: '' }); // Try silent first
      } else {
          // This case should ideally not happen if init is successful, but good to keep
          displayError("Google Sign-In client (tokenClient) is not initialized properly.");
          console.error("   Login click error: tokenClient not initialized.");
      }
  };
  loadButton.onclick = () => { errorMessage.style.display = 'none'; loadSheet(); };
  runButton.onclick = () => { errorMessage.style.display = 'none'; runQuery(); };

  // --- FIX: Correctly assign functions to onclick ---
  createDestButton.onclick = () => { errorMessage.style.display = 'none'; createDestinationSheet(); };
  saveButton.onclick = () => { errorMessage.style.display = 'none'; saveResults(); };
  // --- END FIX ---

  copyColumnsButton.onclick = () => {
      const textToCopy = columnNamesList.textContent;
      if (navigator.clipboard && textToCopy) {
          navigator.clipboard.writeText(textToCopy).then(() => {
              const originalText = copyColumnsButton.textContent;
              copyColumnsButton.textContent = 'Copied!';
              copyColumnsButton.disabled = true;
              setTimeout(() => {
                  copyColumnsButton.textContent = originalText;
                  copyColumnsButton.disabled = false;
              }, 1500);
          }).catch(err => {
              console.error('Failed to copy column names:', err);
              alert('Failed to copy columns. Please copy manually.');
          });
      } else {
          alert('Clipboard API not available or no columns to copy.');
      }
  };

  console.log("🚀 DOMContentLoaded: Button event listeners attached.");
  console.log("🚀 DOMContentLoaded: Initialization complete.");
});
