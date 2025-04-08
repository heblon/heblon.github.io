import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm";

const API_KEY = "AIzaSyAjK2HdF0KnuKpdCns7sba-YVv3YgL29FY";
const CLIENT_ID = "561411244038-36ta31kbti2gmnugj5cvqvhb6ro15ors.apps.googleusercontent.com";

let conn;
let duckReady = false;
let accessToken = null;
let sourceSheetId = null;
let destSheetId = null;

// ------------------ DuckDB Setup ------------------
async function setupDuckDB() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const db = new duckdb.AsyncDuckDB();
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
  duckReady = true;
}
await setupDuckDB();

// ------------------ Google Auth ------------------
const tokenClient = google.accounts.oauth2.initTokenClient({
  client_id: CLIENT_ID,
  scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
  callback: async (response) => {
    if (response.error) {
      alert("Error retrieving access token");
      console.error(response);
      return;
    }
    accessToken = response.access_token;

    gapi.load("client", async () => {
      await gapi.client.init({
        discoveryDocs: [
          "https://sheets.googleapis.com/$discovery/rest?version=v4",
          "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
        ],
      });
      gapi.client.setToken({ access_token: accessToken });
      await loadSpreadsheets();
    });
  }
});

// ------------------ DOM Ready ------------------
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("login-button").onclick = () => {
    tokenClient.requestAccessToken();
  };
  document.getElementById("load").onclick = loadSheet;
  document.getElementById("run").onclick = runQuery;
  document.getElementById("create-dest").onclick = createDestinationSheet;
  document.getElementById("save").onclick = saveResults;
});

// ------------------ Load Spreadsheets ------------------
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

  sourceSelect.onchange = async (e) => {
    sourceSheetId = e.target.value;
    console.log(`📄 Selected Spreadsheet: https://docs.google.com/spreadsheets/d/${sourceSheetId}/edit`);
    await populateTabs(sourceSheetId);
  };

  // Auto-load first spreadsheet
  if (res.result.files.length > 0) {
    sourceSheetId = res.result.files[0].id;
    console.log(`📄 Selected Spreadsheet: https://docs.google.com/spreadsheets/d/${sourceSheetId}/edit`);
    await populateTabs(sourceSheetId);
  }
}

async function populateTabs(spreadsheetId) {
  const meta = await gapi.client.sheets.spreadsheets.get({ spreadsheetId });
  const tabSelect = document.getElementById("tab-select");
  tabSelect.innerHTML = "";

  meta.result.sheets.forEach(sheet => {
    const name = sheet.properties.title;
    tabSelect.appendChild(new Option(name, name));
  });
}

// ------------------ Load Sheet Data ------------------
async function loadSheet() {
  if (!duckReady) {
    alert("DuckDB is still loading. Please wait...");
    return;
  }

  const tab = document.getElementById("tab-select").value;
  const rangeInput = document.getElementById("range-input").value || "A1:Z1000";
  const fullRange = `${tab}!${rangeInput}`;

  const res = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: sourceSheetId,
    range: fullRange,
  });

  const values = res.result.values;
  if (!values || values.length < 2) {
    alert("No data found in selected range.");
    return;
  }

  const [headers, ...rows] = values;
  const objects = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? null;
    });
    return obj;
  });

  await conn.query("DROP TABLE IF EXISTS sheet_data;");
  await conn.query(`CREATE TABLE sheet_data (${headers.map(h => `"${h}" TEXT`).join(", ")});`);
  await conn.insert({ tableName: "sheet_data", rows: objects });

  alert("Data loaded into DuckDB.");
}

// ------------------ Query + Export ------------------
async function runQuery() {
  if (!duckReady) return alert("DuckDB not ready");
  const sql = document.getElementById("sql").value;
  const result = await conn.query(sql);
  document.getElementById("output").textContent = JSON.stringify(result.toArray(), null, 2);
}

async function createDestinationSheet() {
  const res = await gapi.client.sheets.spreadsheets.create({
    resource: {
      properties: { title: "DuckDB Export " + new Date().toLocaleString() }
    },
  });
  destSheetId = res.result.spreadsheetId;
  const opt = new Option(res.result.properties.title, destSheetId);
  document.getElementById("dest-select").appendChild(opt);
  document.getElementById("dest-select").value = destSheetId;
  alert("Created new spreadsheet.");
}

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

