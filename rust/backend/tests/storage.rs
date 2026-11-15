use meshrik_backend::{
    lifecycle::ProcessLease,
    storage::{OpenOutcome, SCHEMA_VERSION, Storage, StorageError},
};
use std::{fs, path::Path, process::Command, sync::Arc, time::Duration};
use tokio::sync::Notify;

async fn open(path: &Path) -> Result<Storage, StorageError> {
    Storage::open(ProcessLease::acquire(path).unwrap()).await
}
async fn count(storage: &Storage) -> i64 {
    storage
        .read(|mut session| {
            Box::pin(async move {
                session
                    .query("SELECT COUNT(*) AS count FROM contacts", ())
                    .await?[0]
                    .integer("count")
            })
        })
        .await
        .unwrap()
}
async fn add(storage: &Storage, key: &'static str) {
    storage
        .write(move |mut session| {
            Box::pin(async move {
                session
                    .execute(
                        "INSERT INTO contacts(public_key,name) VALUES(?,'synthetic')",
                        [key],
                    )
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn fresh_native_defaults_pragmas_marker_and_restart_are_durable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    let storage = open(&path).await.unwrap();
    assert_eq!(storage.outcome(), OpenOutcome::Created);
    let generation = storage.generation().to_owned();
    let (version, mode, channels, settings) = storage
        .read(|mut session| {
            Box::pin(async move {
                Ok((
                    session.query("PRAGMA user_version", ()).await?[0].integer("user_version")?,
                    session.query("PRAGMA auto_vacuum", ()).await?[0].integer("auto_vacuum")?,
                    session
                        .query("SELECT COUNT(*) AS count FROM channels", ())
                        .await?[0]
                        .integer("count")?,
                    session
                        .query("SELECT COUNT(*) AS count FROM app_settings", ())
                        .await?[0]
                        .integer("count")?,
                ))
            })
        })
        .await
        .unwrap();
    assert_eq!(
        (version, mode, channels, settings),
        (SCHEMA_VERSION, 0, 1, 1)
    );
    add(&storage, "fixture-peer").await;
    storage.checkpoint().await.unwrap();
    drop(storage);
    let reopened = open(&path).await.unwrap();
    assert_eq!(reopened.outcome(), OpenOutcome::Reopened);
    assert_eq!(reopened.generation(), generation);
    assert_eq!(count(&reopened).await, 1);
    reopened.verify_integrity().await.unwrap();
}

#[tokio::test]
async fn the_runtime_schema_columns_and_foreign_keys_match_the_frozen_python_reference() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    let storage = open(&path).await.unwrap();
    let reference = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/migration/python-v72/schema.json");
    let output=Command::new("python3").arg("-c").arg(
        "import json,sqlite3,sys; objects=json.load(open(sys.argv[1])); c=sqlite3.connect(':memory:'); [c.execute(o['sql']) for kind in ('table','index','trigger') for o in objects if o['type']==kind]; print(json.dumps({o['name']:{'columns':c.execute('PRAGMA table_info(\\\"'+o['name']+'\\\")').fetchall(),'keys':c.execute('PRAGMA foreign_key_list(\\\"'+o['name']+'\\\")').fetchall()} for o in objects if o['type']=='table'}))"
    ).arg(reference).output().unwrap();
    assert!(
        output.status.success(),
        "reference schema introspection failed"
    );
    let expected: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    for (table, checks) in expected.as_object().unwrap() {
        for (pragma, fields, key) in [
            (
                "table_info",
                vec!["cid", "name", "type", "notnull", "dflt_value", "pk"],
                "columns",
            ),
            (
                "foreign_key_list",
                vec![
                    "id",
                    "seq",
                    "table",
                    "from",
                    "to",
                    "on_update",
                    "on_delete",
                    "match",
                ],
                "keys",
            ),
        ] {
            let sql = format!("PRAGMA {pragma}(\"{}\")", table.replace('"', "\"\""));
            let actual = storage
                .read(move |mut session| {
                    Box::pin(async move {
                        let mut values = vec![];
                        for row in session.query(&sql, ()).await? {
                            let mut cells = vec![];
                            for name in &fields {
                                cells.push(match row.value(name)? {
                                    turso::Value::Null => serde_json::Value::Null,
                                    turso::Value::Integer(value) => serde_json::json!(value),
                                    turso::Value::Real(value) => serde_json::json!(value),
                                    turso::Value::Text(value) => serde_json::json!(value),
                                    turso::Value::Blob(value) => serde_json::json!(value),
                                });
                            }
                            values.push(cells);
                        }
                        Ok(serde_json::json!(values))
                    })
                })
                .await
                .unwrap();
            assert_eq!(actual, checks[key], "{table}: {pragma}");
        }
    }
}

#[tokio::test]
async fn legacy_sqlite_is_discarded_without_backup_or_import() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    assert!(Command::new("python3").arg("-c").arg("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(\"PRAGMA auto_vacuum=INCREMENTAL; CREATE TABLE messages(id INTEGER PRIMARY KEY,text TEXT); INSERT INTO messages VALUES(41,'synthetic-old-record'); PRAGMA user_version=72;\"); c.close()").arg(&path).status().unwrap().success());
    fs::write(
        directory.path().join("fixture.db-journal"),
        b"obsolete-test-journal",
    )
    .unwrap();
    let storage = open(&path).await.unwrap();
    assert_eq!(storage.outcome(), OpenOutcome::DiscardedLegacy);
    let messages = storage
        .read(|mut session| {
            Box::pin(async move {
                session
                    .query("SELECT COUNT(*) AS count FROM messages", ())
                    .await?[0]
                    .integer("count")
            })
        })
        .await
        .unwrap();
    assert_eq!(messages, 0);
    assert!(!directory.path().join("fixture.db-journal").exists());
    for entry in fs::read_dir(directory.path()).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        assert!(!name.contains("bak") && !name.contains("backup") && !name.contains("archive"));
    }
    storage.verify_integrity().await.unwrap();
}

#[tokio::test]
async fn failure_and_cancelled_writes_rollback_before_any_reader_or_next_writer() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    let storage = Arc::new(open(&path).await.unwrap());
    let failed: Result<(), StorageError> = storage
        .write(|mut session| {
            Box::pin(async move {
                session
                    .execute("INSERT INTO contacts(public_key) VALUES('rolled-back')", ())
                    .await?;
                Err(StorageError::Constraint)
            })
        })
        .await;
    assert_eq!(failed.unwrap_err(), StorageError::Constraint);
    assert_eq!(count(&storage).await, 0);
    let entered = Arc::new(Notify::new());
    let signal = entered.clone();
    let task_store = storage.clone();
    let task = tokio::spawn(async move {
        task_store
            .write(move |mut session| {
                Box::pin(async move {
                    session
                        .execute("INSERT INTO contacts(public_key) VALUES('cancelled')", ())
                        .await?;
                    signal.notify_one();
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Ok(())
                })
            })
            .await
    });
    entered.notified().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(count(&storage).await, 0);
    add(&storage, "committed").await;
    assert_eq!(count(&storage).await, 1);
    storage.verify_integrity().await.unwrap();
}

