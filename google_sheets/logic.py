import duckdb
import pandas as pd
from io import StringIO

con = duckdb.connect()

def load_sheet_data(values):
    df = pd.DataFrame(values[1:], columns=values[0])
    con.register("sheet_data", df)

def run_query(query):
    df = con.execute(query).fetchdf()
    return df.to_csv(index=False)

