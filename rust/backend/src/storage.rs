//! Serialized native Turso storage. No legacy import, cloud or RF access.
use std::{
    fmt, fs,
    future::Future,
    io::{Read, Write},
    path::{Path, PathBuf},
    pin::Pin,
};

use tokio::sync::Mutex;
use turso::{Connection, Database, IntoParams, Value};
use uuid::Uuid;

use crate::lifecycle::ProcessLease;
pub mod integrity;

pub const SCHEMA_VERSION: i64 = 73;
const MARKER: &str = "__meshrik_storage";
const SCHEMA: &str = include_str!("storage/schema.sql");

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StorageError {
    Io,
    Busy,
    Readonly,
    Corrupt,
    Constraint,
    Engine,
    Ownership,
    UnsupportedVersion,
    Incomplete,
    UnsupportedMaintenance,
    InvalidValue,
}
impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Io => "Storage I/O failed",
            Self::Busy => "Storage is busy",
            Self::Readonly => "Storage is read-only",
            Self::Corrupt => "Storage is corrupt or unidentified",
            Self::Constraint => "Storage constraint rejected the operation",
            Self::Engine => "Native storage operation failed",
            Self::Ownership => "Exclusive storage ownership is required",
            Self::UnsupportedVersion => {
                "Native storage version is unsupported; existing data was preserved"
            }
            Self::Incomplete => {
                "Native storage initialization is incomplete; existing data was preserved"
            }
            Self::UnsupportedMaintenance => {
                "Compaction is unavailable; use supported checkpoint and native backup operations"
            }
            Self::InvalidValue => "Stored value has an unexpected type",
        })
    }
}
impl fmt::Debug for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for StorageError {}
impl From<std::io::Error> for StorageError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}
impl From<turso::Error> for StorageError {
    fn from(error: turso::Error) -> Self {
        match error {
            turso::Error::Busy(_) | turso::Error::BusySnapshot(_) => Self::Busy,
            turso::Error::Readonly(_) => Self::Readonly,
            turso::Error::Constraint(_) => Self::Constraint,
            turso::Error::Corrupt(_) | turso::Error::NotAdb(_) => Self::Corrupt,
            _ => Self::Engine,
        }
    }
}
pub type Result<T> = std::result::Result<T, StorageError>;
pub type Operation<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

pub struct Row {
    columns: Vec<String>,
    values: Vec<Value>,
}
impl Row {
    pub fn value(&self, name: &str) -> Result<&Value> {
        self.columns
            .iter()
            .position(|column| column == name)
            .and_then(|index| self.values.get(index))
            .ok_or(StorageError::InvalidValue)
    }
    pub fn integer(&self, name: &str) -> Result<i64> {
        match self.value(name)? {
            Value::Integer(value) => Ok(*value),
            _ => Err(StorageError::InvalidValue),
        }
    }
    pub fn text(&self, name: &str) -> Result<&str> {
        match self.value(name)? {
            Value::Text(value) => Ok(value),
            _ => Err(StorageError::InvalidValue),
        }
    }
    pub fn optional_text(&self, name: &str) -> Result<Option<&str>> {
        match self.value(name)? {
            Value::Null => Ok(None),
            Value::Text(value) => Ok(Some(value)),
            _ => Err(StorageError::InvalidValue),
        }
    }
    pub fn optional_integer(&self, name: &str) -> Result<Option<i64>> {
        match self.value(name)? {
            Value::Null => Ok(None),
            Value::Integer(value) => Ok(Some(*value)),
            _ => Err(StorageError::InvalidValue),
        }
    }
}

/// Owns no cursor. Mutable methods enforce sequential statements per session.
pub struct Session<'a> {
    connection: &'a Connection,
}
impl Session<'_> {
    pub async fn query(&mut self, sql: &str, params: impl IntoParams) -> Result<Vec<Row>> {
        let mut statement = self.connection.prepare(sql).await?;
        let mut rows = statement.query(params).await?;
        let mut result = vec![];
        while let Some(row) = rows.next().await? {
            let mut columns = vec![];
            let mut values = vec![];
            for index in 0..row.column_count() {
                columns.push(statement.column_name(index)?);
                values.push(row.get_value(index)?);
            }
            result.push(Row { columns, values });
        }
        Ok(result)
    }
    pub async fn execute(&mut self, sql: &str, params: impl IntoParams) -> Result<u64> {
        Ok(self.connection.execute(sql, params).await?)
    }
    pub fn last_insert_rowid(&self) -> i64 {
        self.connection.last_insert_rowid()
    }
}

