//! Small config entities that sync whole, with no per-item switch: profile
//! statuses and profile templates.
//!
//! Each kind is one JSON file on this device and one object per entity in the
//! cloud at `<folder>/<id>.json`. Conflicts resolve on `updated_at`, last write
//! wins, as for every other config entity. A delete leaves the tombstone
//! `tombstones/<folder>/<id>.json`, and a local copy older than its tombstone
//! is removed rather than uploaded again.
//!
//! They sync whenever sync is set up: they hold no secrets, they are what
//! profiles refer to by id, and a team shares them through the owner's space.

use super::engine::SyncEngine;
use super::types::{SyncError, SyncResult};
use crate::events;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::marker::PhantomData;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConfigKind {
  Status,
  Template,
}

impl ConfigKind {
  pub const ALL: [ConfigKind; 2] = [ConfigKind::Status, ConfigKind::Template];

  /// The cloud key folder, also the tombstone folder.
  pub fn folder(self) -> &'static str {
    match self {
      ConfigKind::Status => "statuses",
      ConfigKind::Template => "templates",
    }
  }

  /// The entity type a live tombstone event carries.
  pub fn tombstone_type(self) -> &'static str {
    match self {
      ConfigKind::Status => "status",
      ConfigKind::Template => "template",
    }
  }

  pub fn from_tombstone_type(entity_type: &str) -> Option<Self> {
    Self::ALL
      .into_iter()
      .find(|kind| kind.tombstone_type() == entity_type)
  }

  pub fn from_folder(folder: &str) -> Option<Self> {
    Self::ALL.into_iter().find(|kind| kind.folder() == folder)
  }

  /// Emitted whenever the local set of this kind changes.
  pub fn changed_event(self) -> &'static str {
    match self {
      ConfigKind::Status => "profile-statuses-changed",
      ConfigKind::Template => "profile-templates-changed",
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::profile_statuses::{self, ProfileStatus};
  use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
  };
  use serde_json::json;
  use std::sync::{
    atomic::{AtomicU8, AtomicUsize, Ordering},
    Arc,
  };

  #[tokio::test]
  async fn manager_deletes_survive_failures_and_only_their_own_acknowledgement() {
    let dir = tempfile::tempdir().unwrap();
    let _data = crate::app_dirs::set_test_data_dir(dir.path().to_path_buf());
    let status = profile_statuses::create("Retry", "#112233").unwrap();
    profile_statuses::delete(&status.id).unwrap();
    let store = ProfileStatus::store();
    let original = store.pending().unwrap();
    assert_eq!(original.len(), 1);

    // Real client transport failure, before any remote acknowledgement.
    let offline = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let offline_url = format!("http://{}", offline.local_addr().unwrap());
    drop(offline);
    assert!(
      replay_deletes(&SyncEngine::new(offline_url, "local-test".into()))
        .await
        .is_err()
    );
    assert_eq!(store.pending().unwrap(), original);

    // A fresh store instance reads the same committed intent, without a queue.
    let reopened = ConfigStore::<ProfileStatus>::new("profile_statuses.json");
    assert_eq!(reopened.pending().unwrap(), original);
    assert!(reopened.list().is_empty());

    #[derive(Clone)]
    struct Server {
      id: String,
      url: String,
      remote: Arc<Mutex<Option<ProfileStatus>>>,
      tombstone: Arc<Mutex<Option<serde_json::Value>>>,
      mode: Arc<AtomicU8>,
      calls: Arc<AtomicUsize>,
      downloads: Arc<AtomicUsize>,
      entered: Arc<tokio::sync::Notify>,
      release: Arc<tokio::sync::Notify>,
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = Server {
      id: status.id.clone(),
      url: url.clone(),
      remote: Arc::new(Mutex::new(Some(status.clone()))),
      tombstone: Arc::new(Mutex::new(None)),
      mode: Arc::new(AtomicU8::new(0)),
      calls: Arc::new(AtomicUsize::new(0)),
      downloads: Arc::new(AtomicUsize::new(0)),
      entered: Arc::new(tokio::sync::Notify::new()),
      release: Arc::new(tokio::sync::Notify::new()),
    };
    let router = Router::new()
      .route(
        "/v1/objects/list",
        post(|State(state): State<Server>| async move {
          Json(json!({"objects": [{"key": format!("statuses/{}.json", state.id),
            "lastModified": "2026-01-01T00:00:00Z", "size": 1}], "isTruncated": false}))
        }),
      )
      .route(
        "/v1/objects/stat",
        post(|State(state): State<Server>, Json(input): Json<serde_json::Value>| async move {
          if input["key"].as_str().unwrap().starts_with("tombstones/") {
            // Storage completion time is deliberately later than the edit.
            Json(json!({"exists": state.tombstone.lock().unwrap().is_some(),
              "lastModified": "2286-11-20T17:46:39Z"}))
          } else {
            let remote = state.remote.lock().unwrap();
            Json(json!({"exists": remote.is_some(), "metadata": {"updated-at":
              if state.mode.load(Ordering::SeqCst) == 4 { 9999999999_u64 }
              else { remote.as_ref().map_or(0, |item| item.updated_at) }.to_string()}}))
          }
        }),
      )
      .route(
        "/v1/objects/presign-download",
        post(|State(state): State<Server>, Json(input): Json<serde_json::Value>| async move {
          state.downloads.fetch_add(1, Ordering::SeqCst);
          let path = if input["key"].as_str().unwrap().starts_with("tombstones/") { "tombstone" } else { "live" };
          Json(json!({"url": format!("{}/{path}", state.url), "expiresAt": "2099-01-01T00:00:00Z"}))
        }),
      )
      .route("/live", get(|State(state): State<Server>| async move {
        Json(state.remote.lock().unwrap().clone())
      }).put(|State(state): State<Server>, Json(item): Json<ProfileStatus>| async move {
        *state.remote.lock().unwrap() = Some(item);
        axum::http::StatusCode::OK
      }))
      .route("/tombstone", get(|State(state): State<Server>| async move {
        Json(state.tombstone.lock().unwrap().clone())
      }))
      .route("/v1/objects/presign-upload", post(|State(state): State<Server>, Json(input): Json<serde_json::Value>| async move {
        Json(json!({"url": format!("{}/live", state.url), "expiresAt": "2099-01-01T00:00:00Z", "metadata": input["metadata"]}))
      }))
      .route(
        "/v1/objects/delete",
        post(|State(state): State<Server>, Json(input): Json<serde_json::Value>| async move {
          state.calls.fetch_add(1, Ordering::SeqCst);
          let mode = state.mode.load(Ordering::SeqCst);
          if mode == 2 {
            state.entered.notify_one();
            state.release.notified().await;
          }
          let status = if mode == 1 {
            axum::http::StatusCode::SERVICE_UNAVAILABLE
          } else {
            axum::http::StatusCode::OK
          };
          let body = if mode == 1 {
            json!({"error": "Injected delete failure"})
          } else {
            if mode == 2 || mode == 3 {
              *state.remote.lock().unwrap() = None;
              *state.tombstone.lock().unwrap() = Some(json!({"deleted_at": input["deletedAt"]}));
            }
            json!({"deleted": mode != 5, "tombstoneCreated": mode != 0})
          };
          (status, Json(body))
        }),
      )
      .with_state(server.clone());
    let engine = SyncEngine::new(url, "local-test".into());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    // A partial ACK and a failed DELETE must both retain the intent and block
    // the public sync path from downloading the still-present remote object.
    for mode in [0, 1, 5, 0] {
      server.mode.store(mode, Ordering::SeqCst);
      assert!(engine
        .sync_config::<ProfileStatus>(&status.id)
        .await
        .is_err());
      engine
        .fetch_missing_configs::<ProfileStatus>()
        .await
        .unwrap();
      assert_eq!(
        server.downloads.load(Ordering::SeqCst),
        0,
        "pending deletes must not even request a download"
      );
      assert!(!profile_statuses::exists(&status.id));
      assert_eq!(store.pending().unwrap(), original);
    }

    // Force a later generation while the old request is in flight. Setup uses
    // the store's public edit transaction (as an intentional restore would).
    server.mode.store(2, Ordering::SeqCst);
    let (result, ()) = tokio::join!(replay_deletes(&engine), async {
      server.entered.notified().await;
      store
        .mutate(|items| {
          items.push(status.clone());
          Ok(())
        })
        .unwrap();
      profile_statuses::update(&status.id, "Restored", "#112233").unwrap();
      profile_statuses::delete(&status.id).unwrap();
      server.release.notify_one();
    });
    result.unwrap();
    let next = store.pending().unwrap();
    assert_eq!(next.len(), 1);
    assert_ne!(next[0].generation, original[0].generation);

    // The new intent gets its own positive acknowledgement; subsequent replay
    // is a no-op, not another DELETE/tombstone write.
    server.mode.store(3, Ordering::SeqCst);
    replay_deletes(&engine).await.unwrap();
    assert!(store.pending().unwrap().is_empty());
    let calls = server.calls.load(Ordering::SeqCst);
    replay_deletes(&engine).await.unwrap();
    assert_eq!(server.calls.load(Ordering::SeqCst), calls);

    store
      .mutate(|items| {
        items.push(status.clone());
        Ok(())
      })
      .unwrap();
    profile_statuses::delete(&status.id).unwrap();
    server.mode.store(2, Ordering::SeqCst);
    let (result, ()) = tokio::join!(replay_deletes(&engine), async {
      server.entered.notified().await;
      store
        .mutate(|items| {
          items.push(status.clone());
          Ok(())
        })
        .unwrap();
      profile_statuses::update(&status.id, "Intentional edit", "#112233").unwrap();
      server.release.notify_one();
    });
    result.unwrap();
    assert_eq!(profile_statuses::list()[0].name, "Intentional edit");
    assert!(store.pending().unwrap().is_empty());

    // Reconcile the completed tombstone, not just the ACK. The edit must
    // survive a new engine, repair the remote copy, and reach a fresh device.
    let engine = SyncEngine::new(server.url.clone(), "local-test".into());
    engine
      .sync_config::<ProfileStatus>(&status.id)
      .await
      .unwrap();
    let restored = profile_statuses::list();
    assert_eq!(
      restored.len(),
      1,
      "a delayed old tombstone must not erase the recreation"
    );
    assert_eq!(
      server.remote.lock().unwrap().as_ref().unwrap().name,
      "Intentional edit"
    );

    profile_statuses::delete(&status.id).unwrap();
    server.mode.store(4, Ordering::SeqCst);
    let calls = server.calls.load(Ordering::SeqCst);
    replay_deletes(&engine).await.unwrap();
    assert_eq!(
      server.calls.load(Ordering::SeqCst),
      calls,
      "a newer remote edit must not be deleted"
    );
    assert!(store.pending().unwrap().is_empty());
    // Switch test data roots only at the end: the existing test-dir guard
    // clears its override rather than restoring a nested previous value.
    server.mode.store(3, Ordering::SeqCst);
    let replica = tempfile::tempdir().unwrap();
    let _replica = crate::app_dirs::set_test_data_dir(replica.path().to_path_buf());
    engine
      .fetch_missing_configs::<ProfileStatus>()
      .await
      .unwrap();
    assert_eq!(profile_statuses::list()[0].name, "Intentional edit");
    task.abort();
  }
}

