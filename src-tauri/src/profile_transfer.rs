use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngExt;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

const FILE_MAGIC: &[u8; 10] = b"DONPROFILE";
const FILE_VERSION: u16 = 1;
const KDF_MEMORY_KIB: u32 = 65_536;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_PREFIX_LEN: usize = 8;
const CHUNK_SIZE: usize = 1024 * 1024;
const GCM_TAG_LEN: usize = 16;
const HEADER_LEN: usize = FILE_MAGIC.len()
  + std::mem::size_of::<u16>()
  + 4 * std::mem::size_of::<u32>()
  + SALT_LEN
  + NONCE_PREFIX_LEN
  + std::mem::size_of::<u64>();
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 200_000;
const TRANSFER_EXCLUDE_PATTERNS: &[&str] = &[
  "**/Cache/**",
  "**/Code Cache/**",
  "**/GPUCache/**",
  "**/GrShaderCache/**",
  "**/ShaderCache/**",
  "**/DawnCache/**",
  "**/DawnGraphiteCache/**",
  "**/GraphiteDawnCache/**",
  "**/DawnWebGPUCache/**",
  "**/Service Worker/CacheStorage/**",
  "**/Service Worker/ScriptCache/**",
  "**/Session Storage/**",
  "**/Sessions/**",
  "**/Sync Data/**",
  "**/blob_storage/**",
  "**/Crashpad/**",
  "**/Crash Reports/**",
  "**/BrowserMetrics/**",
  "**/BrowserMetrics*",
  "**/optimization_guide_model_store/**",
  "**/Safe Browsing/**",
  "**/component_crx_cache/**",
  "**/storage/temporary/**",
  "**/storage/default/*/cache/**",
  "**/datareporting/**",
  "**/saved-telemetry-pings/**",
  "**/sessionstore-backups/**",
  "**/sessions/**",
  "**/crashes/**",
  "**/minidumps/**",
  "**/*.tmp",
  "**/LOG",
  "**/LOG.old",
  "**/LOCK",
  "**/*-journal",
  "**/*-wal",
  "**/SingletonLock",
  "**/SingletonSocket",
  "**/SingletonCookie",
  "**/.DS_Store",
  "**/.donut-sync/**",
  "**/.last-fp-refresh",
  "Local State",
  "First Run",
  "Last Version",
  "Variations",
  "ChromeFeatureState",
  "RunningChromeVersion",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
struct TransferFile {
  path: String,
  size: u64,
  hash: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferProxy {
  name: String,
  proxy_settings: crate::browser::ProxySettings,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferPackage {
  format_version: u32,
  exported_at: String,
  source_host_os: String,
  profile: crate::profile::BrowserProfile,
  proxy: Option<TransferProxy>,
  files: Vec<TransferFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FingerprintImportMode {
  Preserve,
  Adapt,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProfileTransferImportResult {
  profile: crate::profile::BrowserProfile,
  report: crate::profile_import::report::ProfileImportReport,
}

fn version_components(version: &str) -> Vec<u64> {
  version
    .split('.')
    .map(|part| part.parse::<u64>().unwrap_or(0))
    .collect()
}

fn resolve_import_version(
  source_version: &str,
  mode: FingerprintImportMode,
  installed_versions: &[String],
) -> Option<String> {
  if installed_versions
    .iter()
    .any(|version| version == source_version)
  {
    return Some(source_version.to_string());
  }
  let source_major = source_version.split('.').next()?;
  installed_versions
    .iter()
    .filter(|version| {
      mode == FingerprintImportMode::Adapt || version.split('.').next() == Some(source_major)
    })
    .max_by_key(|version| version_components(version))
    .cloned()
}

fn unique_import_name(source_name: &str, existing_names: &HashSet<String>) -> String {
  let base = format!("{source_name} (Shared)");
  if !existing_names.contains(&base.to_lowercase()) {
    return base;
  }
  for index in 2.. {
    let candidate = format!("{source_name} (Shared {index})");
    if !existing_names.contains(&candidate.to_lowercase()) {
      return candidate;
    }
  }
  unreachable!()
}

fn prepare_imported_profile(
  mut profile: crate::profile::BrowserProfile,
  id: uuid::Uuid,
  name: String,
  version: String,
  mode: FingerprintImportMode,
  proxy_id: Option<String>,
  now: u64,
) -> crate::profile::BrowserProfile {
  profile.id = id;
  profile.name = name;
  profile.version = version;
  profile.proxy_id = proxy_id;
  profile.vpn_id = None;
  profile.launch_hook = None;
  profile.process_id = None;
  profile.last_launch = None;
  profile.group_id = None;
  profile.sync_mode = crate::profile::types::SyncMode::Disabled;
  profile.encryption_salt = None;
  profile.last_sync = None;
  profile.host_os = Some(crate::profile::types::get_host_os());
  profile.ephemeral = false;
  profile.extension_group_id = None;
  profile.created_by_id = None;
  profile.created_by_email = None;
  profile.password_protected = false;
  profile.created_at = Some(now);
  profile.updated_at = Some(now);
  if let Some(config) = profile.wayfern_config.as_mut() {
    config.proxy = None;
    if mode == FingerprintImportMode::Adapt {
      config.os = Some(crate::profile::types::get_host_os());
      config.fingerprint = None;
      config.device_preset = None;
      config.screen_max_width = None;
      config.screen_max_height = None;
      config.screen_min_width = None;
      config.screen_min_height = None;
      config.expected_device_pixel_ratio = None;
      config.geo_proxy_signature = None;
    }
  }
  profile
}

fn transfer_error(code: &str) -> String {
  serde_json::json!({ "code": code }).to_string()
}

fn transfer_error_with_params(code: &str, params: serde_json::Value) -> String {
  serde_json::json!({ "code": code, "params": params }).to_string()
}

fn transfer_failed(context: &str, error: impl std::fmt::Display) -> String {
  log::error!("Profile transfer {context}: {error}");
  transfer_error("PROFILE_TRANSFER_FAILED")
}

fn local_transfer_proxy(profile: &crate::profile::BrowserProfile) -> Option<TransferProxy> {
  let proxy_id = profile.proxy_id.as_deref()?;
  crate::proxy_manager::PROXY_MANAGER
    .get_stored_proxies()
    .into_iter()
    .find(|proxy| proxy.id == proxy_id && !proxy.is_cloud_managed && !proxy.is_cloud_derived)
    .map(|proxy| TransferProxy {
      name: proxy.name,
      proxy_settings: proxy.proxy_settings,
    })
}

fn export_profile_transfer_blocking(
  profile: crate::profile::BrowserProfile,
  destination: PathBuf,
  password: String,
  include_proxy: bool,
) -> Result<(), String> {
  if profile.ephemeral {
    return Err(transfer_error("PROFILE_EPHEMERAL"));
  }
  let profiles_dir = crate::profile::ProfileManager::instance().get_profiles_dir();
  let persisted_profile_dir = profile.get_profile_data_path(&profiles_dir);
  let decrypted_temp;
  let source_profile_dir = if profile.password_protected {
    let key = crate::profile::encryption::get_cached_key(&profile.id)
      .ok_or_else(|| transfer_error("PROFILE_LOCKED"))?;
    decrypted_temp = tempfile::tempdir()
      .map_err(|error| transfer_failed("could not create decryption scratch", error))?;
    crate::profile::encryption::decrypt_profile_dir(
      &key,
      &persisted_profile_dir,
      decrypted_temp.path(),
    )
    .map_err(|error| transfer_failed("could not decrypt protected profile", error))?;
    decrypted_temp.path()
  } else {
    persisted_profile_dir.as_path()
  };
  if !source_profile_dir.is_dir() {
    return Err(transfer_error("PROFILE_NOT_FOUND"));
  }

  crate::sync::checkpoint_sqlite_wal_files(source_profile_dir);
  crate::profile_import::os_crypt::TargetKey::ensure(source_profile_dir)
    .map_err(|error| transfer_failed("could not establish source secret key", error))?;

  let archive_temp = tempfile::tempdir()
    .map_err(|error| transfer_failed("could not create archive scratch", error))?;
  let archive_path = archive_temp.path().join("payload.zip");
  let package = TransferPackage {
    format_version: 1,
    exported_at: chrono::Utc::now().to_rfc3339(),
    source_host_os: crate::profile::types::get_host_os(),
    proxy: include_proxy
      .then(|| local_transfer_proxy(&profile))
      .flatten(),
    profile,
    files: Vec::new(),
  };
  write_transfer_archive(source_profile_dir, package, &archive_path)
    .map_err(|error| transfer_failed("archive creation failed", error))?;

  let parent = destination
    .parent()
    .filter(|path| path.is_dir())
    .ok_or_else(|| transfer_error("PROFILE_TRANSFER_DESTINATION_INVALID"))?;
  let encrypted_temp = parent.join(format!(".donprofile-{}.part", uuid::Uuid::new_v4()));
  let encryption_result = seal_file(&archive_path, &encrypted_temp, &password);
  if let Err(error) = encryption_result {
    let _ = std::fs::remove_file(&encrypted_temp);
    return Err(transfer_failed("encryption failed", error));
  }
  #[cfg(target_os = "windows")]
  if destination.exists() {
    std::fs::remove_file(&destination)
      .map_err(|error| transfer_failed("could not replace destination", error))?;
  }
  std::fs::rename(&encrypted_temp, &destination).map_err(|error| {
    let _ = std::fs::remove_file(&encrypted_temp);
    transfer_failed("could not publish encrypted profile", error)
  })?;
  Ok(())
}

#[tauri::command]
pub async fn export_profile_transfer(
  app_handle: tauri::AppHandle,
  profile_id: String,
  destination: String,
  password: String,
  include_proxy: bool,
) -> Result<(), String> {
  if password.chars().count() < 8 {
    return Err(transfer_error_with_params(
      "PASSWORD_TOO_SHORT",
      serde_json::json!({ "min": "8" }),
    ));
  }
  let profile = crate::profile::ProfileManager::instance()
    .load_profile(&profile_id)
    .map_err(|_| transfer_error("PROFILE_NOT_FOUND"))?;
  let running = crate::profile::ProfileManager::instance()
    .check_browser_status(app_handle, &profile)
    .await
    .map_err(|error| transfer_failed("could not verify browser status", error))?;
  if running {
    return Err(transfer_error("PROFILE_RUNNING"));
  }
  tokio::task::spawn_blocking(move || {
    export_profile_transfer_blocking(profile, PathBuf::from(destination), password, include_proxy)
  })
  .await
  .map_err(|error| transfer_failed("export task failed", error))?
}

fn unique_proxy_name(source_name: &str) -> String {
  let existing: HashSet<String> = crate::proxy_manager::PROXY_MANAGER
    .get_stored_proxies()
    .into_iter()
    .map(|proxy| proxy.name.to_lowercase())
    .collect();
  let base = format!("{source_name} (Shared)");
  if !existing.contains(&base.to_lowercase()) {
    return base;
  }
  for index in 2.. {
    let candidate = format!("{source_name} (Shared {index})");
    if !existing.contains(&candidate.to_lowercase()) {
      return candidate;
    }
  }
  unreachable!()
}

fn installed_wayfern_versions() -> Vec<String> {
  let registry = crate::downloaded_browsers_registry::DownloadedBrowsersRegistry::instance();
  let versions = registry.get_downloaded_versions("wayfern");
  #[cfg(feature = "e2e")]
  return versions;
  #[cfg(not(feature = "e2e"))]
  versions
    .into_iter()
    .filter(|version| registry.is_browser_downloaded("wayfern", version))
    .collect()
}

fn import_profile_transfer_blocking(
  app_handle: tauri::AppHandle,
  source: PathBuf,
  password: String,
  mode: FingerprintImportMode,
  include_proxy: bool,
) -> Result<ProfileTransferImportResult, String> {
  if !source.is_file() {
    return Err(transfer_error("PROFILE_TRANSFER_SOURCE_INVALID"));
  }
  let profiles_dir = crate::profile::ProfileManager::instance().get_profiles_dir();
  std::fs::create_dir_all(&profiles_dir)
    .map_err(|error| transfer_failed("could not create profiles directory", error))?;
  let new_id = uuid::Uuid::new_v4();
  let staging = profiles_dir.join(format!(".donprofile-import-{new_id}"));
  let staged_profile_dir = staging.join("profile");
  let encrypted_temp = tempfile::tempdir()
    .map_err(|error| transfer_failed("could not create import scratch", error))?;
  let archive_path = encrypted_temp.path().join("payload.zip");
  unseal_file(&source, &archive_path, &password)
    .map_err(|_| transfer_error("PROFILE_TRANSFER_DECRYPT_FAILED"))?;
  let package = extract_transfer_archive(&archive_path, &staged_profile_dir).map_err(|error| {
    log::warn!("Rejected profile transfer archive: {error}");
    transfer_error("PROFILE_TRANSFER_INVALID")
  })?;

  let mut imported_proxy_id: Option<String> = None;
  let import_result = (|| -> Result<ProfileTransferImportResult, String> {
    if package.profile.browser != "wayfern" {
      return Err(transfer_error("PROFILE_TRANSFER_INVALID"));
    }
    let installed = installed_wayfern_versions();
    let version =
      resolve_import_version(&package.profile.version, mode, &installed).ok_or_else(|| {
        transfer_error_with_params(
          "PROFILE_TRANSFER_BROWSER_INCOMPATIBLE",
          serde_json::json!({ "version": package.profile.version }),
        )
      })?;
    if mode == FingerprintImportMode::Preserve {
      let mismatch = package
        .profile
        .wayfern_config
        .as_ref()
        .and_then(|config| {
          crate::wayfern_manager::WayfernManager::instance().stored_fingerprint_mismatch(
            &app_handle,
            config,
            &version,
          )
        })
        .or_else(|| {
          package
            .profile
            .wayfern_config
            .is_none()
            .then(|| "fingerprint configuration is missing".to_string())
        });
      if let Some(reason) = mismatch {
        return Err(transfer_error_with_params(
          "PROFILE_TRANSFER_FINGERPRINT_INCOMPATIBLE",
          serde_json::json!({ "reason": reason }),
        ));
      }
    }

    let key_path = staged_profile_dir.join(crate::profile_import::os_crypt::KEY_FILE_NAME);
    let source_key = std::fs::read(&key_path)
      .map_err(|error| transfer_failed("source secret key is missing", error))?;
    let source_keyring = crate::profile_import::os_crypt::SourceKeyring::from_wayfern_key(
      &package.source_host_os,
      &source_key,
    )
    .map_err(|error| transfer_failed("source secret key is invalid", error))?;
    std::fs::remove_file(&key_path)
      .map_err(|error| transfer_failed("could not replace source secret key", error))?;
    let target_key = crate::profile_import::os_crypt::TargetKey::ensure(&staged_profile_dir)
      .map_err(|error| transfer_failed("could not establish recipient secret key", error))?;
    let default_dir = staged_profile_dir.join(crate::profile_import::INITIAL_PROFILE_DIR);
    if !default_dir.is_dir() {
      return Err(transfer_error("PROFILE_TRANSFER_INVALID"));
    }
    crate::profile_import::layout::normalize_network_dir(&default_dir)
      .map_err(|error| transfer_failed("network data normalization failed", error))?;
    let mut report = crate::profile_import::report::ProfileImportReport {
      bytes_copied: package.files.iter().map(|file| file.size).sum(),
      ..Default::default()
    };
    crate::profile_import::rewrite::finalize_profile(
      &default_dir,
      &source_keyring,
      &target_key,
      &mut report,
    );

    if include_proxy {
      if let Some(proxy) = package.proxy {
        let stored = crate::proxy_manager::PROXY_MANAGER
          .create_stored_proxy(
            &app_handle,
            unique_proxy_name(&proxy.name),
            proxy.proxy_settings,
          )
          .map_err(|error| {
            if error.starts_with('{') {
              error
            } else {
              transfer_failed("could not import proxy", error)
            }
          })?;
        imported_proxy_id = Some(stored.id);
      }
    }

    let existing_names = crate::profile::ProfileManager::instance()
      .list_profiles()
      .map_err(|error| transfer_failed("could not list recipient profiles", error))?
      .into_iter()
      .map(|profile| profile.name.to_lowercase())
      .collect();
    let imported_name = unique_import_name(&package.profile.name, &existing_names);
    let imported = prepare_imported_profile(
      package.profile,
      new_id,
      imported_name,
      version,
      mode,
      imported_proxy_id.clone(),
      crate::proxy_manager::now_secs(),
    );
    let metadata = serde_json::to_vec_pretty(&imported)
      .map_err(|error| transfer_failed("metadata serialization failed", error))?;
    std::fs::write(staging.join("metadata.json"), metadata)
      .map_err(|error| transfer_failed("metadata staging failed", error))?;
    std::fs::rename(&staging, profiles_dir.join(new_id.to_string()))
      .map_err(|error| transfer_failed("could not publish imported profile", error))?;
    Ok(ProfileTransferImportResult {
      profile: imported,
      report,
    })
  })();

  match import_result {
    Ok(result) => {
      crate::profile::ProfileManager::instance().rebuild_tag_suggestions();
      if let Err(error) = crate::events::emit_empty("profiles-changed") {
        log::warn!("Failed to emit profiles-changed after profile import: {error}");
      }
      Ok(result)
    }
    Err(error) => {
      let _ = std::fs::remove_dir_all(&staging);
      if let Some(proxy_id) = imported_proxy_id {
        if let Err(rollback_error) =
          crate::proxy_manager::PROXY_MANAGER.delete_stored_proxy(&app_handle, &proxy_id)
        {
          log::error!("Failed to roll back imported proxy {proxy_id}: {rollback_error}");
        }
      }
      Err(error)
    }
  }
}

#[tauri::command]
pub async fn import_profile_transfer(
  app_handle: tauri::AppHandle,
  source: String,
  password: String,
  fingerprint_mode: FingerprintImportMode,
  include_proxy: bool,
) -> Result<ProfileTransferImportResult, String> {
  if password.is_empty() {
    return Err(transfer_error("PROFILE_TRANSFER_DECRYPT_FAILED"));
  }
  tokio::task::spawn_blocking(move || {
    import_profile_transfer_blocking(
      app_handle,
      PathBuf::from(source),
      password,
      fingerprint_mode,
      include_proxy,
    )
  })
  .await
  .map_err(|error| transfer_failed("import task failed", error))?
}

fn write_transfer_archive(
  source_profile_dir: &Path,
  mut package: TransferPackage,
  archive_path: &Path,
) -> Result<TransferPackage, String> {
  package.files = collect_transfer_files(source_profile_dir)?;
  let metadata = serde_json::to_vec(&package)
    .map_err(|error| format!("failed to serialize profile-share manifest: {error}"))?;
  let file = File::create(archive_path)
    .map_err(|error| format!("failed to create profile-share archive: {error}"))?;
  let mut archive = zip::ZipWriter::new(file).set_auto_large_file();
  let base_options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
    .compression_method(zip::CompressionMethod::Deflated)
    .unix_permissions(0o600);
  archive
    .start_file("transfer.json", base_options)
    .map_err(|error| format!("failed to start profile-share manifest: {error}"))?;
  archive
    .write_all(&metadata)
    .map_err(|error| format!("failed to write profile-share manifest: {error}"))?;

  for entry in &package.files {
    let source = source_profile_dir.join(&entry.path);
    let options = base_options.large_file(entry.size >= u32::MAX as u64);
    archive
      .start_file(format!("profile/{}", entry.path), options)
      .map_err(|error| format!("failed to start profile-share entry: {error}"))?;
    let mut input = BufReader::new(
      File::open(&source)
        .map_err(|error| format!("failed to open profile file for sharing: {error}"))?,
    );
    std::io::copy(&mut input, &mut archive)
      .map_err(|error| format!("failed to archive profile file: {error}"))?;
  }
  let output = archive
    .finish()
    .map_err(|error| format!("failed to finish profile-share archive: {error}"))?;
  output
    .sync_all()
    .map_err(|error| format!("failed to flush profile-share archive: {error}"))?;
  Ok(package)
}

fn is_safe_transfer_path(path: &str) -> bool {
  if path.is_empty() || path.contains('\\') {
    return false;
  }
  let path = Path::new(path);
  !path.is_absolute()
    && path
      .components()
      .all(|component| matches!(component, Component::Normal(_)))
}

fn extract_transfer_archive(
  archive_path: &Path,
  destination_profile_dir: &Path,
) -> Result<TransferPackage, String> {
  if destination_profile_dir.exists() {
    return Err("profile-share staging directory already exists".to_string());
  }
  let file = File::open(archive_path)
    .map_err(|error| format!("failed to open profile-share archive: {error}"))?;
  let mut archive = zip::ZipArchive::new(BufReader::new(file))
    .map_err(|error| format!("profile-share payload is not a valid ZIP: {error}"))?;
  if archive.is_empty() || archive.len() > MAX_ARCHIVE_FILES + 1 {
    return Err("profile-share archive has an invalid entry count".to_string());
  }

  let package: TransferPackage = {
    let mut manifest = archive
      .by_name("transfer.json")
      .map_err(|_| "profile-share manifest is missing".to_string())?;
    if manifest.size() > 4 * 1024 * 1024 {
      return Err("profile-share manifest is too large".to_string());
    }
    let mut bytes = Vec::with_capacity(manifest.size() as usize);
    manifest
      .read_to_end(&mut bytes)
      .map_err(|error| format!("failed to read profile-share manifest: {error}"))?;
    serde_json::from_slice(&bytes)
      .map_err(|error| format!("profile-share manifest is invalid: {error}"))?
  };
  if package.format_version != 1 {
    return Err("profile-share manifest version is unsupported".to_string());
  }
  if !matches!(
    package.source_host_os.as_str(),
    "macos" | "windows" | "linux"
  ) {
    return Err("profile-share source operating system is invalid".to_string());
  }

  let mut expected = HashMap::with_capacity(package.files.len());
  let mut total_bytes = 0u64;
  for entry in &package.files {
    if !is_safe_transfer_path(&entry.path)
      || entry.hash.len() != 64
      || !entry.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
      return Err("profile-share manifest contains an invalid file".to_string());
    }
    total_bytes = total_bytes
      .checked_add(entry.size)
      .ok_or_else(|| "profile-share payload is too large".to_string())?;
    if total_bytes > MAX_ARCHIVE_BYTES || expected.insert(entry.path.as_str(), entry).is_some() {
      return Err("profile-share manifest exceeds safety limits".to_string());
    }
  }

  let mut archive_paths = HashSet::with_capacity(archive.len());
  for index in 0..archive.len() {
    let entry = archive
      .by_index(index)
      .map_err(|error| format!("failed to inspect profile-share entry: {error}"))?;
    if entry.is_dir()
      || entry.enclosed_name().is_none()
      || !archive_paths.insert(entry.name().to_string())
    {
      return Err("profile-share archive contains an invalid entry".to_string());
    }
    if entry.name() == "transfer.json" {
      continue;
    }
    let relative = entry
      .name()
      .strip_prefix("profile/")
      .filter(|path| is_safe_transfer_path(path))
      .ok_or_else(|| "profile-share archive contains an unexpected entry".to_string())?;
    let manifest_entry = expected
      .get(relative)
      .ok_or_else(|| "profile-share archive contains an undeclared file".to_string())?;
    if entry.size() != manifest_entry.size {
      return Err("profile-share entry size does not match its manifest".to_string());
    }
  }
  if archive_paths.len() != expected.len() + 1 {
    return Err("profile-share archive is missing declared files".to_string());
  }

  std::fs::create_dir_all(destination_profile_dir)
    .map_err(|error| format!("failed to create profile-share staging directory: {error}"))?;
  let extraction_result = (|| -> Result<(), String> {
    let mut extracted = HashSet::with_capacity(expected.len());
    for index in 0..archive.len() {
      let mut entry = archive
        .by_index(index)
        .map_err(|error| format!("failed to read profile-share entry: {error}"))?;
      if entry.name() == "transfer.json" {
        continue;
      }
      let relative = entry.name().strip_prefix("profile/").unwrap().to_string();
      let manifest_entry = expected.get(relative.as_str()).unwrap();
      let destination = destination_profile_dir.join(&relative);
      if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
          .map_err(|error| format!("failed to create imported profile directory: {error}"))?;
      }
      let mut output = File::create(&destination)
        .map_err(|error| format!("failed to create imported profile file: {error}"))?;
      let mut hasher = blake3::Hasher::new();
      let mut written = 0u64;
      let mut buffer = [0u8; 64 * 1024];
      loop {
        let count = entry
          .read(&mut buffer)
          .map_err(|error| format!("failed to extract profile-share entry: {error}"))?;
        if count == 0 {
          break;
        }
        written = written
          .checked_add(count as u64)
          .ok_or_else(|| "profile-share entry is too large".to_string())?;
        if written > manifest_entry.size {
          return Err("profile-share entry exceeds its declared size".to_string());
        }
        output
          .write_all(&buffer[..count])
          .map_err(|error| format!("failed to write imported profile file: {error}"))?;
        hasher.update(&buffer[..count]);
      }
      if written != manifest_entry.size
        || hasher.finalize().to_hex().as_str() != manifest_entry.hash
      {
        return Err("profile-share entry failed integrity verification".to_string());
      }
      extracted.insert(relative);
    }
    if extracted.len() != expected.len() {
      return Err("profile-share archive extraction is incomplete".to_string());
    }
    Ok(())
  })();

  if let Err(error) = extraction_result {
    let _ = std::fs::remove_dir_all(destination_profile_dir);
    return Err(error);
  }
  Ok(package)
}

fn collect_transfer_files(profile_dir: &Path) -> Result<Vec<TransferFile>, String> {
  let mut builder = globset::GlobSetBuilder::new();
  for pattern in TRANSFER_EXCLUDE_PATTERNS {
    builder.add(
      globset::Glob::new(pattern)
        .map_err(|error| format!("invalid profile-share exclude pattern: {error}"))?,
    );
  }
  let excludes = builder
    .build()
    .map_err(|error| format!("failed to build profile-share excludes: {error}"))?;
  let mut files = Vec::new();
  let mut total_bytes = 0u64;

  fn walk(
    base: &Path,
    current: &Path,
    excludes: &globset::GlobSet,
    files: &mut Vec<TransferFile>,
    total_bytes: &mut u64,
  ) -> Result<(), String> {
    let entries = std::fs::read_dir(current)
      .map_err(|error| format!("failed to read profile data: {error}"))?;
    for entry in entries {
      let entry = entry.map_err(|error| format!("failed to read profile entry: {error}"))?;
      let path = entry.path();
      let metadata = path
        .symlink_metadata()
        .map_err(|error| format!("failed to inspect profile entry: {error}"))?;
      if metadata.file_type().is_symlink() {
        continue;
      }
      let relative = path
        .strip_prefix(base)
        .map_err(|_| "failed to compute profile-share path".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
      if excludes.is_match(&relative)
        || (metadata.is_dir() && excludes.is_match(format!("{relative}/")))
      {
        continue;
      }
      if metadata.is_dir() {
        walk(base, &path, excludes, files, total_bytes)?;
        continue;
      }
      if !metadata.is_file() {
        continue;
      }

      *total_bytes = total_bytes
        .checked_add(metadata.len())
        .ok_or_else(|| "profile-share payload is too large".to_string())?;
      if *total_bytes > MAX_ARCHIVE_BYTES || files.len() >= MAX_ARCHIVE_FILES {
        return Err("profile-share payload exceeds safety limits".to_string());
      }
      let mut input = std::io::BufReader::new(
        File::open(&path)
          .map_err(|error| format!("failed to open profile file for sharing: {error}"))?,
      );
      let mut hasher = blake3::Hasher::new();
      std::io::copy(&mut input, &mut hasher)
        .map_err(|error| format!("failed to hash profile file: {error}"))?;
      files.push(TransferFile {
        path: relative,
        size: metadata.len(),
        hash: hasher.finalize().to_hex().to_string(),
      });
    }
    Ok(())
  }

  if profile_dir.exists() {
    walk(
      profile_dir,
      profile_dir,
      &excludes,
      &mut files,
      &mut total_bytes,
    )?;
  }
  files.sort_by(|left, right| left.path.cmp(&right.path));
  Ok(files)
}

struct TransferHeader {
  bytes: Vec<u8>,
  salt: [u8; SALT_LEN],
  nonce_prefix: [u8; NONCE_PREFIX_LEN],
  plaintext_len: u64,
}

fn transfer_key(password: &str, salt: &[u8; SALT_LEN]) -> Result<[u8; 32], String> {
  let params = Params::new(KDF_MEMORY_KIB, KDF_ITERATIONS, KDF_PARALLELISM, Some(32))
    .map_err(|error| format!("invalid profile-share KDF parameters: {error}"))?;
  let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
  let mut key = [0u8; 32];
  argon2
    .hash_password_into(password.as_bytes(), salt, &mut key)
    .map_err(|error| format!("profile-share key derivation failed: {error}"))?;
  Ok(key)
}

fn encode_header(
  salt: [u8; SALT_LEN],
  nonce_prefix: [u8; NONCE_PREFIX_LEN],
  plaintext_len: u64,
) -> TransferHeader {
  let mut bytes = Vec::with_capacity(HEADER_LEN);
  bytes.extend_from_slice(FILE_MAGIC);
  bytes.extend_from_slice(&FILE_VERSION.to_le_bytes());
  bytes.extend_from_slice(&KDF_MEMORY_KIB.to_le_bytes());
  bytes.extend_from_slice(&KDF_ITERATIONS.to_le_bytes());
  bytes.extend_from_slice(&KDF_PARALLELISM.to_le_bytes());
  bytes.extend_from_slice(&(CHUNK_SIZE as u32).to_le_bytes());
  bytes.extend_from_slice(&salt);
  bytes.extend_from_slice(&nonce_prefix);
  bytes.extend_from_slice(&plaintext_len.to_le_bytes());
  TransferHeader {
    bytes,
    salt,
    nonce_prefix,
    plaintext_len,
  }
}

fn decode_header(reader: &mut File) -> Result<TransferHeader, String> {
  let mut bytes = vec![0u8; HEADER_LEN];
  reader
    .read_exact(&mut bytes)
    .map_err(|_| "profile-share file header is incomplete".to_string())?;
  if &bytes[..FILE_MAGIC.len()] != FILE_MAGIC {
    return Err("profile-share file magic is invalid".to_string());
  }

  let mut offset = FILE_MAGIC.len();
  let read_u16 = |bytes: &[u8], offset: &mut usize| {
    let value = u16::from_le_bytes(bytes[*offset..*offset + 2].try_into().unwrap());
    *offset += 2;
    value
  };
  let read_u32 = |bytes: &[u8], offset: &mut usize| {
    let value = u32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap());
    *offset += 4;
    value
  };
  let version = read_u16(&bytes, &mut offset);
  let memory_kib = read_u32(&bytes, &mut offset);
  let iterations = read_u32(&bytes, &mut offset);
  let parallelism = read_u32(&bytes, &mut offset);
  let chunk_size = read_u32(&bytes, &mut offset);
  if version != FILE_VERSION
    || memory_kib != KDF_MEMORY_KIB
    || iterations != KDF_ITERATIONS
    || parallelism != KDF_PARALLELISM
    || chunk_size != CHUNK_SIZE as u32
  {
    return Err("profile-share file version is unsupported".to_string());
  }

  let salt: [u8; SALT_LEN] = bytes[offset..offset + SALT_LEN].try_into().unwrap();
  offset += SALT_LEN;
  let nonce_prefix: [u8; NONCE_PREFIX_LEN] =
    bytes[offset..offset + NONCE_PREFIX_LEN].try_into().unwrap();
  offset += NONCE_PREFIX_LEN;
  let plaintext_len = u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
  if plaintext_len == 0 || plaintext_len > MAX_ARCHIVE_BYTES {
    return Err("profile-share payload size is invalid".to_string());
  }

  Ok(TransferHeader {
    bytes,
    salt,
    nonce_prefix,
    plaintext_len,
  })
}

fn nonce_bytes(prefix: &[u8; NONCE_PREFIX_LEN], index: u32) -> [u8; 12] {
  let mut bytes = [0u8; 12];
  bytes[..NONCE_PREFIX_LEN].copy_from_slice(prefix);
  bytes[NONCE_PREFIX_LEN..].copy_from_slice(&index.to_be_bytes());
  bytes
}

fn chunk_aad(header: &[u8], index: u32, plaintext_len: u32) -> Vec<u8> {
  let mut aad = Vec::with_capacity(header.len() + 8);
  aad.extend_from_slice(header);
  aad.extend_from_slice(&index.to_le_bytes());
  aad.extend_from_slice(&plaintext_len.to_le_bytes());
  aad
}

fn seal_file(source: &Path, destination: &Path, password: &str) -> Result<(), String> {
  let mut input =
    File::open(source).map_err(|error| format!("failed to open profile-share payload: {error}"))?;
  let plaintext_len = input
    .metadata()
    .map_err(|error| format!("failed to inspect profile-share payload: {error}"))?
    .len();
  if plaintext_len == 0 || plaintext_len > MAX_ARCHIVE_BYTES {
    return Err("profile-share payload size is invalid".to_string());
  }

  let salt: [u8; SALT_LEN] = rand::rng().random();
  let nonce_prefix: [u8; NONCE_PREFIX_LEN] = rand::rng().random();
  let header = encode_header(salt, nonce_prefix, plaintext_len);
  let key = transfer_key(password, &header.salt)?;
  let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key));
  let mut output = File::create(destination)
    .map_err(|error| format!("failed to create profile-share file: {error}"))?;
  output
    .write_all(&header.bytes)
    .map_err(|error| format!("failed to write profile-share header: {error}"))?;

  let mut remaining = plaintext_len;
  let mut index = 0u32;
  while remaining > 0 {
    let plaintext_size = remaining.min(CHUNK_SIZE as u64) as usize;
    let mut plaintext = vec![0u8; plaintext_size];
    input
      .read_exact(&mut plaintext)
      .map_err(|error| format!("failed to read profile-share payload: {error}"))?;
    let aad = chunk_aad(&header.bytes, index, plaintext_size as u32);
    let ciphertext = cipher
      .encrypt(
        &Nonce::from(nonce_bytes(&header.nonce_prefix, index)),
        Payload {
          msg: &plaintext,
          aad: &aad,
        },
      )
      .map_err(|error| format!("failed to encrypt profile-share payload: {error}"))?;
    output
      .write_all(&ciphertext)
      .map_err(|error| format!("failed to write profile-share payload: {error}"))?;
    remaining -= plaintext_size as u64;
    index = index
      .checked_add(1)
      .ok_or_else(|| "profile-share payload has too many chunks".to_string())?;
  }
  output
    .sync_all()
    .map_err(|error| format!("failed to finish profile-share file: {error}"))?;
  Ok(())
}

fn unseal_file(source: &Path, destination: &Path, password: &str) -> Result<(), String> {
  let result = unseal_file_inner(source, destination, password);
  if result.is_err() {
    let _ = std::fs::remove_file(destination);
  }
  result
}

fn unseal_file_inner(source: &Path, destination: &Path, password: &str) -> Result<(), String> {
  let mut input =
    File::open(source).map_err(|error| format!("failed to open profile-share file: {error}"))?;
  let header = decode_header(&mut input)?;
  let key = transfer_key(password, &header.salt)?;
  let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key));
  let mut output = File::create(destination)
    .map_err(|error| format!("failed to create decrypted profile-share payload: {error}"))?;

  let mut remaining = header.plaintext_len;
  let mut index = 0u32;
  while remaining > 0 {
    let plaintext_size = remaining.min(CHUNK_SIZE as u64) as usize;
    let mut ciphertext = vec![0u8; plaintext_size + GCM_TAG_LEN];
    input
      .read_exact(&mut ciphertext)
      .map_err(|_| "profile-share file is truncated".to_string())?;
    let aad = chunk_aad(&header.bytes, index, plaintext_size as u32);
    let plaintext = cipher
      .decrypt(
        &Nonce::from(nonce_bytes(&header.nonce_prefix, index)),
        Payload {
          msg: &ciphertext,
          aad: &aad,
        },
      )
      .map_err(|_| "profile-share password is incorrect or file is damaged".to_string())?;
    output
      .write_all(&plaintext)
      .map_err(|error| format!("failed to write decrypted profile-share payload: {error}"))?;
    remaining -= plaintext_size as u64;
    index = index
      .checked_add(1)
      .ok_or_else(|| "profile-share payload has too many chunks".to_string())?;
  }

  let mut trailing = [0u8; 1];
  if input
    .read(&mut trailing)
    .map_err(|error| format!("failed to finish profile-share read: {error}"))?
    != 0
  {
    return Err("profile-share file contains trailing data".to_string());
  }
  output
    .sync_all()
    .map_err(|error| format!("failed to finish decrypted profile-share payload: {error}"))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn encrypted_transfer_streams_multiple_chunks_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.zip");
    let sealed = dir.path().join("profile.donprofile");
    let restored = dir.path().join("restored.zip");
    let payload: Vec<u8> = (0..1_048_593).map(|index| (index % 251) as u8).collect();
    std::fs::write(&source, &payload).unwrap();

    seal_file(&source, &sealed, "correct horse battery staple").unwrap();
    unseal_file(&sealed, &restored, "correct horse battery staple").unwrap();

    assert_eq!(std::fs::read(restored).unwrap(), payload);
  }

  #[test]
  fn failed_decryption_leaves_no_plaintext_payload() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.zip");
    let sealed = dir.path().join("profile.donprofile");
    let restored = dir.path().join("restored.zip");
    std::fs::write(&source, vec![7u8; CHUNK_SIZE + 17]).unwrap();
    seal_file(&source, &sealed, "correct password").unwrap();

    assert!(unseal_file(&sealed, &restored, "wrong password").is_err());
    assert!(
      !restored.exists(),
      "an authentication failure must remove the partial plaintext ZIP"
    );

    let mut bytes = std::fs::read(&sealed).unwrap();
    bytes.truncate(bytes.len() - 5);
    std::fs::write(&sealed, bytes).unwrap();
    assert!(unseal_file(&sealed, &restored, "correct password").is_err());
    assert!(
      !restored.exists(),
      "a truncated transfer must remove the partial plaintext ZIP"
    );
  }

  #[test]
  fn transfer_file_collection_keeps_identity_state_and_drops_volatile_files() {
    let dir = tempfile::tempdir().unwrap();
    let files = [
      ("Default/Cookies", "cookies"),
      ("Default/Secure Preferences", "extensions"),
      ("Default/Local Storage/leveldb/000003.log", "site-data"),
      ("Default/Cache/data_0", "cache"),
      ("Default/Network/Cookies-wal", "wal"),
      ("Default/Sessions/Session_1", "open-tabs"),
      ("Default/Sync Data/LevelDB/000003.log", "sync-state"),
      ("SingletonLock", "lock"),
      ("Local State", "machine-state"),
    ];
    for (relative, contents) in files {
      let path = dir.path().join(relative);
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      std::fs::write(path, contents).unwrap();
    }

    let collected = collect_transfer_files(dir.path()).unwrap();
    let paths: Vec<&str> = collected.iter().map(|file| file.path.as_str()).collect();

    assert_eq!(
      paths,
      vec![
        "Default/Cookies",
        "Default/Local Storage/leveldb/000003.log",
        "Default/Secure Preferences",
      ]
    );
    assert!(collected.iter().all(|file| file.hash.len() == 64));
  }

  #[test]
  fn transfer_archive_round_trip_verifies_manifest_and_contents() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let extracted = dir.path().join("extracted");
    let archive = dir.path().join("payload.zip");
    std::fs::create_dir_all(source.join("Default/Local Storage")).unwrap();
    std::fs::write(source.join("Default/Cookies"), b"cookie-db").unwrap();
    std::fs::write(
      source.join("Default/Local Storage/state"),
      b"persistent-state",
    )
    .unwrap();
    let profile = crate::profile::BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: "Shared identity".to_string(),
      browser: "wayfern".to_string(),
      version: "151.0.7922.72".to_string(),
      ..Default::default()
    };
    let package = TransferPackage {
      format_version: 1,
      exported_at: "2026-08-25T00:00:00Z".to_string(),
      source_host_os: "macos".to_string(),
      profile,
      proxy: None,
      files: Vec::new(),
    };

    let written = write_transfer_archive(&source, package, &archive).unwrap();
    let restored = extract_transfer_archive(&archive, &extracted).unwrap();

    assert_eq!(written.files, restored.files);
    assert_eq!(restored.profile.name, "Shared identity");
    assert_eq!(
      std::fs::read(extracted.join("Default/Cookies")).unwrap(),
      b"cookie-db"
    );
    assert_eq!(
      std::fs::read(extracted.join("Default/Local Storage/state")).unwrap(),
      b"persistent-state"
    );
  }

  fn write_test_archive(path: &Path, package: &TransferPackage, entries: &[(&str, &[u8])]) {
    let file = File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
    zip.start_file("transfer.json", options).unwrap();
    zip
      .write_all(&serde_json::to_vec(package).unwrap())
      .unwrap();
    for (name, contents) in entries {
      zip.start_file(*name, options).unwrap();
      zip.write_all(contents).unwrap();
    }
    zip.finish().unwrap();
  }

  #[test]
  fn transfer_archive_rejects_traversal_and_undeclared_entries_without_extracting() {
    let dir = tempfile::tempdir().unwrap();
    let profile = crate::profile::BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: "Shared identity".to_string(),
      browser: "wayfern".to_string(),
      version: "151.0.7922.72".to_string(),
      ..Default::default()
    };
    let mut package = TransferPackage {
      format_version: 1,
      exported_at: "2026-08-25T00:00:00Z".to_string(),
      source_host_os: "macos".to_string(),
      profile,
      proxy: None,
      files: vec![TransferFile {
        path: "../outside".to_string(),
        size: 4,
        hash: blake3::hash(b"evil").to_hex().to_string(),
      }],
    };
    let traversal_archive = dir.path().join("traversal.zip");
    let traversal_destination = dir.path().join("traversal-output");
    write_test_archive(
      &traversal_archive,
      &package,
      &[("profile/../outside", b"evil")],
    );
    assert!(extract_transfer_archive(&traversal_archive, &traversal_destination).is_err());
    assert!(!traversal_destination.exists());
    assert!(!dir.path().join("outside").exists());

    package.files.clear();
    let undeclared_archive = dir.path().join("undeclared.zip");
    let undeclared_destination = dir.path().join("undeclared-output");
    write_test_archive(
      &undeclared_archive,
      &package,
      &[("profile/Default/Cookies", b"undeclared")],
    );
    assert!(extract_transfer_archive(&undeclared_archive, &undeclared_destination).is_err());
    assert!(!undeclared_destination.exists());
  }

  #[test]
  fn preserve_requires_an_installed_matching_browser_major() {
    let installed = vec![
      "150.0.1.2".to_string(),
      "151.0.7000.1".to_string(),
      "151.0.8000.1".to_string(),
      "152.0.1.0".to_string(),
    ];
    assert_eq!(
      resolve_import_version("151.0.7922.72", FingerprintImportMode::Preserve, &installed),
      Some("151.0.8000.1".to_string())
    );
    assert_eq!(
      resolve_import_version("149.0.1.0", FingerprintImportMode::Preserve, &installed),
      None
    );
  }

  #[test]
  fn adapt_uses_the_newest_installed_browser_when_exact_is_missing() {
    let installed = vec![
      "151.0.9000.1".to_string(),
      "152.0.10.0".to_string(),
      "152.0.9.99".to_string(),
    ];
    assert_eq!(
      resolve_import_version("149.0.1.0", FingerprintImportMode::Adapt, &installed),
      Some("152.0.10.0".to_string())
    );
  }

  #[test]
  fn imported_profile_drops_device_local_references_and_transport_protection() {
    let mut profile = crate::profile::BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: "Source".to_string(),
      browser: "wayfern".to_string(),
      version: "151.0.1.0".to_string(),
      proxy_id: Some("source-proxy".to_string()),
      vpn_id: Some("source-vpn".to_string()),
      launch_hook: Some("https://example.com/hook".to_string()),
      process_id: Some(123),
      last_launch: Some(3),
      group_id: Some("source-group".to_string()),
      tags: vec!["useful".to_string()],
      note: Some("keep this".to_string()),
      sync_mode: crate::profile::types::SyncMode::Encrypted,
      encryption_salt: Some("salt".to_string()),
      last_sync: Some(4),
      host_os: Some("windows".to_string()),
      ephemeral: true,
      extension_group_id: Some("source-extension-group".to_string()),
      created_by_id: Some("source-user".to_string()),
      created_by_email: Some("source@example.com".to_string()),
      password_protected: true,
      wayfern_config: Some(crate::wayfern_manager::WayfernConfig {
        fingerprint: Some("{\"fingerprint\":{}}".to_string()),
        os: Some("windows".to_string()),
        proxy: Some("socks5://source".to_string()),
        ..Default::default()
      }),
      ..Default::default()
    };
    profile.clear_on_close = true;
    let id = uuid::Uuid::new_v4();
    let imported = prepare_imported_profile(
      profile,
      id,
      "Source (Shared)".to_string(),
      "151.0.1.0".to_string(),
      FingerprintImportMode::Preserve,
      Some("new-proxy".to_string()),
      42,
    );

    assert_eq!(imported.id, id);
    assert_eq!(imported.proxy_id.as_deref(), Some("new-proxy"));
    assert!(imported.vpn_id.is_none());
    assert!(imported.launch_hook.is_none());
    assert!(imported.process_id.is_none());
    assert!(imported.group_id.is_none());
    assert_eq!(imported.tags, vec!["useful"]);
    assert_eq!(imported.note.as_deref(), Some("keep this"));
    assert!(imported.clear_on_close);
    assert_eq!(
      imported.sync_mode,
      crate::profile::types::SyncMode::Disabled
    );
    assert!(!imported.password_protected);
    assert!(imported.encryption_salt.is_none());
    let host_os = crate::profile::types::get_host_os();
    assert_eq!(imported.host_os.as_deref(), Some(host_os.as_str()));
    let config = imported.wayfern_config.unwrap();
    assert!(config.fingerprint.is_some());
    assert_eq!(config.os.as_deref(), Some("windows"));
    assert!(config.proxy.is_none());
  }

  #[test]
  fn adapt_clears_fingerprint_and_display_constraints() {
    let profile = crate::profile::BrowserProfile {
      wayfern_config: Some(crate::wayfern_manager::WayfernConfig {
        fingerprint: Some("fingerprint".to_string()),
        device_preset: Some("iphone".to_string()),
        os: Some("ios".to_string()),
        screen_min_width: Some(300),
        screen_max_width: Some(400),
        screen_min_height: Some(600),
        screen_max_height: Some(800),
        expected_device_pixel_ratio: Some(3.0),
        geo_proxy_signature: Some("source-route".to_string()),
        ..Default::default()
      }),
      ..Default::default()
    };
    let imported = prepare_imported_profile(
      profile,
      uuid::Uuid::new_v4(),
      "Adapted".to_string(),
      "152.0.1.0".to_string(),
      FingerprintImportMode::Adapt,
      None,
      42,
    );
    let config = imported.wayfern_config.unwrap();
    let host_os = crate::profile::types::get_host_os();
    assert_eq!(config.os.as_deref(), Some(host_os.as_str()));
    assert!(config.fingerprint.is_none());
    assert!(config.device_preset.is_none());
    assert!(config.screen_min_width.is_none());
    assert!(config.screen_max_width.is_none());
    assert!(config.screen_min_height.is_none());
    assert!(config.screen_max_height.is_none());
    assert!(config.expected_device_pixel_ratio.is_none());
    assert!(config.geo_proxy_signature.is_none());
  }

  #[test]
  fn shared_profile_names_are_case_insensitively_unique() {
    let existing = HashSet::from([
      "identity (shared)".to_string(),
      "identity (shared 2)".to_string(),
    ]);
    assert_eq!(
      unique_import_name("identity", &existing),
      "identity (Shared 3)"
    );
  }
}