#[tokio::test]
async fn concurrent_callers_are_serialized_without_lost_commits() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    let storage = Arc::new(open(&path).await.unwrap());
    let mut tasks = vec![];
    for index in 0..24 {
        let storage = storage.clone();
        tasks.push(tokio::spawn(async move {
            let key = format!("synthetic-{index}");
            storage
                .write(move |mut session| {
                    Box::pin(async move {
                        session
                            .execute("INSERT INTO contacts(public_key) VALUES(?)", [key])
                            .await?;
                        Ok(())
                    })
                })
                .await
                .unwrap();
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    assert_eq!(count(&storage).await, 24);
    storage.verify_integrity().await.unwrap();
}

#[tokio::test]
async fn duplicate_owners_cannot_reset_or_touch_the_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    let storage = open(&path).await.unwrap();
    add(&storage, "preserved").await;
    storage.checkpoint().await.unwrap();
    let before = fs::read(&path).unwrap();
    assert!(ProcessLease::acquire(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(count(&storage).await, 1);
}

#[tokio::test]
async fn backup_contains_only_committed_native_data_and_never_overwrites() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    let snapshot = directory.path().join("snapshot.db");
    let storage = open(&path).await.unwrap();
    add(&storage, "committed").await;
    storage.backup(&snapshot).await.unwrap();
    let before = fs::read(&snapshot).unwrap();
    add(&storage, "later").await;
    assert!(storage.backup(&snapshot).await.is_err());
    assert_eq!(fs::read(&snapshot).unwrap(), before);
    let restored = open(&snapshot).await.unwrap();
    assert_eq!(restored.generation(), storage.generation());
    assert_eq!(count(&restored).await, 1);
    assert_eq!(count(&storage).await, 2);
    restored.verify_integrity().await.unwrap();
    assert_eq!(
        storage.compact().unwrap_err(),
        StorageError::UnsupportedMaintenance
    );
}

#[tokio::test]
async fn corrupt_unknown_future_and_incomplete_native_files_are_preserved() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    fs::write(&path, b"unidentified synthetic file").unwrap();
    let before = fs::read(&path).unwrap();
    assert!(matches!(open(&path).await, Err(StorageError::Corrupt)));
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::remove_file(&path).unwrap();
    let storage = open(&path).await.unwrap();
    add(&storage, "preserved").await;
    storage
        .write(|mut session| {
            Box::pin(async move {
                session.query("PRAGMA user_version=74", ()).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    storage.checkpoint().await.unwrap();
    drop(storage);
    let before = fs::read(&path).unwrap();
    assert!(matches!(
        open(&path).await,
        Err(StorageError::UnsupportedVersion)
    ));
    assert_eq!(fs::read(&path).unwrap(), before);
    let database = turso::Builder::new_local(path.to_str().unwrap())
        .build()
        .await
        .unwrap();
    let connection = database.connect().unwrap();
    connection
        .query("PRAGMA user_version=73", ())
        .await
        .unwrap()
        .next()
        .await
        .unwrap();
    connection
        .execute("UPDATE __meshrik_storage SET status='initializing'", ())
        .await
        .unwrap();
    let mut checkpoint = connection
        .query("PRAGMA wal_checkpoint(TRUNCATE)", ())
        .await
        .unwrap();
    while checkpoint.next().await.unwrap().is_some() {}
    drop(checkpoint);
    drop(connection);
    drop(database);
    let before = fs::read(&path).unwrap();
    assert!(matches!(open(&path).await, Err(StorageError::Incomplete)));
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn missing_main_with_orphan_sidecars_fails_closed_without_reset() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    let wal = directory.path().join("fixture.db-wal");
    fs::write(&wal, b"synthetic orphan").unwrap();
    assert!(matches!(open(&path).await, Err(StorageError::Corrupt)));
    assert!(!path.exists());
    assert_eq!(fs::read(wal).unwrap(), b"synthetic orphan");
}

#[tokio::test]
async fn an_existing_truncated_file_is_not_misclassified_as_disposable_legacy() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    fs::write(&path, []).unwrap();
    assert!(matches!(open(&path).await, Err(StorageError::Corrupt)));
    assert_eq!(fs::metadata(&path).unwrap().len(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn a_database_symlink_is_never_followed_for_reset() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("unrelated");
    let path = directory.path().join("fixture.db");
    fs::write(&target, b"preserved unrelated content").unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(matches!(open(&path).await, Err(StorageError::Corrupt)));
    assert!(path.is_symlink());
    assert_eq!(fs::read(target).unwrap(), b"preserved unrelated content");
}

#[tokio::test]
async fn a_missing_revision_trigger_fails_closed_without_reinitializing_native_data() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    let storage = open(&path).await.unwrap();
    add(&storage, "preserved").await;
    storage
        .write(|mut session| {
            Box::pin(async move {
                session
                    .execute("DROP TRIGGER trg_virtual_companion_contact_insert", ())
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    storage.checkpoint().await.unwrap();
    drop(storage);
    let before = fs::read(&path).unwrap();
    assert!(matches!(open(&path).await, Err(StorageError::Incomplete)));
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn an_orphan_in_owned_native_storage_is_reported_without_resetting_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.db");
    let storage = open(&path).await.unwrap();
    add(&storage, "preserved").await;
    storage.checkpoint().await.unwrap();
    drop(storage);
    {
        let database = turso::Builder::new_local(path.to_str().unwrap())
            .build()
            .await
            .unwrap();
        let connection = database.connect().unwrap();
        connection.execute("INSERT INTO pending_dm_ack_correlations(code,message_id,radio_key,expiry_at) VALUES('fixture',999,'fixture',2000)",()).await.unwrap();
        let mut rows = connection
            .query("PRAGMA wal_checkpoint(TRUNCATE)", ())
            .await
            .unwrap();
        while rows.next().await.unwrap().is_some() {}
    }
    let before = fs::read(&path).unwrap();
    assert!(matches!(open(&path).await, Err(StorageError::Constraint)));
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn killed_owner_recovers_only_committed_native_data_and_releases_lease() {
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("uncommitted-ready");
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_crash_child", "--ignored", "--nocapture"])
            .env("MESHRIK_CRASH_FIXTURE_DIR", directory.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(child.0.try_wait().unwrap().is_none());
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let recovered = open(&directory.path().join("fixture.db")).await.unwrap();
        assert_eq!(recovered.outcome(), OpenOutcome::Reopened);
        assert_eq!(count(&recovered).await, 1);
        let keys = recovered
            .read(|mut session| {
                Box::pin(async move {
                    Ok(
                        session.query("SELECT public_key FROM contacts", ()).await?[0]
                            .text("public_key")?
                            .to_owned(),
                    )
                })
            })
            .await
            .unwrap();
        assert_eq!(keys, "committed");
        recovered.verify_integrity().await.unwrap();
    });
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "helper invoked only by the isolated killed-owner parent test"]
async fn native_crash_child() {
    let directory = std::path::PathBuf::from(
        std::env::var("MESHRIK_CRASH_FIXTURE_DIR").expect("parent fixture directory"),
    );
    let storage = open(&directory.join("fixture.db")).await.unwrap();
    add(&storage, "committed").await;
    storage
        .write(move |mut session| {
            Box::pin(async move {
                session
                    .execute("INSERT INTO contacts(public_key) VALUES('uncommitted')", ())
                    .await?;
                fs::write(directory.join("uncommitted-ready"), b"ready").unwrap();
                std::future::pending::<()>().await;
                Ok(())
            })
        })
        .await
        .unwrap();
}