pub trait ConfigEntity: Serialize + DeserializeOwned + Clone + Send + Sync + 'static {
  const KIND: ConfigKind;
  fn id(&self) -> &str;
  /// Unix seconds of the last user edit.
  fn updated_at(&self) -> u64;
  fn set_updated_at(&mut self, updated_at: u64);
  fn store() -> &'static ConfigStore<Self>;
}

#[derive(Serialize, Deserialize)]
#[serde(bound = "T: Serialize + DeserializeOwned")]
struct StoreFile<T> {
  #[serde(default = "Vec::new")]
  items: Vec<T>,
  #[serde(default)]
  pending_deletes: Vec<DeleteIntent>,
  #[serde(default)]
  revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DeleteIntent {
  id: String,
  generation: String,
  updated_at: u64,
}

/// Every entity of one kind, in one JSON file in the data directory.
pub struct ConfigStore<T> {
  file_name: &'static str,
  lock: Mutex<()>,
  _kind: PhantomData<fn() -> T>,
}

impl<T: ConfigEntity> ConfigStore<T> {
  pub const fn new(file_name: &'static str) -> Self {
    Self {
      file_name,
      lock: Mutex::new(()),
      _kind: PhantomData,
    }
  }

  fn path(&self) -> std::path::PathBuf {
    crate::app_dirs::data_subdir().join(self.file_name)
  }

