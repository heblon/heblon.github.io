let pyodide;

const API_KEY = "AIzaSyAjK2HdF0KnuKpdCns7sba-YVv3YgL29FY";
const CLIENT_ID = "561411244038-36ta31kbti2gmnugj5cvqvhb6ro15ors.apps.googleusercontent.com";

async function startPyodide() {
  pyodide = await loadPyodide();
  await pyodide.loadPackage('micropip');
  await pyodide.runPythonAsync(`
    import micropip
    await micropip.install("duckdb")
  `);
  await pyodide.runPythonAsync(await (await fetch("logic.py")).text());
}

document.getElementById("auth").onclick = () => {
  gapi.load("client:auth2", async () => {
    await gapi.client.init({
      apiKey: API_KEY,
      clientId: CLIENT_ID,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
    });
    await gapi.auth2.getAuthInstance().signIn();
  });
};

document.getElementById("load-data").onclick = async () => {
  const response = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: "SOURCE_SHEET_ID",
    range: "Sheet1!A1:D",
  });
  const values = response.result.values;
  await pyodide.globals.set("sheet_values", values);
  await pyodide.runPythonAsync(`load_sheet_data(sheet_values)`);
};

document.getElementById("run-query").onclick = async () => {
  const sql = document.getElementById("sql").value;
  await pyodide.globals.set("query", sql);
  await pyodide.runPythonAsync(`result_csv = run_query(query)`);
  const result = pyodide.globals.get("result_csv");
  document.getElementById("results").innerText = result;
};

document.getElementById("export").onclick = async () => {
  const csv = pyodide.globals.get("result_csv");
  const rows = csv.split("\n").map(row => row.split(","));
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId: "DEST_SHEET_ID",
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    resource: { values: rows },
  });
};

startPyodide();

