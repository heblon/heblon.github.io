// Add Apache Arrow import at the top
// --- CHANGE 1: Update duckdb-wasm version ---
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm"; // Updated to 1.29.0
import * as arrow from "https://cdn.jsdelivr.net/npm/apache-arrow@latest/+esm";

// 🔐 Replace with your real Client ID
const CLIENT_ID = "561411244038-36ta31kbti2gmnugj5cvqvhb6ro15ors.apps.googleusercontent.com";

let conn = null; // Initialize explicitly to null
let duckDBInstance = null; // Keep track of the main DB instance
let duckReady = false;
let accessToken = null;
let sourceSheetId = null;
let destSheetId = null;

// --- UI Elements (cache for performance) ---
let loginButton, sourceSelect, tabSelect, rangeInput, loadButton, sqlInput, runButton, outputArea, destSelect, createDestButton, saveButton;

// --- Helper Function for Displaying Errors ---
function displayError(message, error = null) {
  const fullMessage = message + (error ? `\nDetails: ${error.message || error}` : '');
  console.error("❌ ERROR:", message, error); // Log error with details
  alert(fullMessage);
  // Optionally update a dedicated error display area on the page
  // document.getElementById("error-display").textContent = message;
}

// --- DuckDB Initialization ---
// No changes needed in setupDuckDB - the Blob URL method works.
async function setupDuckDB() {
  console.log("🦆 STEP 1: Starting setupDuckDB (Blob URL Worker Creation)...");
  // Reset state variables
  duckReady = false;
  conn = null;
  duckDBInstance = null;

  let workerUrl = null; // Keep track of the blob URL

  try {
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    console.log("🦆 STEP 2: Logger created.");

    // --- Explicitly get the MVP bundle configuration ---
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = bundles.mvp;
    if (!bundle || !bundle.mainModule || !bundle.mainWorker) {
        console.error("🦆 STEP 3: FAILED to find MVP bundle configuration in:", bundles);
        throw new Error("Could not find MVP bundle configuration.");
    }
    console.log(`🦆 STEP 3: Using MVP bundle - Module: ${bundle.mainModule}, Worker Script Source: ${bundle.mainWorker}`);

    // --- Create Worker from Blob URL ---
    console.log("🦆 STEP 4: Creating Blob URL for worker script:", bundle.mainWorker);
    // Use importScripts within the Blob to load the actual worker code
    const workerScriptContent = `try { importScripts("${bundle.mainWorker}"); } catch (e) { console.error("Error importing worker script:", e); throw e; }`;
    const blob = new Blob([workerScriptContent], { type: 'text/javascript' });
    workerUrl = URL.createObjectURL(blob);
    console.log("🦆 STEP 4.1: Blob URL created:", workerUrl);

    console.log("🦆 STEP 4.2: Creating Worker instance from Blob URL...");
    const worker = new Worker(workerUrl);
    console.log("🦆 STEP 4.3: Worker instance created:", worker);

    // --- Instantiate AsyncDuckDB with logger AND the created worker ---
    duckDBInstance = new duckdb.AsyncDuckDB(logger, worker);
    console.log("🦆 STEP 5: AsyncDuckDB instance created with worker:", duckDBInstance);

    // --- Instantiate using ONLY the main module path ---
    console.log("🦆 STEP 6: Calling db.instantiate with ONLY mainModule:", bundle.mainModule);
    await duckDBInstance.instantiate(bundle.mainModule);
    console.log("🦆 STEP 7: db.instantiate completed.");

    // --- Clean up the Blob URL ---
    console.log("🦆 STEP 7.1: Revoking Blob URL:", workerUrl);
    URL.revokeObjectURL(workerUrl);
    workerUrl = null; // Clear the variable

    // --- Optional: Version check ---
    try {
        console.log("🦆 STEP 7.2: Attempting db.getVersion()...");
        const version = await duckDBInstance.getVersion();
        console.log(`🦆 STEP 7.3: DuckDB WASM Version Check SUCCESS: ${version}`); // Will show updated version
    } catch (versionError) {
        console.warn("🦆 STEP 7.3: Warning during initial version check:", versionError);
    }

    // --- Now connect to the database ---
    console.log("🦆 STEP 8: Calling db.connect...");
    conn = await duckDBInstance.connect();
    console.log("🦆 STEP 9: db.connect completed. Connection object:", conn);

    // --- ADJUSTED Verify connection ---
    if (conn && conn._conn !== undefined) {
        console.log("🦆 STEP 10: Connection object obtained and internal handle (_conn) is defined. Assuming valid for now.");
        console.log("   Detailed conn object:", conn);
        if (conn._bindings) {
            console.log("   Detailed conn._bindings:", conn._bindings);
            console.log("   typeof conn._bindings.query:", typeof conn._bindings.query);
            console.log("   typeof conn._bindings.insertArrowFromIPCStream:", typeof conn._bindings.insertArrowFromIPCStream);
        }
        duckReady = true; // Set ready state
        console.log("✅ DuckDB is ready (using Blob URL created MVP Web Worker)!");
    } else {
         console.error("🦆 STEP 10: FAILED - Connection object is null or internal handle (_conn) is undefined:", conn);
         throw new Error("Failed to obtain a valid connection object or internal handle.");
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
  }
}




// --- Google Authentication ---
let tokenClient; // Declare globally

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

        // Load GAPI client library and initialize APIs
        console.log("🔑 GAuth STEP 4: Loading GAPI client library...");
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

            // Load spreadsheets only after successful GAPI init
            await loadSpreadsheets();

            // Enable UI elements that require authentication
            console.log("🔑 GAuth STEP 7: Enabling UI elements.");
            sourceSelect.disabled = false;
            tabSelect.disabled = false; // Will be enabled by populateTabs if successful
            rangeInput.disabled = false;
            loadButton.disabled = false;
            destSelect.disabled = false;
            createDestButton.disabled = false;
            // Save button enabled state depends on destSheetId, check later
            loginButton.textContent = "🔓 Signed In";
            loginButton.disabled = true;

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
  sourceSelect.innerHTML = "<option value=''>Loading...</option>"; // Indicate loading
  destSelect.innerHTML = "<option value=''>Loading...</option>";
  sourceSelect.disabled = true;
  destSelect.disabled = true;
  try {
    const res = await gapi.client.drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      fields: "files(id, name)"
    });
    console.log("📄 Drive STEP 2: Received spreadsheet list response.");

    sourceSelect.innerHTML = "<option value=''>-- Select Source Sheet --</option>"; // Add placeholder
    destSelect.innerHTML = "<option value=''>-- Select Destination Sheet --</option>"; // Add placeholder

    if (!res.result.files || res.result.files.length === 0) {
        console.log("📄 Drive STEP 3: No spreadsheets found.");
        sourceSelect.disabled = false; // Re-enable even if empty
        destSelect.disabled = false;
        return;
    }

    console.log(`📄 Drive STEP 3: Found ${res.result.files.length} spreadsheets. Populating dropdowns...`);
    res.result.files.forEach(file => {
      sourceSelect.appendChild(new Option(file.name, file.id));
      destSelect.appendChild(new Option(file.name, file.id)); // Populate destination too
    });
    console.log(`📄 Drive STEP 4: Dropdowns populated.`);
    sourceSelect.disabled = false;
    destSelect.disabled = false;

    // Add change listener for source selection
    sourceSelect.onchange = async e => {
      sourceSheetId = e.target.value;
      console.log(`📄 Drive Event: Source selection changed to ID: ${sourceSheetId}`);
      if (sourceSheetId) {
        console.log(`   Source URL: https://docs.google.com/spreadsheets/d/${sourceSheetId}/edit`);
        await populateTabs(sourceSheetId); // Load tabs for the selected sheet
      } else {
        tabSelect.innerHTML = ""; // Clear tabs if no sheet is selected
        tabSelect.disabled = true;
        console.log("   Source selection cleared, disabling tab select.");
      }
    };

    // Add change listener for destination selection
    destSelect.onchange = e => {
        destSheetId = e.target.value;
        console.log(`🎯 Drive Event: Destination selection changed to ID: ${destSheetId}`);
        if(destSheetId) {
            console.log(`   Destination URL: https://docs.google.com/spreadsheets/d/${destSheetId}/edit`);
            saveButton.disabled = false; // Enable save button only when a destination is selected
        } else {
            saveButton.disabled = true; // Disable save if no destination
        }
    };

  } catch (err) {
    displayError("❌ Failed to load spreadsheets from Google Drive.", err);
    console.error("📄 Drive STEP ERR: Error loading spreadsheets:", err);
    sourceSelect.innerHTML = "<option value=''>Error loading</option>"; // Show error state
    destSelect.innerHTML = "<option value=''>Error loading</option>";
    sourceSelect.disabled = false; // Re-enable even on error
    destSelect.disabled = false;
  }
}

