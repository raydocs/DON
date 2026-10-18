//! Damaged JSON stays on disk and out of normal use until an explicit repair.
use crate::profile::BrowserProfile;
use crate::settings_manager::AppSettings;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct RecoveryItem {
  id: String,
  path: String,
}

fn valid(path: &Path, id: &str) -> bool {
  let Ok(bytes) = fs::read(path) else {
    return false;
  };
  valid_bytes(&bytes, id)
}

fn valid_bytes(bytes: &[u8], id: &str) -> bool {
  if id == "settings" {
    serde_json::from_slice::<AppSettings>(bytes).is_ok()
  } else {
    serde_json::from_slice::<BrowserProfile>(bytes)
      .is_ok_and(|profile| profile.id.to_string() == id)
  }
}

#[tauri::command]
pub fn get_data_recovery_items() -> Result<Vec<RecoveryItem>, String> {
  let mut items = Vec::new();
  let settings = crate::settings_manager::SettingsManager::instance().get_settings_file();
  if settings.exists() && !valid(&settings, "settings") {
    items.push(RecoveryItem {
      id: "settings".into(),
      path: settings.display().to_string(),
    });
  }
  let root = crate::app_dirs::profiles_dir();
  if root.exists() {
    for entry in fs::read_dir(root).map_err(io_error)? {
      let entry = entry.map_err(io_error)?;
      if !entry.file_type().map_err(io_error)?.is_dir() {
        continue;
      }
      let id = entry.file_name().to_string_lossy().to_string();
      if uuid::Uuid::parse_str(&id).is_err() {
        continue;
      }
      let path = entry.path().join("metadata.json");
      if !valid(&path, &id) {
        items.push(RecoveryItem {
          id,
          path: path.display().to_string(),
        });
      }
    }
  }
  Ok(items)
}

fn io_error(error: impl std::fmt::Display) -> String {
  crate::backend_error_with_detail("DATA_RECOVERY_FAILED", error)
}

/// Flush the exact original to a unique sibling before replacing anything.
fn replace_preserving_original(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
  use std::io::Write;
  let backup = path.with_file_name(format!(
    "{}.quarantine-{}",
    path.file_name().unwrap().to_string_lossy(),
    uuid::Uuid::new_v4()
  ));
  if path.exists() {
    let original = fs::read(path).map_err(io_error)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    let mut file = options.open(&backup).map_err(io_error)?;
    file.write_all(&original).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
  }
  let staging = path.with_extension(format!("recovery-{}", uuid::Uuid::new_v4()));
  let mut options = fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(&staging).map_err(io_error)?;
  file.write_all(bytes).map_err(io_error)?;
  file.sync_all().map_err(io_error)?;
  drop(file);
  let result = crate::app_auto_updater::atomic_replace(&staging, path).map_err(io_error);
  if result.is_err() {
    let _ = fs::remove_file(&staging);
  }
  result?;
  Ok(backup)
}

#[tauri::command]
pub fn recover_data_file(id: String, source: Option<String>) -> Result<(), String> {
  static RECOVERY: std::sync::Mutex<()> = std::sync::Mutex::new(());
  let _guard = RECOVERY.lock().map_err(io_error)?;
  let profile_lock = uuid::Uuid::parse_str(&id)
    .ok()
    .map(|id| crate::profile::ProfileManager::instance().profile_lock(id));
  let _profile_guard = profile_lock
    .as_ref()
    .map(|lock| lock.lock().map_err(io_error))
    .transpose()?;
  let path = if id == "settings" {
    crate::settings_manager::SettingsManager::instance().get_settings_file()
  } else {
    let parsed =
      uuid::Uuid::parse_str(&id).map_err(|_| crate::backend_error("INVALID_PROFILE_ID"))?;
    let dir = crate::app_dirs::profiles_dir().join(parsed.to_string());
    if !dir.is_dir() {
      return Err(crate::backend_error("PROFILE_NOT_FOUND"));
    }
    dir.join("metadata.json")
  };
  if valid(&path, &id) {
    return Err(crate::backend_error("DATA_RECOVERY_NOT_NEEDED"));
  }
  let bytes = match source {
    Some(source) => {
      let bytes = fs::read(source).map_err(io_error)?;
      if !valid_bytes(&bytes, &id) {
        return Err(crate::backend_error("DATA_RECOVERY_INVALID"));
      }
      bytes
    }
    None if id == "settings" => {
      serde_json::to_vec_pretty(&AppSettings::default()).map_err(io_error)?
    }
    None => return Err(crate::backend_error("DATA_RECOVERY_INVALID")),
  };
  replace_preserving_original(&path, &bytes)?;
  let _ = crate::events::emit_empty("profiles-changed");
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn repair_preserves_exact_original_and_rejects_wrong_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app_settings.json");
    let broken = b"{\"theme\": \xff";
    fs::write(&path, broken).unwrap();
    assert!(!valid(&path, "settings"));
    let repaired = serde_json::to_vec(&AppSettings::default()).unwrap();
    let backup = replace_preserving_original(&path, &repaired).unwrap();
    assert_eq!(fs::read(backup).unwrap(), broken);
    assert!(valid(&path, "settings"));
    assert!(!valid(&path, &uuid::Uuid::new_v4().to_string()));
  }
}
