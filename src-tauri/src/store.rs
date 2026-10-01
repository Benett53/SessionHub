//! Locating the configuration directory and crash-safe JSON persistence.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    pub config_dir: PathBuf,
    pub log_dir: PathBuf,
    pub portable: bool,
}

impl Paths {
    /// Portable mode: if a directory named `sessionhub-data` exists next to the
    /// executable (or next to the AppImage), everything is stored there.
    pub fn resolve() -> Result<Self> {
        if let Some(dir) = portable_dir() {
            return Ok(Self {
                log_dir: dir.join("logs"),
                config_dir: dir,
                portable: true,
            });
        }
        let dirs = directories::ProjectDirs::from("org", "SessionHub", "sessionhub")
            .context("could not determine the user's home directory")?;
        Ok(Self {
            config_dir: dirs.config_dir().to_path_buf(),
            log_dir: dirs.data_local_dir().join("logs"),
            portable: false,
        })
    }

    pub fn sessions_file(&self) -> PathBuf {
        self.config_dir.join("sessions.json")
    }

    pub fn settings_file(&self) -> PathBuf {
        self.config_dir.join("settings.json")
    }
}

fn portable_dir() -> Option<PathBuf> {
    let base = match std::env::var_os("APPIMAGE") {
        Some(appimage) => PathBuf::from(appimage).parent()?.to_path_buf(),
        None => std::env::current_exe().ok()?.parent()?.to_path_buf(),
    };
    let dir = base.join("sessionhub-data");
    dir.is_dir().then_some(dir)
}

/// Load a JSON file. Falls back to the `.bak` copy if the primary file is
/// corrupt, and to `T::default()` if neither exists.
pub fn load_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match read_json(path) {
        Ok(Some(v)) => Ok(v),
        Ok(None) => Ok(T::default()),
        Err(err) => {
            let bak = backup_path(path);
            log::error!("{}: {err:#}; trying backup", path.display());
            match read_json(&bak) {
                Ok(Some(v)) => {
                    // Keep the broken file for manual inspection.
                    let _ = fs::rename(path, path.with_extension("json.corrupt"));
                    Ok(v)
                }
                _ => Err(err),
            }
        }
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let data = match fs::read(path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let v = serde_json::from_slice(&data).with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(v))
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

/// Write atomically: temp file + fsync + rename. The previous version is kept
/// as `.bak`, so a crash or full disk can never leave an empty session list.
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let dir = path.parent().context("invalid path")?;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let data = serde_json::to_vec_pretty(value)?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        f.write_all(&data)?;
        f.sync_all()?;
    }
    if path.exists() {
        let _ = fs::copy(path, backup_path(path));
    }
    fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    restrict_permissions(path);
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionStore;

    #[test]
    fn roundtrip_and_backup_recovery() {
        let dir = std::env::temp_dir().join(format!("sessionhub-test-{}", uuid::Uuid::new_v4()));
        let file = dir.join("sessions.json");
        let mut store = SessionStore::default();
        store.sessions.push(crate::model::Session {
            id: "a".into(),
            name: "first".into(),
            ..Default::default()
        });
        save_json(&file, &store).unwrap();
        store.sessions[0].name = "second".into();
        save_json(&file, &store).unwrap();

        // Corrupt the primary file: the backup (first version) must be used.
        fs::write(&file, b"{ not json").unwrap();
        let loaded: SessionStore = load_json(&file).unwrap();
        assert_eq!(loaded.sessions[0].name, "first");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_file_gives_default() {
        let p = std::env::temp_dir().join("sessionhub-does-not-exist/x.json");
        let s: SessionStore = load_json(&p).unwrap();
        assert!(s.sessions.is_empty());
    }
}
