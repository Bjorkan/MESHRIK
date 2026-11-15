use std::{
    io::Write,
    process::{Command, Stdio},
};

use serde_json::{Value, json};

fn probe(operations: Value) -> Value {
    let input = json!({"sqlite": [], "scenarios": [{"name": "synthetic", "fresh": true, "operations": operations}]});
    let mut child = Command::new(env!("CARGO_BIN_EXE_meshrik-turso-probe"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&input).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn native_probe_preserves_blob_null_and_transaction_rollback() {
    let report = probe(json!([
        {"sql": "CREATE TABLE fixture(id INTEGER PRIMARY KEY, payload BLOB, optional TEXT)"},
        {"sql": "BEGIN"},
        {"sql": "INSERT INTO fixture VALUES(1,?,?)", "params": [{"type":"blob","value":[0,255,128]}, {"type":"null"}]},
        {"sql": "ROLLBACK"},
        {"sql": "SELECT COUNT(*) FROM fixture"},
        {"sql": "INSERT INTO fixture VALUES(1,?,?)", "params": [{"type":"blob","value":[0,255,128]}, {"type":"null"}]},
        {"sql": "SELECT payload,optional FROM fixture"}
    ]));
    let results = &report["results"][0]["results"];
    assert_eq!(results[4], json!({"rows":[[{"type":"integer","value":0}]]}));
    assert_eq!(
        results[6],
        json!({"rows":[[{"type":"blob","value":[0,255,128]}, {"type":"null"}]]})
    );
}

#[test]
fn native_probe_does_not_emit_sql_or_bound_values_on_failure() {
    let report = probe(json!([
        {"sql":"SELECT * FROM synthetic_missing", "params":[{"type":"text","value":"synthetic-private-token"}]}
    ]));
    assert_eq!(report["results"][0]["results"][0], json!({"error":"error"}));
    let output = report.to_string();
    assert!(!output.contains("synthetic-private-token"));
    assert!(!output.contains("synthetic_missing"));
}
