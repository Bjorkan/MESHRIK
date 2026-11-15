use std::{
    io::Write,
    process::{Command, Stdio},
};

use serde_json::{Value, json};

fn run_probe(input: Value) -> Value {
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

fn probe(operations: Value) -> Value {
    run_probe(
        json!({"sqlite": [], "scenarios": [{"name": "synthetic", "fresh": true, "operations": operations}]}),
    )
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

#[test]
fn clean_stop_export_can_be_read_by_sqlite() {
    let report = run_probe(
        json!({"sqlite": [], "scenarios": [{"name":"synthetic-export", "fresh":true, "export_after_close":true,
        "operations":[{"sql":"CREATE TABLE fixture(id INTEGER PRIMARY KEY, payload BLOB)"},
            {"sql":"INSERT INTO fixture VALUES(7,x'00ff80')"}]}]}),
    );
    let bytes: Vec<u8> =
        serde_json::from_value(report["results"][0]["sqlite_after"].clone()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("stopped.db");
    std::fs::write(&path, bytes).unwrap();
    let status = Command::new("python3").arg("-c").arg(
        "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); assert c.execute('PRAGMA integrity_check').fetchall()==[('ok',)]; assert c.execute('SELECT id,hex(payload) FROM fixture').fetchall()==[(7,'00FF80')]; c.close()"
    ).arg(&path).status().unwrap();
    assert!(status.success());
}

#[test]
fn unclean_checkpoint_does_not_export_a_rollback_file() {
    let report = run_probe(
        json!({"sqlite":[],"scenarios":[{"name":"synthetic-busy-export","fresh":true,"export_after_close":true,
        "operations":[{"sql":"CREATE TABLE fixture(id INTEGER)"},{"sql":"BEGIN"},{"sql":"INSERT INTO fixture VALUES(1)"}]}]}),
    );
    let result = &report["results"][0];
    assert_eq!(result["export_error"], "checkpoint_not_clean");
    assert!(result.get("sqlite_after").is_none());
}

#[test]
fn native_autoincrement_survives_process_restart_and_deletion() {
    let first = run_probe(
        json!({"sqlite":[],"scenarios":[{"name":"native-counter","fresh":true,"export_after_close":true,
        "operations":[{"sql":"CREATE TABLE fixture(id INTEGER PRIMARY KEY AUTOINCREMENT)"},
            {"sql":"INSERT INTO fixture DEFAULT VALUES"},{"sql":"INSERT INTO fixture DEFAULT VALUES"},
            {"sql":"DELETE FROM fixture WHERE id=2"}]}]}),
    );
    let stopped = first["results"][0]["sqlite_after"].clone();
    let restarted = run_probe(
        json!({"sqlite":stopped,"scenarios":[{"name":"native-counter-restart","fresh":false,
        "operations":[{"sql":"INSERT INTO fixture DEFAULT VALUES"},{"sql":"SELECT id FROM fixture ORDER BY id"}]}]}),
    );
    assert_eq!(
        restarted["results"][0]["results"][1],
        json!({"rows":[[{"type":"integer","value":1}],[{"type":"integer","value":3}]]})
    );
}

#[tokio::test]
async fn unfinished_writer_is_busy_and_a_dropped_read_cursor_releases_the_connection() {
    let database = turso::Builder::new_local(":memory:").build().await.unwrap();
    let connection = database.connect().unwrap();
    connection
        .execute("CREATE TABLE fixture(id INTEGER)", ())
        .await
        .unwrap();
    let mut writer = connection
        .query("INSERT INTO fixture VALUES(1),(2) RETURNING id", ())
        .await
        .unwrap();
    assert!(writer.next().await.unwrap().is_some());
    assert!(matches!(
        connection
            .execute("INSERT INTO fixture VALUES(3)", ())
            .await,
        Err(turso::Error::Busy(_))
    ));
    while writer.next().await.unwrap().is_some() {}
    drop(writer);
    let mut reader = connection
        .query("SELECT id FROM fixture", ())
        .await
        .unwrap();
    assert!(reader.next().await.unwrap().is_some());
    drop(reader);
    connection
        .execute("INSERT INTO fixture VALUES(3)", ())
        .await
        .unwrap();
}