async function populateTabs(spreadsheetId) {
  console.log(`📄 Tabs STEP 1: Loading tabs for sheet ID: ${spreadsheetId}`);
  tabSelect.innerHTML = "<option value=''>Loading tabs...</option>"; // Indicate loading
  tabSelect.disabled = true;
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
        // Keep tabSelect disabled as there's nothing to choose
        return;
    }

    console.log(`📄 Tabs STEP 3: Found ${res.result.sheets.length} tabs. Populating dropdown...`);
    res.result.sheets.forEach(sheet => {
      tabSelect.appendChild(new Option(sheet.properties.title, sheet.properties.title));
    });
    tabSelect.disabled = false; // Enable dropdown now that it has options
    console.log(`📄 Tabs STEP 4: Tabs dropdown populated and enabled.`);
  } catch (err) {
    displayError(`❌ Failed to load tabs for spreadsheet ID: ${spreadsheetId}.`, err);
    console.error(`📄 Tabs STEP ERR: Error loading tabs for sheet ID ${spreadsheetId}:`, err);
    tabSelect.innerHTML = "<option value=''>Error loading tabs</option>";
    tabSelect.disabled = true; // Keep disabled on error
  }
}

// --- Core Data Operations ---
async function loadSheet() {
  // +++ ADDED: Log entry and variable state +++
  console.log("🚀 LoadSheet ENTRY: Function called.");
  console.log(`   Current state: duckReady=${duckReady}, sourceSheetId=${sourceSheetId}, tabSelect.value=${tabSelect?.value}`);
  // +++ END ADDED +++

  outputArea.textContent = "Starting data load...";

  // --- Initial Checks ---
  if (!duckReady) {
    displayError("DuckDB is not ready. Please wait or refresh.");
    console.error("🚀 LoadSheet STEP 1.1: DuckDB not ready check failed.");
    outputArea.textContent = "Error: DuckDB not ready.";
    return;
  }
  console.log("🚀 LoadSheet STEP 1.2: DuckDB ready check passed.");

  if (!sourceSheetId) {
    displayError("Please select a source spreadsheet first.");
    console.error("🚀 LoadSheet STEP 1.3: No source sheet selected.");
    outputArea.textContent = "Error: Select source sheet.";
    return;
  }
  console.log("🚀 LoadSheet STEP 1.4: Source sheet selected:", sourceSheetId);

  const tab = tabSelect.value;
  const range = rangeInput.value || "A1:Z1000"; // Default range if empty

  if (!tab) {
      displayError("Please select a sheet tab first.");
      console.error("🚀 LoadSheet STEP 1.5: No tab selected.");
      outputArea.textContent = "Error: Select sheet tab.";
      return;
  }
  console.log(`🚀 LoadSheet STEP 1.6: Tab selected: '${tab}', Range: '${range}'`);

  const fullRange = `'${tab}'!${range}`; // Quote tab name for safety

  // --- Combined GAPI Fetch and DuckDB Processing Block ---
  try {
      // --- Fetch Data from Google Sheets ---
      console.log(`🚀 LoadSheet STEP 2: Requesting data from Google Sheets range: ${fullRange}`);
      outputArea.textContent = `Loading data from ${fullRange}...`;

      const res = await gapi.client.sheets.spreadsheets.values.get({
          spreadsheetId: sourceSheetId,
          range: fullRange,
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER'
      });
      console.log("🚀 LoadSheet STEP 3: Received data from Google Sheets.");
      const values = res.result.values; // Assign values HERE

      // --- Check if data was returned ---
      if (!values || values.length < 1) {
          // ... (no change needed in this part) ...
          displayError("No data found in the selected range or sheet.");
          console.warn("🚀 LoadSheet STEP 3.1: No data returned from Sheets API.");
          outputArea.textContent = "No data found in range.";
          try {
              console.log("🚀 LoadSheet STEP 3.2: Attempting to drop table (no data found case).");
              await conn.query("DROP TABLE IF EXISTS sheet_data;");
              console.log("🚀 LoadSheet STEP 3.3: Table dropped successfully (no data found case).");
          } catch(e){
              console.error("🚀 LoadSheet STEP 3.4: Error dropping table (no data found case):", e);
          }
          return; // Stop processing if no data
      }
      console.log(`🚀 LoadSheet STEP 3.5: Received ${values.length} rows from Sheets.`);

      // --- Process Data for DuckDB ---
      console.log("🚀 LoadSheet STEP 4: Processing fetched data for DuckDB...");
      const headers = values[0].map((h, idx) => String(h || `col_${idx}_${Date.now()}`));
      const dataRows = values.length > 1 ? values.slice(1) : [];
      console.log(`🚀 LoadSheet STEP 4.1: Headers identified (${headers.length}):`, headers);

      // NOTE: We still process objects, but won't use Arrow Table for insertion in this test
      const objects = dataRows.map((row, rowIndex) => {
          const obj = {};
          headers.forEach((h, i) => {
              obj[h] = (row && row[i] !== undefined && row[i] !== null) ? row[i] : null;
          });
          return obj;
      });
      console.log(`🚀 LoadSheet STEP 4.2: Converted ${objects.length} data rows to objects.`);

      // --- DuckDB Operations ---
      console.log("🚀 LoadSheet STEP 5: Starting DuckDB table operations...");
      console.log("   Connection object state before operations:", conn);

      const dropSQL = "DROP TABLE IF EXISTS sheet_data;";
      console.log("🚀 LoadSheet STEP 5.1: Attempting to execute:", dropSQL);
      await conn.query(dropSQL);
      console.log("🚀 LoadSheet STEP 5.2: Successfully executed:", dropSQL);

      // Use quoted headers for CREATE TABLE
      const quotedHeaders = headers.map(h => `"${h.replace(/"/g, '""')}"`);
      const createTableSQL = `CREATE TABLE sheet_data (${quotedHeaders.map(h => `${h} VARCHAR`).join(", ")});`;
      console.log("🚀 LoadSheet STEP 5.3: Attempting to execute:", createTableSQL);
      await conn.query(createTableSQL);
      console.log("🚀 LoadSheet STEP 5.4: Successfully executed:", createTableSQL);

      // --- FIX: Use INSERT INTO ... VALUES for testing ---
      if (objects.length > 0) {
          const numRowsToInsert = Math.max(5, objects.length); // Insert only first 5 rows for test
          console.log(`🚀 LoadSheet STEP 5.5: Attempting to insert first ${numRowsToInsert} rows using conn.query(INSERT INTO)...`);

          for (let i = 0; i < numRowsToInsert; i++) {
              const rowObject = objects[i];
              // Construct the VALUES part, ensuring proper quoting/escaping for VARCHAR
              const valuesString = headers.map(h => {
                  const value = rowObject[h];
                  if (value === null || value === undefined) {
                      return "NULL";
                  }
                  // Basic escaping: replace single quotes with two single quotes
                  const escapedValue = String(value).replace(/'/g, "''");
                  return `'${escapedValue}'`; // Enclose in single quotes for VARCHAR
              }).join(", ");

              const insertSQL = `INSERT INTO sheet_data (${quotedHeaders.join(", ")}) VALUES (${valuesString});`;
              // Log only the first insert statement for brevity
              if (i === 0) {
                 console.log(`   Executing SQL (example): ${insertSQL.substring(0, 200)}...`);
              }
              try {
                  await conn.query(insertSQL);
              } catch (insertErr) {
                  console.error(`   ERROR inserting row ${i}:`, insertErr);
                  console.error(`   Failed SQL: ${insertSQL}`);
                  // Optionally re-throw or break if one insert fails
                  throw insertErr; // Stop if any insert fails
              }
          }
          console.log(`🚀 LoadSheet STEP 5.7: Successfully executed ${numRowsToInsert} INSERT statements.`);

          // --- Immediate Row Count Check (Still useful) ---
          try {
              console.log("🚀 LoadSheet STEP 5.8: Attempting immediate row count check...");
              const countResult = await conn.query("SELECT COUNT(*) as count FROM sheet_data;");
              const countArray = countResult.toArray();
              if (countArray && countArray.length > 0) {
                  console.log(`🚀 LoadSheet STEP 5.9: Immediate count check result: ${countArray[0].count} rows.`);
                  if (countArray[0].count !== numRowsToInsert) { // Compare with numRowsToInsert
                      console.warn(`   WARN: Immediate count (${countArray[0].count}) does not match inserted rows (${numRowsToInsert})!`);
                  }
              } else {
                  console.warn("🚀 LoadSheet STEP 5.9: Immediate count check failed to return results.");
              }
          } catch (countErr) {
              console.error("🚀 LoadSheet STEP 5.ERR (Count Check): Error during immediate row count:", countErr);
          }
          // --- END CHECK ---

      } else {
          console.log("🚀 LoadSheet STEP 5.5-SKIP: No data rows to insert.");
      }
      // --- END FIX ---

      // --- Success ---
      console.log("🚀 LoadSheet STEP 6: DuckDB operations completed successfully.");
      // Adjust success message as we only inserted a few rows for testing
      outputArea.textContent = `TEST: Data loaded successfully!\n${objects.length} rows processed, ${Math.max(5, objects.length)} rows inserted via SQL.\nTable 'sheet_data' created/updated.\nReady to run queries.`;
      alert("TEST: Data loaded into DuckDB!");

  } catch (err) { // Catch errors from EITHER GAPI or DuckDB operations
      // ... (error handling remains the same) ...
      if (err.result && err.result.error) { // Likely a GAPI error
          displayError(`❌ Failed to get data from sheet '${tab}'. Check range and permissions.`, err.result.error);
          console.error("🚀 LoadSheet GAPI ERR:", err.result.error);
          outputArea.textContent = `Error fetching data: ${err.result.error.message || err}`;
      } else { // Likely a DuckDB or processing error
          displayError(`❌ Error during sheet loading/processing.`, err);
          console.error("🚀 LoadSheet Processing/DB ERR:", err);
          console.error("   Connection object state at time of error:", conn);
          outputArea.textContent = `Processing/DB Error: ${err.message || err}`;
      }
  }
}




async function runQuery() {
  console.log("🚀 RunQuery STEP 1: Starting runQuery function.");
  outputArea.textContent = "Starting query execution...";

  if (!duckReady) {
    displayError("DuckDB is not ready.");
    console.error("🚀 RunQuery STEP 1.1: DuckDB not ready check failed.");
    outputArea.textContent = "Error: DuckDB not ready.";
    return;
  }
  console.log("🚀 RunQuery STEP 1.2: DuckDB ready check passed.");

  const sql = sqlInput.value;
  if (!sql.trim()) {
      displayError("SQL query cannot be empty.");
      console.warn("🚀 RunQuery STEP 1.3: SQL query is empty.");
      outputArea.textContent = "Error: SQL query empty.";
      return;
  }
  console.log(`🚀 RunQuery STEP 2: SQL to execute: ${sql}`);
  console.log("   Connection object state before query:", conn); // Log connection state

  outputArea.textContent = "Running query...";

  try {
    console.log("🚀 RunQuery STEP 3: Attempting conn.query...");
    const result = await conn.query(sql);
    console.log("🚀 RunQuery STEP 4: conn.query completed. Processing results...");
    const resultArray = result.toArray(); // Convert Apache Arrow table to JS array
    console.log(`🚀 RunQuery STEP 5: Query returned ${resultArray.length} rows.`);
    outputArea.textContent = JSON.stringify(resultArray, null, 2); // Pretty print JSON
    console.log(`✅ Query executed successfully.`);
  } catch (err) {
    displayError("❌ SQL Query Error.", err);
    console.error("🚀 RunQuery STEP 3.ERR: conn.query failed:", err);
    console.error("   Connection object state at time of error:", conn); // Log connection state during error
    // Display SQL error directly in the output area
    outputArea.textContent = `SQL Error:\n${err.message || err}`;
  }
}

async function createDestinationSheet() {
    console.log("💾 CreateDest STEP 1: Starting createDestinationSheet...");
    outputArea.textContent = "Creating new spreadsheet...";
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

        // Add to both source and destination dropdowns
        console.log("💾 CreateDest STEP 4: Adding new sheet to dropdowns...");
        const optSource = new Option(newSheetTitle, destSheetId);
        const optDest = new Option(newSheetTitle, destSheetId);
        sourceSelect.appendChild(optSource);
        destSelect.appendChild(optDest);

        // Select the new sheet in the destination dropdown
        destSelect.value = destSheetId;
        console.log("💾 CreateDest STEP 5: New sheet selected in destination dropdown.");
        saveButton.disabled = false; // Enable save button

        outputArea.textContent = `New sheet "${newSheetTitle}" created.`;
        alert(`New spreadsheet "${newSheetTitle}" created and selected as destination!`);

    } catch (err) {
        displayError("❌ Failed to create new spreadsheet.", err);
        console.error("💾 CreateDest STEP ERR: Error creating spreadsheet:", err);
        outputArea.textContent = `Error creating sheet: ${err.message || err}`;
    }
}