  fn read(&self) -> Result<StoreFile<T>, String> {
    let path = self.path();
    match std::fs::read_to_string(&path) {
      Ok(content) => serde_json::from_str::<StoreFile<T>>(&content)
        .map_err(|e| format!("{} is unreadable: {e}", self.file_name)),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StoreFile {
        items: Vec::new(),
        pending_deletes: Vec::new(),
        revision: String::new(),
      }),
      Err(e) => Err(format!("{} is unreadable: {e}", self.file_name)),
    }
  }

  fn write(&self, mut file: StoreFile<T>) -> Result<(), String> {
    file.revision = uuid::Uuid::new_v4().to_string();
    let path = self.path();
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let result = (|| -> std::io::Result<()> {
      crate::app_dirs::write_owner_only(&temporary, &json)?;
      std::fs::OpenOptions::new()
        .write(true)
        .open(&temporary)?
        .sync_all()?;
      crate::app_auto_updater::atomic_replace(&temporary, &path)?;
      #[cfg(unix)]
      if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
      }
      Ok(())
    })();
    if result.is_err() {
      let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
  }

  pub fn list(&self) -> Vec<T> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    self.read().map(|file| file.items).unwrap_or_else(|e| {
      log::warn!("Config store read failed err=\"{e}\"");
      Vec::new()
    })
  }

  pub fn get(&self, id: &str) -> Option<T> {
    self.list().into_iter().find(|item| item.id() == id)
  }

  /// Read, change and write back under one lock, so two edits cannot lose
  /// each other.
  pub fn mutate<R>(
    &self,
    change: impl FnOnce(&mut Vec<T>) -> Result<R, String>,
  ) -> Result<R, String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = self.read()?;
    let result = change(&mut file.items)?;
    // Only user mutators use this path. An intentional recreation supersedes
    // its old intent, including when both operations happen in one second.
    for intent in &file.pending_deletes {
      if let Some(item) = file.items.iter_mut().find(|item| item.id() == intent.id) {
        item.set_updated_at(item.updated_at().max(intent.updated_at.saturating_add(1)));
      }
    }
    file
      .pending_deletes
      .retain(|intent| !file.items.iter().any(|item| item.id() == intent.id));
    self.write(file)?;
    Ok(result)
  }

  fn revision(&self) -> Result<String, String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    Ok(self.read()?.revision)
  }

  fn put(&self, item: T, revision: &str) -> Result<(), String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = self.read()?;
    if file.revision != revision
      || file
        .pending_deletes
        .iter()
        .any(|intent| intent.id == item.id())
    {
      return Ok(());
    }
    match file
      .items
      .iter_mut()
      .find(|existing| existing.id() == item.id())
    {
      Some(existing) if existing.updated_at() >= item.updated_at() => return Ok(()),
      Some(existing) => *existing = item,
      None => file.items.push(item),
    }
    self.write(file)
  }

  /// Commit the disappearance and retry intent in the same atomic replacement.
  pub fn delete_local(&self, id: &str) -> Result<bool, String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = self.read()?;
    let Some(item) = file.items.iter().find(|item| item.id() == id) else {
      return Ok(false);
    };
    let updated_at = crate::proxy_manager::now_secs().max(item.updated_at());
    file.items.retain(|item| item.id() != id);
    file.pending_deletes.retain(|intent| intent.id != id);
    file.pending_deletes.push(DeleteIntent {
      id: id.to_string(),
      generation: uuid::Uuid::new_v4().to_string(),
      updated_at,
    });
    self.write(file)?;
    Ok(true)
  }

  fn pending(&self) -> Result<Vec<DeleteIntent>, String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    Ok(self.read()?.pending_deletes)
  }

  fn finish_delete(&self, intent: &DeleteIntent) -> Result<(), String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = self.read()?;
    file.pending_deletes.retain(|current| current != intent);
    self.write(file)
  }

  fn remove_remote(&self, observed: &T) -> Result<bool, String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = self.read()?;
    let before = file.items.len();
    let snapshot = serde_json::to_value(observed).map_err(|e| e.to_string())?;
    file.items.retain(|item| {
      item.id() != observed.id() || serde_json::to_value(item).ok().as_ref() != Some(&snapshot)
    });
    let removed = before != file.items.len();
    if removed {
      self.write(file)?;
    }
    Ok(removed)
  }
}

