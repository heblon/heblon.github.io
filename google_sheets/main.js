import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm";

// 🔐 REPLACE these with your real credentials
const API_KEY = "AIzaSyAjK2HdF0KnuKpdCns7sba-YVv3YgL29FY";
const CLIENT_ID = "561411244038-36ta31kbti2gmnugj5cvqvhb6ro15ors.apps.googleusercontent.com";

// Globals
let conn;
let accessToken = null;
let sourceSheetId = null;
let destSheetId = null;

// 1. Initialize DuckDB WASM
async function setupDuckDB() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const db = new duckdb.AsyncDuckDB();
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
}
await setupDuckDB();

// 2. Token client for Google Identity Services
const tokenClient = google.accounts.oauth2.initTokenClient({
  client_id: CLIENT_ID,
  scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
  callback: async (response) => {
    if (response.error) {
      console.error("Token error:", response);
      alert("Failed to get access token.");
      return;
    }

    accessToken = response.access_token;

    // Now load gapi and init Sheets + Drive API
    gapi.load("client", async () => {
      await gapi.client.init({
        apiKey: API_KEY,
        discoveryDocs: [
          "https://sheets.googleapis.com/$discovery/rest?version=v4",
          "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
        ],
      });

      gapi.client.setToken({ access_token: accessToken });
      await loadSpreadsheets();
    });
  },
});

// 3. Set up UI events when DOM is ready
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("load").onclick = loadSheet;
  document.getElementById("run").onclick = runQuery;
  document.getElementById("create-dest").onclick = createDestinationSheet;
  document.getElementById("save").onclick = saveResults;

  // Start login by requesting access token
  document.getElementById("login-button").addEventListener("click", () => {
        tokenClient.requestAccessToken();
    });

});

// 4. Load available spreadsheets from Drive
async function loadSpreadsheets() {
  const res = await gapi.client.drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet'",
    fields: "files(id, name)",
  });

  const sourceSelect = document.getElementById("source-select");
  sourceSelect.innerHTML = "";

  res.result.files.forEach(f => {
    const option = new Option(f.name, f.id);
    sourceSelect.appendChild(option);
  });

  sourceSelect.onchange = async e => {
    sourceSheetId = e.target.value;
    await populateTabs(sourceSheetId);
  };

  if (res.result.files.length > 0) {
    sourceSheetId = res.result.files[0].id;
    await populateTabs(sourceSheetId);
  }
}



async function populateTabs(spreadsheetId) {
  const meta = await gapi.client.sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId,
  });

  const tabSelect = document.getElementById("tab-select");
  tabSelect.innerHTML = "";

  meta.result.sheets.forEach(sheet => {
    const name = sheet.properties.title;
    const option = new Option(name, name);
    tabSelect.appendChild(option);
  });
}



// 5. Load selected Google Sheet into DuckDB
async function loadSheet() {
  const tabName = document.getElementById("tab-select").value;
  const userRange = document.getElementById("range-input").value || "A1:Z100";

  const fullRange = `${tabName}!${userRange}`;

  const res = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: sourceSheetId,
    range: fullRange,
  });

  const values = res.result.values;
  const [headers, ...rows] = values;
  await conn.insertCSVFromArrays("sheet_data", [headers, ...rows]);
  alert("Data loaded into DuckDB.");
}

// 6. Run SQL query
async function runQuery() {
  const sql = document.getElementById("sql").value;
  const result = await conn.query(sql);
  document.getElementById("output").textContent = JSON.stringify(result.toArray(), null, 2);
}

// 7. Create a new Google Sheet
async function createDestinationSheet() {
  const res = await gapi.client.sheets.spreadsheets.create({
    resource: {
      properties: {
        title: "DuckDB Export " + new Date().toLocaleString(),
      },
    },
  });

  destSheetId = res.result.spreadsheetId;
  const opt = new Option(res.result.properties.title, destSheetId);
  document.getElementById("dest-select").appendChild(opt);
  document.getElementById("dest-select").value = destSheetId;
  alert("Created new spreadsheet.");
}

// 8. Save DuckDB query results to selected Google Sheet
async function saveResults() {
  const sql = document.getElementById("sql").value;
  const result = await conn.query(sql);
  const rows = result.toArray();
  const values = [
    result.schema.fields.map(f => f.name),
    ...rows.map(row => Object.values(row)),
  ];

  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId: destSheetId,
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    resource: { values },
  });

  alert("Query result saved to spreadsheet.");
}