struct State {
    connection: Connection,
    rollback_needed: bool,
}
impl State {
    async fn recover(&mut self) -> Result<()> {
        if self.rollback_needed {
            if !self.connection.is_autocommit()? {
                self.connection.execute("ROLLBACK", ()).await?;
            }
            self.rollback_needed = false;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenOutcome {
    Created,
    DiscardedLegacy,
    Reopened,
}

/// Drop connection/database before releasing the whole-lifetime process lease.
pub struct Storage {
    state: Mutex<State>,
    _database: Database,
    lease: ProcessLease,
    generation: String,
    outcome: OpenOutcome,
}

impl Storage {
    pub async fn open(lease: ProcessLease) -> Result<Self> {
        let path = lease.database_path();
        let classification = classify(path).await?;
        let outcome = match classification {
            Classification::Missing => OpenOutcome::Created,
            Classification::Legacy => {
                discard_legacy(path)?;
                OpenOutcome::DiscardedLegacy
            }
            Classification::Native => OpenOutcome::Reopened,
        };
        let database = turso::Builder::new_local(path.to_str().ok_or(StorageError::Io)?)
            .build()
            .await?;
        let connection = database.connect()?;
        configure(&connection).await?;
        let generation = if outcome == OpenOutcome::Reopened {
            read_identity(&connection).await?
        } else {
            initialize(&connection, SCHEMA).await?
        };
        validate_schema(&connection).await?;
        let storage = Self {
            state: Mutex::new(State {
                connection,
                rollback_needed: false,
            }),
            _database: database,
            lease,
            generation,
            outcome,
        };
        storage.verify_integrity().await?;
        Ok(storage)
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn outcome(&self) -> OpenOutcome {
        self.outcome
    }
    pub async fn read<T: Send + 'static>(
        &self,
        operation: impl for<'a> FnOnce(Session<'a>) -> Operation<'a, T>,
    ) -> Result<T> {
        let mut state = self.state.lock().await;
        state.recover().await?;
        operation(Session {
            connection: &state.connection,
        })
        .await
    }
    pub async fn write<T: Send + 'static>(
        &self,
        operation: impl for<'a> FnOnce(Session<'a>) -> Operation<'a, T>,
    ) -> Result<T> {
        let mut state = self.state.lock().await;
        state.recover().await?;
        // Set before awaiting BEGIN: cancellation at any following await leaves
        // recovery pending before the next reader/writer can access the state.
        state.rollback_needed = true;
        if let Err(error) = state.connection.execute("BEGIN IMMEDIATE", ()).await {
            state.recover().await?;
            return Err(error.into());
        }
        let result = operation(Session {
            connection: &state.connection,
        })
        .await;
        match result {
            Ok(value) => {
                if let Err(error) = state.connection.execute("COMMIT", ()).await {
                    state.recover().await?;
                    return Err(error.into());
                }
                state.rollback_needed = false;
                Ok(value)
            }
            Err(error) => {
                state.recover().await?;
                Err(error)
            }
        }
    }
    pub async fn checkpoint(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        state.recover().await?;
        checkpoint(&state.connection).await
    }
    pub async fn backup(&self, target: &Path) -> Result<()> {
        let mut state = self.state.lock().await;
        state.recover().await?;
        checkpoint(&state.connection).await?;
        let parent = target
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        let mut source = fs::File::open(self.lease.database_path())?;
        std::io::copy(&mut source, &mut temporary)?;
        temporary.flush()?;
        temporary.as_file().sync_all()?;
        temporary
            .persist_noclobber(target)
            .map_err(|_| StorageError::Io)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    }
    pub fn compact(&self) -> Result<()> {
        Err(StorageError::UnsupportedMaintenance)
    }
    pub async fn verify_integrity(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        state.recover().await?;
        let rows = Session {
            connection: &state.connection,
        }
        .query("PRAGMA integrity_check", ())
        .await?;
        if rows.is_empty()
            || rows
                .iter()
                .any(|row| !matches!(row.values.first(),Some(Value::Text(value)) if value=="ok"))
        {
            return Err(StorageError::Corrupt);
        }
        if !integrity::foreign_key_check(&state.connection)
            .await?
            .is_empty()
        {
            return Err(StorageError::Constraint);
        }
        Ok(())
    }
}

enum Classification {
    Missing,
    Legacy,
    Native,
}
async fn classify(path: &Path) -> Result<Classification> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            for suffix in ["-wal", "-shm", "-journal"] {
                let mut sidecar = path.as_os_str().to_owned();
                sidecar.push(suffix);
                if fs::symlink_metadata(PathBuf::from(sidecar)).is_ok() {
                    return Err(StorageError::Corrupt);
                }
            }
            return Ok(Classification::Missing);
        }
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.file_type().is_file() => return Err(StorageError::Corrupt),
        Ok(metadata) if metadata.len() == 0 => return Err(StorageError::Corrupt),
        _ => {}
    }
    let mut header = [0; 16];
    fs::File::open(path)?.read_exact(&mut header)?;
    if &header != b"SQLite format 3\0" {
        return Err(StorageError::Corrupt);
    }
    let database = turso::Builder::new_local(path.to_str().ok_or(StorageError::Io)?)
        .read_only(true)
        .build()
        .await?;
    let connection = database.connect()?;
    let mut session = Session {
        connection: &connection,
    };
    let markers = session
        .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            [MARKER],
        )
        .await?;
    if !markers.is_empty() {
        read_identity(&connection).await?;
        return Ok(Classification::Native);
    }
    let version = session
        .query("PRAGMA user_version", ())
        .await?
        .first()
        .ok_or(StorageError::Corrupt)?
        .integer("user_version")?;
    if version > 72 {
        return Err(StorageError::UnsupportedVersion);
    }
    Ok(Classification::Legacy)
}