fn notify(kind: ConfigKind) {
  if let Err(e) = events::emit_empty(kind.changed_event()) {
    log::warn!(
      "Event emit failed event={} err=\"{e}\"",
      kind.changed_event()
    );
  }
}

/// After a local create or edit: tell the UI, and queue the upload.
pub fn changed_locally<T: ConfigEntity>(id: &str) {
  notify(T::KIND);
  if !crate::sync::is_sync_configured() {
    return;
  }
  if let Some(scheduler) = crate::sync::get_global_scheduler() {
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
      scheduler.queue_config_sync(T::KIND, id).await;
    });
  }
}

/// After a local delete: tell the UI, and queue the remote delete.
pub fn deleted_locally<T: ConfigEntity>(id: &str) {
  notify(T::KIND);
  if !crate::sync::is_sync_configured() {
    return;
  }
  if let Some(scheduler) = crate::sync::get_global_scheduler() {
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
      scheduler.queue_config_delete(T::KIND, id).await;
    });
  }
}

/// Every local entity id of every kind, for the upload pass at sync start.
pub fn all_local_ids() -> Vec<(ConfigKind, String)> {
  fn ids<T: ConfigEntity>() -> Vec<(ConfigKind, String)> {
    T::store()
      .list()
      .iter()
      .map(|item| (T::KIND, item.id().to_string()))
      .collect()
  }
  let mut all = ids::<crate::profile_statuses::ProfileStatus>();
  all.extend(ids::<crate::profile_templates::ProfileTemplate>());
  all
}

