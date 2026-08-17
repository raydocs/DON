use crate::extension_manager::{Extension, ExtensionGroup};
use crate::group_manager::ProfileGroup;
use crate::profile::types::SyncMode;
use crate::profile::BrowserProfile;
use crate::proxy_manager::StoredProxy;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const ERROR_CODE: &str = "LEGACY_MIGRATION_FAILED";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct MigrationSelection {
  pub profiles: bool,
  pub proxies: bool,
  pub groups: bool,
  pub extensions: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct MigrationCounts {
  pub profiles: usize,
  pub proxies: usize,
  pub groups: usize,
  pub extensions: usize,
}

#[derive(Debug, Serialize)]
pub struct MigrationPreview {
  pub available: bool,
  pub source_path: String,
  pub counts: MigrationCounts,
  pub conflicts: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MigrationResult {
  pub copied: usize,
  pub skipped: usize,
  pub failed: usize,
  pub report_path: String,
}

#[derive(Serialize)]
struct MigrationReport {
  copied: usize,
  skipped: usize,
  failed: usize,
  notes: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct Groups<T> {
  groups: Vec<T>,
}

fn json_error() -> String {
  crate::backend_error(ERROR_CODE)
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
  let bytes = fs::read(path).map_err(|_| json_error())?;
  serde_json::from_slice(&bytes).map_err(|_| json_error())
}

fn list_json<T: DeserializeOwned>(dir: &Path) -> Result<Vec<T>, String> {
  if !dir.exists() {
    return Ok(Vec::new());
  }
  let mut values = Vec::new();
  for entry in fs::read_dir(dir).map_err(|_| json_error())? {
    let path = entry.map_err(|_| json_error())?.path();
    if path.extension().and_then(|v| v.to_str()) == Some("json") {
      values.push(read_json(&path)?);
    }
  }
  Ok(values)
}

fn read_groups<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>, String> {
  if !path.exists() {
    return Ok(Vec::new());
  }
  Ok(read_json::<Groups<T>>(path)?.groups)
}

fn read_profiles(root: &Path) -> Result<Vec<(BrowserProfile, PathBuf)>, String> {
  let dir = root.join("profiles");
  if !dir.exists() {
    return Ok(Vec::new());
  }
  let mut profiles = Vec::new();
  for entry in fs::read_dir(dir).map_err(|_| json_error())? {
    let path = entry.map_err(|_| json_error())?.path();
    let metadata = path.join("metadata.json");
    if metadata.is_file() {
      profiles.push((read_json(&metadata)?, path));
    }
  }
  Ok(profiles)
}

fn read_extensions(root: &Path) -> Result<Vec<(Extension, PathBuf)>, String> {
  let dir = root.join("extensions");
  if !dir.exists() {
    return Ok(Vec::new());
  }
  let mut extensions = Vec::new();
  for entry in fs::read_dir(dir).map_err(|_| json_error())? {
    let path = entry.map_err(|_| json_error())?.path();
    let metadata = path.join("metadata.json");
    if metadata.is_file() {
      extensions.push((read_json(&metadata)?, path));
    }
  }
  Ok(extensions)
}

fn existing_names<T, F>(items: &[T], id: F) -> HashMap<String, String>
where
  F: Fn(&T) -> (&str, &str),
{
  let mut result = HashMap::new();
  for item in items {
    let (id, name) = id(item);
    result.insert(name.to_lowercase(), id.to_string());
    result.insert(id.to_string(), id.to_string());
  }
  result
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
  fs::create_dir_all(target).map_err(|_| json_error())?;
  for entry in fs::read_dir(source).map_err(|_| json_error())? {
    let entry = entry.map_err(|_| json_error())?;
    let ty = entry.file_type().map_err(|_| json_error())?;
    if ty.is_symlink() {
      return Err(json_error());
    }
    let destination = target.join(entry.file_name());
    if ty.is_dir() {
      copy_tree(&entry.path(), &destination)?;
    } else if ty.is_file() {
      fs::copy(entry.path(), destination).map_err(|_| json_error())?;
    }
  }
  Ok(())
}

fn stage_json<T: Serialize>(staging: &Path, relative: &Path, value: &T) -> Result<(), String> {
  let path = staging.join(relative);
  fs::create_dir_all(path.parent().ok_or_else(json_error)?).map_err(|_| json_error())?;
  fs::write(
    path,
    serde_json::to_vec_pretty(value).map_err(|_| json_error())?,
  )
  .map_err(|_| json_error())
}

fn commit(staging: &Path, target: &Path, relative: &Path) -> Result<(), String> {
  let from = staging.join(relative);
  let to = target.join(relative);
  fs::create_dir_all(to.parent().ok_or_else(json_error)?).map_err(|_| json_error())?;
  if from.is_file() {
    crate::app_auto_updater::atomic_replace(&from, &to).map_err(|_| json_error())
  } else {
    fs::rename(from, to).map_err(|_| json_error())
  }
}

fn preview_from_paths(source: &Path, target: &Path) -> Result<MigrationPreview, String> {
  if !source.exists() {
    return Ok(MigrationPreview {
      available: false,
      source_path: source.display().to_string(),
      counts: MigrationCounts::default(),
      conflicts: Vec::new(),
    });
  }
  let profiles = read_profiles(source)?;
  let proxies: Vec<StoredProxy> = list_json(&source.join("proxies"))?;
  let groups: Vec<ProfileGroup> = read_groups(&source.join("data/groups.json"))?;
  let extensions = read_extensions(source)?;
  let extension_groups: Vec<ExtensionGroup> =
    read_groups(&source.join("data/extension_groups.json"))?;
  let target_profiles = read_profiles(target)?;
  let target_proxies: Vec<StoredProxy> = list_json(&target.join("proxies"))?;
  let target_groups: Vec<ProfileGroup> = read_groups(&target.join("data/groups.json"))?;
  let target_extensions = read_extensions(target)?;
  let target_extension_groups: Vec<ExtensionGroup> =
    read_groups(&target.join("data/extension_groups.json"))?;
  let mut conflicts = Vec::new();
  conflicts.extend(
    profiles
      .iter()
      .filter(|source| {
        target_profiles.iter().any(|target| {
          target.0.id == source.0.id || target.0.name.eq_ignore_ascii_case(&source.0.name)
        })
      })
      .map(|v| format!("profile:{}", v.0.id)),
  );
  conflicts.extend(
    proxies
      .iter()
      .filter(|source| !source.is_cloud_managed && !source.is_cloud_derived)
      .filter(|source| {
        target_proxies
          .iter()
          .any(|target| target.id == source.id || target.name.eq_ignore_ascii_case(&source.name))
      })
      .map(|v| format!("proxy:{}", v.id)),
  );
  conflicts.extend(
    groups
      .iter()
      .filter(|source| {
        target_groups
          .iter()
          .any(|target| target.id == source.id || target.name.eq_ignore_ascii_case(&source.name))
      })
      .map(|v| format!("group:{}", v.id)),
  );
  conflicts.extend(
    extensions
      .iter()
      .filter(|source| {
        target_extensions.iter().any(|target| {
          target.0.id == source.0.id || target.0.name.eq_ignore_ascii_case(&source.0.name)
        })
      })
      .map(|v| format!("extension:{}", v.0.id)),
  );
  conflicts.extend(
    extension_groups
      .iter()
      .filter(|source| {
        target_extension_groups
          .iter()
          .any(|target| target.id == source.id || target.name.eq_ignore_ascii_case(&source.name))
      })
      .map(|v| format!("extension-group:{}", v.id)),
  );
  Ok(MigrationPreview {
    available: true,
    source_path: source.display().to_string(),
    counts: MigrationCounts {
      profiles: profiles.len(),
      proxies: proxies
        .iter()
        .filter(|p| !p.is_cloud_managed && !p.is_cloud_derived)
        .count(),
      groups: groups.len(),
      extensions: extensions.len(),
    },
    conflicts,
  })
}

fn migrate_from_paths(
  source: &Path,
  target: &Path,
  selection: &MigrationSelection,
) -> Result<MigrationResult, String> {
  if !source.is_dir() || source == target {
    return Err(json_error());
  }
  fs::create_dir_all(target).map_err(|_| json_error())?;
  let staging = target.join(format!(
    ".legacy-migration-staging-{}",
    uuid::Uuid::new_v4()
  ));
  fs::create_dir(&staging).map_err(|_| json_error())?;
  let result = (|| {
    let source_proxies: Vec<StoredProxy> = list_json(&source.join("proxies"))?;
    let target_proxies: Vec<StoredProxy> = list_json(&target.join("proxies"))?;
    let source_groups: Vec<ProfileGroup> = read_groups(&source.join("data/groups.json"))?;
    let target_groups: Vec<ProfileGroup> = read_groups(&target.join("data/groups.json"))?;
    let source_ext_groups: Vec<ExtensionGroup> =
      read_groups(&source.join("data/extension_groups.json"))?;
    let target_ext_groups: Vec<ExtensionGroup> =
      read_groups(&target.join("data/extension_groups.json"))?;
    let source_extensions = read_extensions(source)?;
    let target_extensions = read_extensions(target)?;
    let profiles = read_profiles(source)?;
    let target_profiles = read_profiles(target)?;
    let mut copied = 0;
    let mut skipped = 0;
    let failed = 0;
    let mut notes = Vec::new();

    let mut proxy_map = existing_names(&target_proxies, |p| (&p.id, &p.name));
    let target_proxy_ids: HashSet<_> = target_proxies.iter().map(|p| p.id.clone()).collect();
    for mut proxy in source_proxies {
      if proxy.is_cloud_managed || proxy.is_cloud_derived {
        skipped += 1;
        notes.push(format!("proxy:{}:cloud-skipped", proxy.id));
        continue;
      }
      if let Some(id) = proxy_map.get(&proxy.name.to_lowercase()) {
        proxy_map.insert(proxy.id, id.clone());
        skipped += 1;
        continue;
      }
      if !selection.proxies || target_proxy_ids.contains(&proxy.id) {
        skipped += 1;
        continue;
      }
      let old_id = proxy.id.clone();
      proxy.sync_enabled = false;
      proxy.last_sync = None;
      stage_json(
        &staging,
        &PathBuf::from(format!("proxies/{}.json", proxy.id)),
        &proxy,
      )?;
      proxy_map.insert(old_id, proxy.id.clone());
      copied += 1;
    }

    let mut group_map = existing_names(&target_groups, |g| (&g.id, &g.name));
    let target_group_ids: HashSet<_> = target_groups.iter().map(|g| g.id.clone()).collect();
    let mut groups_to_add = Vec::new();
    for mut group in source_groups {
      if let Some(id) = group_map.get(&group.name.to_lowercase()) {
        group_map.insert(group.id, id.clone());
        skipped += 1;
        continue;
      }
      if !selection.groups || target_group_ids.contains(&group.id) {
        skipped += 1;
        continue;
      }
      group.sync_enabled = false;
      group.last_sync = None;
      group_map.insert(group.id.clone(), group.id.clone());
      groups_to_add.push(group);
      copied += 1;
    }
    if !groups_to_add.is_empty() {
      let mut all = target_groups;
      all.extend(groups_to_add);
      stage_json(
        &staging,
        Path::new("data/groups.json"),
        &Groups { groups: all },
      )?;
    }

    let mut extension_map = existing_names(
      &target_extensions
        .iter()
        .map(|v| v.0.clone())
        .collect::<Vec<_>>(),
      |e| (&e.id, &e.name),
    );
    let target_extension_ids: HashSet<_> =
      target_extensions.iter().map(|v| v.0.id.clone()).collect();
    for (mut extension, path) in source_extensions {
      if let Some(id) = extension_map.get(&extension.name.to_lowercase()) {
        extension_map.insert(extension.id, id.clone());
        skipped += 1;
        continue;
      }
      if !selection.extensions || target_extension_ids.contains(&extension.id) {
        skipped += 1;
        continue;
      }
      if extension.linked_path.is_some() {
        skipped += 1;
        notes.push(format!("extension:{}:linked-skipped", extension.id));
        continue;
      }
      extension.sync_enabled = false;
      extension.last_sync = None;
      let relative = PathBuf::from(format!("extensions/{}", extension.id));
      copy_tree(&path, &staging.join(&relative))?;
      stage_json(&staging, &relative.join("metadata.json"), &extension)?;
      extension_map.insert(extension.id.clone(), extension.id.clone());
      copied += 1;
    }

    let mut ext_group_map = existing_names(&target_ext_groups, |g| (&g.id, &g.name));
    let target_ext_group_ids: HashSet<_> = target_ext_groups.iter().map(|g| g.id.clone()).collect();
    let mut ext_groups_to_add = Vec::new();
    for mut group in source_ext_groups {
      if let Some(id) = ext_group_map.get(&group.name.to_lowercase()) {
        ext_group_map.insert(group.id, id.clone());
        skipped += 1;
        continue;
      }
      if !selection.extensions || target_ext_group_ids.contains(&group.id) {
        skipped += 1;
        continue;
      }
      group.extension_ids = group
        .extension_ids
        .into_iter()
        .filter_map(|id| extension_map.get(&id).cloned())
        .collect();
      group.sync_enabled = false;
      group.last_sync = None;
      ext_group_map.insert(group.id.clone(), group.id.clone());
      ext_groups_to_add.push(group);
      copied += 1;
    }
    if !ext_groups_to_add.is_empty() {
      let mut all = target_ext_groups;
      all.extend(ext_groups_to_add);
      stage_json(
        &staging,
        Path::new("data/extension_groups.json"),
        &Groups { groups: all },
      )?;
    }

    let target_profile_ids: HashSet<_> = target_profiles.iter().map(|v| v.0.id).collect();
    let target_profile_names: HashSet<_> = target_profiles
      .iter()
      .map(|v| v.0.name.to_lowercase())
      .collect();
    for (mut profile, path) in profiles {
      if !selection.profiles
        || target_profile_ids.contains(&profile.id)
        || target_profile_names.contains(&profile.name.to_lowercase())
      {
        skipped += 1;
        continue;
      }
      profile.process_id = None;
      profile.last_launch = None;
      profile.last_sync = None;
      profile.sync_mode = SyncMode::Disabled;
      profile.created_by_id = None;
      profile.created_by_email = None;
      profile.vpn_id = None;
      profile.proxy_id = profile.proxy_id.and_then(|id| proxy_map.get(&id).cloned());
      profile.group_id = profile.group_id.and_then(|id| group_map.get(&id).cloned());
      profile.extension_group_id = profile
        .extension_group_id
        .and_then(|id| ext_group_map.get(&id).cloned());
      let relative = PathBuf::from(format!("profiles/{}", profile.id));
      copy_tree(&path, &staging.join(&relative))?;
      stage_json(&staging, &relative.join("metadata.json"), &profile)?;
      copied += 1;
    }

    for top in ["proxies", "extensions", "profiles"] {
      let dir = staging.join(top);
      if dir.exists() {
        for entry in fs::read_dir(&dir).map_err(|_| json_error())? {
          let name = entry.map_err(|_| json_error())?.file_name();
          commit(&staging, target, &PathBuf::from(top).join(name))?;
        }
      }
    }
    for file in ["data/groups.json", "data/extension_groups.json"] {
      if staging.join(file).exists() {
        commit(&staging, target, Path::new(file))?;
      }
    }
    let report_dir = target.join("data/migration-reports");
    fs::create_dir_all(&report_dir).map_err(|_| json_error())?;
    let report_path = report_dir.join(format!("legacy-{}.json", uuid::Uuid::new_v4()));
    let report = MigrationReport {
      copied,
      skipped,
      failed,
      notes,
    };
    fs::write(
      &report_path,
      serde_json::to_vec_pretty(&report).map_err(|_| json_error())?,
    )
    .map_err(|_| json_error())?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&report_path, fs::Permissions::from_mode(0o600))
        .map_err(|_| json_error())?;
    }
    Ok(MigrationResult {
      copied,
      skipped,
      failed,
      report_path: report_path.display().to_string(),
    })
  })();
  let _ = fs::remove_dir_all(&staging);
  result
}

fn legacy_source() -> Result<PathBuf, String> {
  #[cfg(target_os = "macos")]
  {
    return dirs::home_dir()
      .map(|p| p.join("Library/Application Support/DonutBrowser"))
      .ok_or_else(json_error);
  }
  #[cfg(target_os = "windows")]
  {
    return std::env::var_os("LOCALAPPDATA")
      .map(PathBuf::from)
      .map(|p| p.join("DonutBrowser"))
      .ok_or_else(json_error);
  }
  #[allow(unreachable_code)]
  Err(json_error())
}

#[tauri::command]
pub fn preview_legacy_donut_migration() -> Result<MigrationPreview, String> {
  preview_from_paths(&legacy_source()?, &crate::app_dirs::data_dir())
}

#[tauri::command]
pub fn migrate_legacy_donut_data(selection: MigrationSelection) -> Result<MigrationResult, String> {
  let target = crate::app_dirs::data_dir();
  let result = migrate_from_paths(&legacy_source()?, &target, &selection)?;
  for proxy in list_json::<StoredProxy>(&target.join("proxies"))? {
    crate::proxy_manager::PROXY_MANAGER.upsert_stored_proxy(proxy);
  }
  for event in [
    "profiles-changed",
    "proxies-changed",
    "groups-changed",
    "extensions-changed",
  ] {
    let _ = crate::events::emit_empty(event);
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  use tempfile::TempDir;
  fn write_json(path: &Path, value: serde_json::Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
  }
  #[test]
  fn migration_is_copy_only_sanitized_conflict_safe_and_idempotent() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("legacy");
    let target = temp.path().join("don");
    let profile_id = uuid::Uuid::new_v4().to_string();
    write_json(
      &source.join(format!("profiles/{profile_id}/metadata.json")),
      json!({"id":profile_id,"name":"Legacy","browser":"chrome","version":"1","process_id":42,"last_launch":7,"last_sync":8,"sync_mode":"Regular","encryption_salt":"keep-me","proxy_id":"missing","group_id":"missing","extension_group_id":"missing","created_by_id":"cloud","created_by_email":"x@y.z"}),
    );
    fs::create_dir_all(source.join(format!("profiles/{profile_id}/profile"))).unwrap();
    fs::write(
      source.join(format!("profiles/{profile_id}/profile/Cookies")),
      b"browser",
    )
    .unwrap();
    write_json(
      &source.join("settings/settings.json"),
      json!({"token":"secret"}),
    );
    write_json(
      &source.join("proxies/source.json"),
      json!({"id":"source","name":"Same","proxy_settings":{"proxy_type":"http","host":"legacy","port":80}}),
    );
    write_json(
      &target.join("proxies/existing.json"),
      json!({"id":"existing","name":"Same","proxy_settings":{"proxy_type":"http","host":"target","port":81}}),
    );
    let source_snapshot =
      fs::read(source.join(format!("profiles/{profile_id}/metadata.json"))).unwrap();
    let selection = MigrationSelection {
      profiles: true,
      proxies: true,
      groups: true,
      extensions: true,
    };
    let first = migrate_from_paths(&source, &target, &selection).unwrap();
    assert!(first.copied >= 1);
    assert_eq!(
      fs::read(source.join(format!("profiles/{profile_id}/metadata.json"))).unwrap(),
      source_snapshot
    );
    assert!(!target.join("settings").exists());
    let migrated: serde_json::Value =
      read_json(&target.join(format!("profiles/{profile_id}/metadata.json"))).unwrap();
    for field in [
      "process_id",
      "last_launch",
      "last_sync",
      "proxy_id",
      "group_id",
      "extension_group_id",
      "created_by_id",
      "created_by_email",
    ] {
      assert!(migrated[field].is_null(), "{field}");
    }
    assert_eq!(migrated["sync_mode"], "Disabled");
    assert_eq!(migrated["encryption_salt"], "keep-me");
    assert!(fs::read_to_string(target.join("proxies/existing.json"))
      .unwrap()
      .contains("target"));
    assert!(!target.join("proxies/source.json").exists());
    let second = migrate_from_paths(&source, &target, &selection).unwrap();
    assert_eq!(second.copied, 0);
    assert!(second.skipped >= 1);
    assert!(fs::read_dir(&target).unwrap().all(|e| !e
      .unwrap()
      .file_name()
      .to_string_lossy()
      .starts_with(".legacy-migration-staging")));
  }

  #[test]
  fn validation_failure_removes_staging_without_touching_target() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("legacy");
    let target = temp.path().join("don");
    fs::create_dir_all(source.join("extensions/bad")).unwrap();
    fs::write(source.join("extensions/bad/metadata.json"), b"not json").unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("sentinel"), b"unchanged").unwrap();

    assert!(migrate_from_paths(&source, &target, &MigrationSelection::default()).is_err());
    assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"unchanged");
    assert!(fs::read_dir(&target).unwrap().all(|entry| !entry
      .unwrap()
      .file_name()
      .to_string_lossy()
      .starts_with(".legacy-migration-staging")));
  }

  #[test]
  fn preview_reports_group_name_conflicts() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("legacy");
    let target = temp.path().join("don");
    write_json(
      &source.join("data/groups.json"),
      json!({"groups":[{"id":"legacy-group","name":"Shared"}]}),
    );
    write_json(
      &target.join("data/groups.json"),
      json!({"groups":[{"id":"don-group","name":"shared"}]}),
    );

    let preview = preview_from_paths(&source, &target).unwrap();

    assert_eq!(preview.conflicts, vec!["group:legacy-group"]);
  }
}