fn discard_legacy(path: &Path) -> Result<()> {
    for suffix in ["-wal", "-shm", "-journal", ""] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        match fs::remove_file(PathBuf::from(sidecar)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

async fn configure(connection: &Connection) -> Result<()> {
    let mut session = Session { connection };
    for (name, value, expected) in [
        ("journal_mode", "WAL", Value::Text("wal".into())),
        ("synchronous", "NORMAL", Value::Integer(1)),
        ("busy_timeout", "5000", Value::Integer(5000)),
        ("cache_size", "-64000", Value::Integer(-64000)),
        ("temp_store", "MEMORY", Value::Integer(2)),
        ("foreign_keys", "ON", Value::Integer(1)),
    ] {
        session.query(&format!("PRAGMA {name}={value}"), ()).await?;
        let mut rows = session.query(&format!("PRAGMA {name}"), ()).await?;
        let value = rows
            .pop()
            .and_then(|row| row.values.into_iter().next())
            .ok_or(StorageError::Engine)?;
        if value != expected {
            return Err(StorageError::Engine);
        }
    }
    let rows = session.query("PRAGMA auto_vacuum", ()).await?;
    if rows
        .first()
        .ok_or(StorageError::Engine)?
        .integer("auto_vacuum")?
        != 0
    {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

async fn initialize(connection: &Connection, schema: &str) -> Result<String> {
    let generation = Uuid::new_v4().simple().to_string();
    connection.execute("CREATE TABLE __meshrik_storage(singleton INTEGER PRIMARY KEY CHECK(singleton=1),engine TEXT NOT NULL,generation TEXT NOT NULL,schema_version INTEGER NOT NULL,status TEXT NOT NULL)",()).await?;
    connection
        .execute(
            "INSERT INTO __meshrik_storage VALUES(1,'turso',?,0,'initializing')",
            [generation.as_str()],
        )
        .await?;
    connection.execute("BEGIN IMMEDIATE", ()).await?;
    let result = async {
        connection.execute_batch(schema).await?;
        connection
            .execute(
                "UPDATE __meshrik_storage SET schema_version=?,status='ready' WHERE singleton=1",
                [SCHEMA_VERSION],
            )
            .await?;
        // Row-returning pragmas must be drained even during initialization.
        Session { connection }
            .query(&format!("PRAGMA user_version={SCHEMA_VERSION}"), ())
            .await?;
        connection.execute("COMMIT", ()).await?;
        Ok::<_, StorageError>(())
    }
    .await;
    if let Err(error) = result {
        let _ = connection.execute("ROLLBACK", ()).await;
        return Err(error);
    }
    Ok(generation)
}

async fn read_identity(connection: &Connection) -> Result<String> {
    let mut session = Session { connection };
    let mut rows=session.query("SELECT engine,generation,schema_version,status FROM __meshrik_storage WHERE singleton=1",()).await?;
    let row = rows.pop().ok_or(StorageError::Incomplete)?;
    if row.text("engine")? != "turso" {
        return Err(StorageError::Corrupt);
    }
    if row.text("status")? != "ready" {
        return Err(StorageError::Incomplete);
    }
    let version = session
        .query("PRAGMA user_version", ())
        .await?
        .first()
        .ok_or(StorageError::Corrupt)?
        .integer("user_version")?;
    if row.integer("schema_version")? != SCHEMA_VERSION || version != SCHEMA_VERSION {
        return Err(StorageError::UnsupportedVersion);
    }
    let generation = row.text("generation")?;
    if Uuid::parse_str(generation).is_err() {
        return Err(StorageError::Corrupt);
    }
    Ok(generation.into())
}

async fn validate_schema(connection: &Connection) -> Result<()> {
    let mut session = Session { connection };
    let required: Vec<(String, String)> =
        serde_json::from_str(include_str!("storage/schema_inventory.json"))
            .map_err(|_| StorageError::Engine)?;
    let mut actual = std::collections::BTreeSet::new();
    for row in session
        .query(
            "SELECT type,name FROM sqlite_master WHERE type IN ('table','index','trigger')",
            (),
        )
        .await?
    {
        actual.insert((row.text("type")?.to_owned(), row.text("name")?.to_owned()));
    }
    if required.iter().any(|object| !actual.contains(object)) {
        return Err(StorageError::Incomplete);
    }
    Ok(())
}

async fn checkpoint(connection: &Connection) -> Result<()> {
    let mut rows = Session { connection }
        .query("PRAGMA wal_checkpoint(TRUNCATE)", ())
        .await?;
    let row = rows.pop().ok_or(StorageError::Engine)?;
    match row.values.first() {
        Some(Value::Integer(0)) => Ok(()),
        _ => Err(StorageError::Busy),
    }
}
