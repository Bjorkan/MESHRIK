use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
};

/// Same Linux flock protocol/path as Python RadioProcessLease. Never unlink.
pub struct ProcessLease {
    _file: File,
}

impl ProcessLease {
    pub fn acquire(database_path: &Path) -> io::Result<Self> {
        let mut lock_path = database_path.as_os_str().to_owned();
        lock_path.push(".radio-owner.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        file.try_lock().map_err(io::Error::other)?;
        Ok(Self { _file: file })
    }
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    Fixture,
    Stopping,
}

/// Resources are deliberately absent until their migration gates pass.
#[derive(serde::Serialize)]
pub struct RuntimeStatus {
    pub readiness: Readiness,
    pub database_open: bool,
    pub radio_open: bool,
    pub integrations_started: bool,
}

impl Default for RuntimeStatus {
    fn default() -> Self {
        Self {
            readiness: Readiness::Fixture,
            database_open: false,
            radio_open: false,
            integrations_started: false,
        }
    }
}