async function saveResults() {
  console.log("💾 SaveResults STEP 1: Starting saveResults function.");
  outputArea.textContent = "Starting save operation...";

  if (!duckReady) {
    displayError("DuckDB is not ready.");
    console.error("💾 SaveResults STEP 1.1: DuckDB not ready check failed.");
    outputArea.textContent = "Error: DuckDB not ready.";
    return;
  }
  console.log("💾 SaveResults STEP 1.2: DuckDB ready check passed.");

  if (!destSheetId) {
    displayError("Please select or create a destination spreadsheet first.");
    console.error("💾 SaveResults STEP 1.3: No destination sheet selected.");
    outputArea.textContent = "Error: Select destination sheet.";
    return;
  }
  console.log("💾 SaveResults STEP 1.4: Destination sheet selected:", destSheetId);

  const sql = sqlInput.value;
   if (!sql.trim()) {
      displayError("Cannot save results of an empty SQL query.");
      console.warn("💾 SaveResults STEP 1.5: SQL query is empty.");
      outputArea.textContent = "Error: SQL query empty.";
      return;
  }
  console.log(`💾 SaveResults STEP 2: SQL for results: ${sql}`);
  console.log("   Connection object state before query:", conn); // Log connection state

  outputArea.textContent = "Fetching query results to save...";

  let result;
  let rows;
  try {
      // 1. Re-run the query to get fresh results
      console.log("💾 SaveResults STEP 3: Attempting conn.query to get results...");
      result = await conn.query(sql);
      console.log("💾 SaveResults STEP 4: conn.query completed. Converting results...");
      rows = result.toArray(); // Get results as array of objects
      console.log(`💾 SaveResults STEP 4.1: Query returned ${rows.length} rows.`);

      if (rows.length === 0 && result.schema.fields.length === 0) {
          displayError("Query returned no data and no columns. Nothing to save.");
          console.warn("💾 SaveResults STEP 4.2: Query returned no data/columns.");
          outputArea.textContent = "Query returned no data/columns.";
          return;
      }

  } catch (queryErr) {
      displayError("❌ Failed to execute query before saving.", queryErr);
      console.error("💾 SaveResults STEP 3.ERR: conn.query failed:", queryErr);
      console.error("   Connection object state at time of error:", conn); // Log connection state during error
      outputArea.textContent = `SQL Error fetching results: ${queryErr.message || queryErr}`;
      return; // Stop if we can't get the results
  }

  // --- Format Data and Interact with Google Sheets ---
  try {
      console.log("💾 SaveResults STEP 5: Formatting data for Google Sheets API...");
      // 2. Format data for Sheets API (array of arrays)
      const headers = result.schema.fields.map(f => f.name);
      const values = [
          headers, // First row is headers
          ...rows.map(row => headers.map(header => {
              // Handle potential complex objects (like dates) if necessary, otherwise default toString
              const val = row[header];
              return (val !== null && val !== undefined) ? String(val) : ""; // Ensure string representation or empty string
          }))
      ];
      console.log(`💾 SaveResults STEP 5.1: Formatted ${values.length} rows (incl. header) for Sheets.`);

      // 3. Create a new sheet (tab) within the destination spreadsheet
      const newSheetName = `Query Result ${new Date().toISOString()}`;
      console.log(`💾 SaveResults STEP 6: Attempting to create new tab named "${newSheetName}" in sheet ID: ${destSheetId}`);
      outputArea.textContent = `Creating new tab "${newSheetName}"...`;

      const batchUpdateRequest = {
          requests: [ { addSheet: { properties: { title: newSheetName } } } ]
      };

      const batchUpdateResponse = await gapi.client.sheets.spreadsheets.batchUpdate({
          spreadsheetId: destSheetId,
          resource: batchUpdateRequest
      });
      console.log("💾 SaveResults STEP 7: Received response from batchUpdate (addSheet).");

      const createdSheetProps = batchUpdateResponse.result.replies[0].addSheet.properties;
      console.log(`💾 SaveResults STEP 7.1: New tab "${createdSheetProps.title}" created with ID ${createdSheetProps.sheetId}.`);

      // 4. Write data to the *newly created sheet* starting at A1
      const targetRange = `'${createdSheetProps.title}'!A1`; // Use the actual title of the created sheet
      console.log(`💾 SaveResults STEP 8: Attempting to write ${values.length} rows to range: ${targetRange}`);
      outputArea.textContent = `Writing data to tab "${createdSheetProps.title}"...`;

      await gapi.client.sheets.spreadsheets.values.update({
          spreadsheetId: destSheetId,
          range: targetRange,
          valueInputOption: "USER_ENTERED", // More flexible than RAW
          resource: { values }
      });
      console.log("💾 SaveResults STEP 9: Received response from values.update.");

      // --- Success ---
      const sheetUrl = `https://docs.google.com/spreadsheets/d/${destSheetId}/edit#gid=${createdSheetProps.sheetId}`;
      console.log(`✅ Query results saved successfully to new tab! URL: ${sheetUrl}`);
      outputArea.textContent = `Results saved successfully to tab "${createdSheetProps.title}"!\n${values.length -1} data rows written.`;
      alert(`Query results saved to new tab "${createdSheetProps.title}" in the destination spreadsheet!`);

  } catch (saveErr) {
      // Catch errors from batchUpdate or values.update
      displayError("❌ Failed to save query results to Google Sheet.", saveErr);
      console.error("💾 SaveResults STEP ERR: Error during Sheets update:", saveErr);
      outputArea.textContent = `Error saving results: ${saveErr.message || saveErr}`;
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
  console.log("🚀 DOMContentLoaded: UI elements cached.");

  // Initial UI state (disabled until authenticated/ready)
  console.log("🚀 DOMContentLoaded: Setting initial UI disabled state...");
  sourceSelect.disabled = true;
  tabSelect.disabled = true;
  rangeInput.disabled = true;
  loadButton.disabled = true;
  runButton.disabled = true; // Disable run until DuckDB is ready
  destSelect.disabled = true;
  createDestButton.disabled = true;
  saveButton.disabled = true; // Disable save until destination selected
  outputArea.textContent = "Initializing DuckDB...";
  console.log("🚀 DOMContentLoaded: Initial UI state set.");

  // Initialize DuckDB first (can happen before sign-in)
  console.log("🚀 DOMContentLoaded: Calling setupDuckDB()...");
  await setupDuckDB(); // Wait for DuckDB setup to complete (or fail)
  console.log("🚀 DOMContentLoaded: setupDuckDB() finished.");

  // Update UI based on DuckDB status
  if (duckReady) {
      console.log("🚀 DOMContentLoaded: DuckDB is ready. Enabling Run button.");
      runButton.disabled = false; // Enable run now
      outputArea.textContent = "DuckDB ready. Please sign in to load Google Sheets data.";
  } else {
      console.error("🚀 DOMContentLoaded: DuckDB initialization failed. Keeping Run button disabled.");
      outputArea.textContent = "DuckDB initialization failed. Please check console and refresh.";
      // Keep most buttons disabled if DuckDB fails
  }

  // Setup Google Auth and Button Listeners
  console.log("🚀 DOMContentLoaded: Calling initializeGoogleAuth()...");
  initializeGoogleAuth(); // Initialize the token client structure (doesn't block)
  console.log("🚀 DOMContentLoaded: initializeGoogleAuth() called.");

  console.log("🚀 DOMContentLoaded: Attaching button event listeners...");
  loginButton.onclick = () => {
      console.log("🚀 Event: Login button clicked.");
      if (tokenClient) {
          console.log("   Requesting access token...");
          // Prompt for consent ONLY if needed, otherwise just get token silently if possible
          tokenClient.requestAccessToken({prompt: ''}); // Try silent first
      } else {
          displayError("Google Sign-In is not initialized properly.");
          console.error("   Login click error: tokenClient not initialized.");
      }
  };
  loadButton.onclick = loadSheet;
  runButton.onclick = runQuery;
  createDestButton.onclick = createDestinationSheet;
  saveButton.onclick = saveResults;
  console.log("🚀 DOMContentLoaded: Button event listeners attached.");
  console.log("🚀 DOMContentLoaded: Initialization complete.");
});
