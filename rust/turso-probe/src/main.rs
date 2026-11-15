//! Test-only capability probe. Input DB bytes are copied into private temp files;
//! there is no CLI argument that can open an operator database or a cloud URL.
use std::io::{self, Read};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Fixture {
    sqlite: Vec<u8>,
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
struct Scenario {
    name: String,
    fresh: bool,
    #[serde(default)]
    read_only: bool,
    #[serde(default)]
    export_after_close: bool,
    operations: Vec<Operation>,
}

#[derive(Deserialize)]
struct Operation {
    sql: String,
    #[serde(default)]
    params: Vec<SqlValue>,
    #[serde(default)]
    mode: OperationMode,
}

#[derive(Default, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum OperationMode {
    #[default]
    Query,
    DrainRows,
    ForeignKeys,
    Checkpoint,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl From<SqlValue> for turso::Value {
    fn from(value: SqlValue) -> Self {
        match value {
            SqlValue::Null => Self::Null,
            SqlValue::Integer(value) => Self::Integer(value),
            SqlValue::Real(value) => Self::Real(value),
            SqlValue::Text(value) => Self::Text(value),
            SqlValue::Blob(value) => Self::Blob(value),
        }
    }
}

fn encode(value: turso::Value) -> SqlValue {
    match value {
        turso::Value::Null => SqlValue::Null,
        turso::Value::Integer(value) => SqlValue::Integer(value),
        turso::Value::Real(value) => SqlValue::Real(value),
        turso::Value::Text(value) => SqlValue::Text(value),
        turso::Value::Blob(value) => SqlValue::Blob(value),
    }
}

fn failure(error: turso::Error) -> Value {
    // Do not emit SQL/error strings: upstream errors can include bound values.
    let category = match error {
        turso::Error::Constraint(_) => "constraint",
        turso::Error::Busy(_) | turso::Error::BusySnapshot(_) => "busy",
        turso::Error::Readonly(_) => "readonly",
        turso::Error::Corrupt(_) | turso::Error::NotAdb(_) => "corrupt",
        _ => "error",
    };
    json!({"error": category})
}

async fn operation(connection: &turso::Connection, operation: Operation) -> turso::Result<Value> {
    if operation.mode == OperationMode::ForeignKeys {
        if operation.sql != "PRAGMA foreign_key_check" {
            return Err(turso::Error::Misuse("Invalid integrity probe".into()));
        }
        let failures = meshrik_backend::storage::integrity::foreign_key_check(connection).await?;
        return Ok(
            json!({"rows":failures.into_iter().map(|item|vec![SqlValue::Text(item.table),SqlValue::Integer(item.rowid),SqlValue::Text(item.parent),SqlValue::Integer(item.id)]).collect::<Vec<_>>()}),
        );
    }
    if operation.mode == OperationMode::Checkpoint
        && operation.sql != "PRAGMA wal_checkpoint(TRUNCATE)"
    {
        return Err(turso::Error::Misuse("Invalid checkpoint probe".into()));
    }
    let mut statement = connection.prepare(&operation.sql).await?;
    let mut rows = statement
        .query(turso::params_from_iter(
            operation.params.into_iter().map(turso::Value::from),
        ))
        .await?;
    let mut values = Vec::new();
    while let Some(row) = rows.next().await? {
        let mut cells = Vec::new();
        for index in 0..row.column_count() {
            cells.push(encode(row.get_value(index)?));
        }
        values.push(cells);
    }
    if operation.mode == OperationMode::DrainRows {
        return Ok(json!({"rows":[]}));
    }
    if operation.mode == OperationMode::Checkpoint {
        return Ok(
            json!({"rows": values.first().and_then(|row|row.first()).map(|busy| vec![vec![busy]]).unwrap_or_default()}),
        );
    }
    Ok(json!({"rows": values}))
}

async fn scenario(bytes: &[u8], scenario: Scenario) -> Value {
    let directory = tempfile::tempdir().expect("private probe directory");
    let path = directory.path().join("probe.db");
    if !scenario.fresh {
        std::fs::write(&path, bytes).expect("write disposable copy");
    }
    let builder =
        turso::Builder::new_local(path.to_str().expect("temp path")).read_only(scenario.read_only);
    let database = match builder.build().await {
        Ok(database) => database,
        Err(error) => return json!({"name": scenario.name, "open": failure(error)}),
    };
    let connection = match database.connect() {
        Ok(connection) => connection,
        Err(error) => return json!({"name": scenario.name, "open": failure(error)}),
    };
    let mut results = Vec::new();
    for item in scenario.operations {
        results.push(match operation(&connection, item).await {
            Ok(value) => value,
            Err(error) => failure(error),
        });
    }
    if scenario.export_after_close {
        let checkpoint = operation(
            &connection,
            Operation {
                sql: "PRAGMA wal_checkpoint(TRUNCATE)".into(),
                params: vec![],
                mode: OperationMode::Query,
            },
        )
        .await;
        let checkpoint = match checkpoint {
            Ok(value) => value,
            Err(error) => failure(error),
        };
        // Never present an uncheckpointed main file as a rollback artifact.
        if checkpoint["rows"][0][0]["value"] != json!(0) {
            return json!({"name":scenario.name, "results":results, "export_error":"checkpoint_not_clean"});
        }
        drop(connection);
        drop(database);
        return json!({"name":scenario.name, "results":results, "sqlite_after":std::fs::read(path).expect("read stopped disposable database")});
    }
    json!({"name": scenario.name, "results": results})
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin()
        .take(16 * 1024 * 1024)
        .read_to_string(&mut input)?;
    let fixture: Fixture = serde_json::from_str(&input)?;
    let mut results = Vec::new();
    for item in fixture.scenarios {
        results.push(scenario(&fixture.sqlite, item).await);
    }
    println!(
        "{}",
        serde_json::to_string(&json!({"engine": "turso", "version": "0.8.3", "results": results}))?
    );
    Ok(())
}
