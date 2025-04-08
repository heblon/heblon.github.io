import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm";

const API_KEY = "AIzaSyAjK2HdF0KnuKpdCns7sba-YVv3YgL29FY";
const CLIENT_ID = "561411244038-36ta31kbti2gmnugj5cvqvhb6ro15ors.apps.googleusercontent.com";

let conn;
let accessToken = null;
let sourceSheetId = null;
let destSheetId = null;

async function setupDuckDB() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const db = new duckdb.AsyncDuckDB();
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
}
await setupDuckDB();

window.handleCredentialResponse = async (response) => {
  accessToken = response.credential;

  await gapi.load("client", async () => {
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
};

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("load").onclick = loadSheet;
  document.getElementById("run").onclick = runQuery;
  document.getElementById("create-dest").onclick = createDestinationSheet;
  document.getElementById("save").onclick = saveResults;
});

async function loadSpreadsheets() {
  const res = await gapi.client.drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet'",
    fields: "files(id, name)",
  });

  const sourceSelect = document.getElementById("source-select");
  const destSelect = document.getElementById("dest-select");
  sourceSelect.innerHTML = "";
  destSelect.innerHTML = "";

  res.result.files.forEach(f => {
    const opt1 = new Option(f.name, f.id);
    const opt2 = new Option(f.name, f.id);
    sourceSelect.appendChild(opt1);
    destSelect.appendChild(opt2);
  });

  sourceSelect.onchange = e => (sourceSheetId = e.target.value);
  destSelect.onchange = e => (destSheetId = e.target.value);

  if (res.result.files.length > 0) {
    sourceSheetId = res.result.files[0].id;
    destSheetId = res.result.files[0].id;
  }
}

async function loadSheet() {
  const res = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: sourceSheetId,
    range: "Sheet1!A1:Z1000",
  });
  const values = res.result.values;
  const [headers, ...rows] = values;
  await conn.insertCSVFromArrays("sheet_data", [headers, ...rows]);
  alert("Data loaded into DuckDB.");
}

async function runQuery() {
  const sql = document.getElementById("sql").value;
  const result = await conn.query(sql);
  document.getElementById("output").textContent = JSON.stringify(result.toArray(), null, 2);
}

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
  alert("Created new spreadsheet: " + res.result.properties.title);
}

async function saveResults() {
  const sql = document.getElementById("sql").value;
  const result = await conn.query(sql);
  const rows = result.toArray();
  const values = [result.schema.fields.map(f => f.name), ...rows.map(Object.values)];

  await gapi.client.sheets
::contentReference[oaicite:11]{index=11}
 

