use std::{
    fs::{File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

/// Same Linux flock protocol/path as Python RadioProcessLease. Never unlink.
pub struct ProcessLease {
    _file: File,
    database_path: PathBuf,
}

impl ProcessLease {
    pub fn acquire(database_path: &Path) -> io::Result<Self> {
        let parent = database_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let name = database_path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid database path"))?;
        let database_path = parent.canonicalize()?.join(name);
        let mut lock_path = database_path.as_os_str().to_owned();
        lock_path.push(".radio-owner.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        file.try_lock().map_err(io::Error::other)?;
        Ok(Self {
            _file: file,
            database_path,
        })
    }

    pub(crate) fn database_path(&self) -> &Path {
        &self.database_path
    }
}

impl Drop for ProcessLease {
    fn drop(&mut self) {
        // Like Python's RadioProcessLease.release, explicitly unlock before
        // closing. A concurrent fork may briefly inherit the open-file
        // description before CLOEXEC closes it in the child.
        let _ = self._file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn releasing_owner_unlocks_even_with_a_transient_inherited_description() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fixture.db");
        let owner = ProcessLease::acquire(&path).unwrap();
        let inherited = owner._file.try_clone().unwrap();
        assert!(ProcessLease::acquire(&path).is_err());
        drop(owner);
        assert!(ProcessLease::acquire(&path).is_ok());
        drop(inherited);
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