/// The journal, not the scheduler's memory, owns deletion retries.
pub fn has_pending_deletes() -> bool {
  !crate::profile_statuses::ProfileStatus::store()
    .pending()
    .unwrap_or_default()
    .is_empty()
    || !crate::profile_templates::ProfileTemplate::store()
      .pending()
      .unwrap_or_default()
      .is_empty()
}

pub async fn replay_deletes(engine: &SyncEngine) -> SyncResult<()> {
  let statuses = engine
    .replay_config_deletes::<crate::profile_statuses::ProfileStatus>()
    .await;
  let templates = engine
    .replay_config_deletes::<crate::profile_templates::ProfileTemplate>()
    .await;
  statuses.and(templates)
}

pub async fn sync_one(engine: &SyncEngine, kind: ConfigKind, id: &str) -> SyncResult<()> {
  match kind {
    ConfigKind::Status => {
      engine
        .sync_config::<crate::profile_statuses::ProfileStatus>(id)
        .await
    }
    ConfigKind::Template => {
      engine
        .sync_config::<crate::profile_templates::ProfileTemplate>(id)
        .await
    }
  }
}

pub async fn fetch_missing(engine: &SyncEngine) -> SyncResult<()> {
  engine
    .fetch_missing_configs::<crate::profile_statuses::ProfileStatus>()
    .await?;
  engine
    .fetch_missing_configs::<crate::profile_templates::ProfileTemplate>()
    .await
}

impl SyncEngine {
  async fn config_remote_updated_at<T: ConfigEntity>(
    &self,
    stat: &super::types::StatResponse,
    key: &str,
  ) -> SyncResult<u64> {
    if let Some(updated_at) = stat
      .metadata
      .as_ref()
      .and_then(|metadata| metadata.get("updated-at"))
      .and_then(|value| value.parse().ok())
    {
      return Ok(updated_at);
    }
    let presign = self.client.presign_download(key).await?;
    let raw = self.client.download_bytes(&presign.url).await?;
    let data =
      super::encryption::maybe_unseal_after_download(&raw).map_err(SyncError::InvalidData)?;
    let item: T =
      serde_json::from_slice(&data).map_err(|e| SyncError::SerializationError(e.to_string()))?;
    Ok(item.updated_at())
  }

  async fn config_deleted_at(&self, kind: ConfigKind, id: &str) -> SyncResult<Option<u64>> {
    let key = format!("tombstones/{}/{id}.json", kind.folder());
    if !self.client.stat(&key).await?.exists {
      return Ok(None);
    }
    let presign = self.client.presign_download(&key).await?;
    let data = self.client.download_bytes(&presign.url).await?;
    let tombstone: serde_json::Value =
      serde_json::from_slice(&data).map_err(|e| SyncError::SerializationError(e.to_string()))?;
    let deleted_at = tombstone
      .get("deleted_at")
      .or_else(|| tombstone.get("deletedAt"))
      .and_then(|value| value.as_str())
      .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
      .and_then(|value| u64::try_from(value.timestamp()).ok())
      .ok_or_else(|| SyncError::InvalidData(format!("Invalid deletion time in {key}")))?;
    Ok(Some(deleted_at))
  }

  async fn replay_config_deletes<T: ConfigEntity>(&self) -> SyncResult<()> {
    let mut failure = None;
    for intent in T::store().pending().map_err(SyncError::IoError)? {
      if let Err(e) = self.replay_config_delete::<T>(&intent).await {
        log::warn!("Config delete retry retained id={} err={e}", intent.id);
        failure = Some(e);
      }
    }
    failure.map_or(Ok(()), Err)
  }

  async fn replay_config_delete<T: ConfigEntity>(&self, intent: &DeleteIntent) -> SyncResult<()> {
    // Polls, live events and the startup download pass may overlap. Serialize
    // retries and revalidate so a completed generation is never sent twice.
    static RETRY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _retry = RETRY.lock().await;
    let store = T::store();
    if !store
      .pending()
      .map_err(SyncError::IoError)?
      .contains(intent)
    {
      return Ok(());
    }
    let key = format!("{}/{}.json", T::KIND.folder(), intent.id);
    let stat = self.client.stat(&key).await?;
    if stat.exists {
      let remote_updated_at = self.config_remote_updated_at::<T>(&stat, &key).await?;
      if remote_updated_at > intent.updated_at {
        store.finish_delete(intent).map_err(SyncError::IoError)?;
        return Ok(());
      }
    }
    // Recheck after the network await. No std mutex is held across IO.
    if !store
      .pending()
      .map_err(SyncError::IoError)?
      .contains(intent)
    {
      return Ok(());
    }
    // This API has no conditional delete/CAS: a remote edit after stat can
    // still race DELETE. Generation checks protect local state, not that
    // server-side interval.
    self.delete_config(T::KIND, intent).await?;
    store.finish_delete(intent).map_err(SyncError::IoError)
  }

  pub async fn sync_config<T: ConfigEntity>(&self, id: &str) -> SyncResult<()> {
    if let Some(intent) = T::store()
      .pending()
      .map_err(SyncError::IoError)?
      .into_iter()
      .find(|intent| intent.id == id)
    {
      self.replay_config_delete::<T>(&intent).await?;
      if T::store()
        .pending()
        .map_err(SyncError::IoError)?
        .iter()
        .any(|intent| intent.id == id)
      {
        return Ok(());
      }
    }
    let kind = T::KIND;
    let local = T::store().get(id);
    let local_updated_at = local.as_ref().map_or(0, T::updated_at);
    let remote_key = format!("{}/{id}.json", kind.folder());
    let stat = self.client.stat(&remote_key).await?;
    let remote_updated_at = if stat.exists {
      self
        .config_remote_updated_at::<T>(&stat, &remote_key)
        .await?
    } else {
      0
    };
    if self
      .config_deleted_at(kind, id)
      .await?
      .is_some_and(|deleted_at| deleted_at >= local_updated_at.max(remote_updated_at))
    {
      // Deleted elsewhere after the last edit here. Uploading it again would
      // undo that delete on every device.
      if let Some(item) = local {
        if T::store()
          .remove_remote(&item)
          .map_err(SyncError::IoError)?
        {
          notify(kind);
        }
      }
      return Ok(());
    }

    match (local, stat.exists) {
      (Some(item), true) => {
        if self.remote_wins(local_updated_at, remote_updated_at) {
          self.download_config::<T>(id).await?;
        } else if local_updated_at > remote_updated_at {
          self.upload_config(&item).await?;
        }
      }
      (Some(item), false) => self.upload_config(&item).await?,
      (None, true) => self.download_config::<T>(id).await?,
      (None, false) => {}
    }
    Ok(())
  }

  async fn upload_config<T: ConfigEntity>(&self, item: &T) -> SyncResult<()> {
    let json = serde_json::to_string_pretty(item)
      .map_err(|e| SyncError::SerializationError(e.to_string()))?;
    let remote_key = format!("{}/{}.json", T::KIND.folder(), item.id());
    self
      .upload_config_json(&remote_key, &json, item.updated_at())
      .await?;
    log::info!("{} uploaded id={}", T::KIND.tombstone_type(), item.id());
    Ok(())
  }

  async fn download_config<T: ConfigEntity>(&self, id: &str) -> SyncResult<()> {
    let revision = T::store().revision().map_err(SyncError::IoError)?;
    let remote_key = format!("{}/{id}.json", T::KIND.folder());
    let presign = self.client.presign_download(&remote_key).await?;
    let raw = self.client.download_bytes(&presign.url).await?;
    let data = super::encryption::maybe_unseal_after_download(&raw)
      .map_err(|e| SyncError::InvalidData(format!("Failed to unseal {remote_key}: {e}")))?;
    let item: T = serde_json::from_slice(&data)
      .map_err(|e| SyncError::SerializationError(format!("Failed to parse {remote_key}: {e}")))?;
    // The object's own id must be the one its key names, or a crafted object
    // could overwrite a different local entity.
    if item.id() != id {
      return Err(SyncError::InvalidData(format!(
        "{remote_key} holds a different id"
      )));
    }
    T::store()
      .put(item, &revision)
      .map_err(SyncError::InvalidData)?;
    notify(T::KIND);
    log::info!("{} downloaded id={id}", T::KIND.tombstone_type());
    Ok(())
  }

  async fn delete_config(&self, kind: ConfigKind, intent: &DeleteIntent) -> SyncResult<()> {
    let folder = kind.folder();
    let id = &intent.id;
    if self.skips_remote_write(&format!("key={folder}/{id}.json")) {
      return Err(SyncError::Cancelled);
    }
    let deleted_at = chrono::DateTime::from_timestamp(
      i64::try_from(intent.updated_at).map_err(|e| SyncError::InvalidData(e.to_string()))?,
      0,
    )
    .ok_or_else(|| SyncError::InvalidData("Invalid config deletion time".into()))?
    .to_rfc3339();
    let response = self
      .client
      .delete_at(
        &format!("{folder}/{id}.json"),
        Some(&format!("tombstones/{folder}/{id}.json")),
        deleted_at,
      )
      .await?;
    if !response.deleted || !response.tombstone_created {
      return Err(SyncError::NetworkError(format!(
        "Incomplete config delete acknowledgement for {folder}/{id}"
      )));
    }
    log::info!("{} deleted from cloud id={id}", kind.tombstone_type());
    Ok(())
  }

  /// Download every entity of this kind the cloud has and this device lacks.
  pub async fn fetch_missing_configs<T: ConfigEntity>(&self) -> SyncResult<()> {
    // Best effort for unrelated ids; failed intents still block their downloads.
    let _ = self.replay_config_deletes::<T>().await;
    let folder = T::KIND.folder();
    let prefix = format!("{folder}/");
    let local: std::collections::HashSet<String> = T::store()
      .list()
      .iter()
      .map(|item| item.id().to_string())
      .collect();
    let remote = self.client.list(&prefix).await?;
    for object in &remote.objects {
      let Some(id) = object
        .key
        .strip_prefix(&prefix)
        .and_then(|rest| rest.strip_suffix(".json"))
        .filter(|id| crate::app_dirs::is_plain_path_part(id))
      else {
        continue;
      };
      if local.contains(id)
        || T::store()
          .pending()
          .map_err(SyncError::IoError)?
          .iter()
          .any(|intent| intent.id == id)
      {
        continue;
      }
      if let Err(e) = self.sync_config::<T>(id).await {
        log::warn!(
          "Missing {} download failed id={id} err=\"{e}\"",
          T::KIND.tombstone_type()
        );
      }
    }
    Ok(())
  }
}
