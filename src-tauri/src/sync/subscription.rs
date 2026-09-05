use crate::events;
use crate::settings_manager::SettingsManager;
use reqwest::Client;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;

// Held through startup/restart so overlapping requests cannot orphan a pipeline.
pub(crate) static GLOBAL_SUBSCRIPTION: tokio::sync::Mutex<Option<SubscriptionManager>> =
  tokio::sync::Mutex::const_new(None);

#[derive(Debug, Clone, Deserialize)]
pub struct SubscribeEvent {
  #[serde(rename = "type")]
  pub event_type: String,
  pub key: Option<String>,
  #[serde(rename = "lastModified")]
  pub last_modified: Option<String>,
  pub size: Option<u64>,
}

#[derive(Debug, Clone)]
pub enum SyncWorkItem {
  Profile(String),
  Proxy(String),
  Group(String),
  Vpn(String),
  Extension(String),
  ExtensionGroup(String),
  Tombstone(String, String),
}

/// Where a subscription's sync token comes from, so reconnects can re-fetch a
/// fresh one (tokens are short-lived, ~15 min).
#[derive(Clone, Copy)]
enum TokenSource {
  Cloud,
  SelfHosted,
}

pub struct SyncSubscription {
  client: Client,
  base_url: String,
  token: String,
  source: TokenSource,
  running: Arc<AtomicBool>,
  work_tx: mpsc::UnboundedSender<SyncWorkItem>,
  task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for SyncSubscription {
  fn drop(&mut self) {
    self.running.store(false, Ordering::SeqCst);
    if let Some(task) = &self.task {
      task.abort();
    }
  }
}

impl SyncSubscription {
  fn new(
    base_url: String,
    token: String,
    source: TokenSource,
    work_tx: mpsc::UnboundedSender<SyncWorkItem>,
  ) -> Self {
    Self {
      client: Client::new(),
      base_url: base_url.trim_end_matches('/').to_string(),
      token,
      source,
      running: Arc::new(AtomicBool::new(false)),
      work_tx,
      task: None,
    }
  }

  pub async fn create_from_settings(
    app_handle: &tauri::AppHandle,
    work_tx: mpsc::UnboundedSender<SyncWorkItem>,
  ) -> Result<Option<Self>, String> {
    // Cloud auth takes priority
    if crate::cloud_auth::CLOUD_AUTH.is_logged_in().await {
      let url = crate::cloud_auth::CLOUD_SYNC_URL.to_string();
      let token = crate::cloud_auth::CLOUD_AUTH
        .get_or_refresh_sync_token()
        .await
        .map_err(|e| format!("Failed to get cloud sync token: {e}"))?;
      let Some(token) = token else {
        return Ok(None);
      };
      return Ok(Some(Self::new(url, token, TokenSource::Cloud, work_tx)));
    }

    // Fall back to self-hosted settings
    let manager = SettingsManager::instance();
    let settings = manager.load_settings().unwrap_or_default();

    let server_url = settings
      .sync_server_url
      .unwrap_or_else(|| crate::settings_manager::DEFAULT_DON_SYNC_URL.to_string());

    let token = manager
      .get_sync_token(app_handle)
      .await
      .ok()
      .flatten()
      .unwrap_or_else(|| crate::settings_manager::DEFAULT_DON_SYNC_TOKEN.to_string());

    Ok(Some(Self::new(
      server_url,
      token,
      TokenSource::SelfHosted,
      work_tx,
    )))
  }

  pub fn is_running(&self) -> bool {
    self.running.load(Ordering::SeqCst)
  }

  pub async fn stop(&mut self) {
    self.running.store(false, Ordering::SeqCst);
    if let Some(task) = self.task.take() {
      task.abort();
      // Release the socket and sender before a replacement can start.
      let _ = task.await;
    }
  }

  pub async fn start(&mut self, app_handle: tauri::AppHandle) {
    if self.running.swap(true, Ordering::SeqCst) {
      return;
    }

    let running = self.running.clone();
    let base_url = self.base_url.clone();
    let source = self.source;
    let work_tx = self.work_tx.clone();
    let client = self.client.clone();
    let mut token = self.token.clone();

    self.task = Some(tokio::spawn(async move {
      while running.load(Ordering::SeqCst) {
        match Self::connect_and_listen(&client, &base_url, &token, &work_tx, &running).await {
          Ok(()) => {
            log::info!("SSE connection closed gracefully");
          }
          Err(e) => {
            log::warn!("SSE connection error: {e}, reconnecting in 5s");
            sleep(Duration::from_secs(5)).await;
          }
        }

        if running.load(Ordering::SeqCst) {
          sleep(Duration::from_secs(1)).await;
          // Refresh the sync token before reconnecting. The token may have
          // expired while the stream was open (tokens last ~15 min); reusing
          // the construction-time token otherwise produces an endless 401
          // reconnect loop until the app is restarted.
          match Self::fetch_sync_token(source, &app_handle).await {
            Ok(Some(fresh)) => token = fresh,
            Ok(None) => {
              log::info!("Sync token no longer available; stopping subscription");
              break;
            }
            Err(e) => {
              log::warn!("Failed to refresh sync token: {e}; retrying with the current token");
            }
          }
        }
      }

      running.store(false, Ordering::SeqCst);
      log::info!("Sync subscription stopped");
    }));
  }

  /// Fetch a current sync token from the same source the subscription was
  /// created from, so reconnects never reuse a stale (expired) token.
  async fn fetch_sync_token(
    source: TokenSource,
    app_handle: &tauri::AppHandle,
  ) -> Result<Option<String>, String> {
    match source {
      TokenSource::Cloud => crate::cloud_auth::CLOUD_AUTH
        .get_or_refresh_sync_token()
        .await
        .map_err(|e| format!("Failed to refresh cloud sync token: {e}")),
      TokenSource::SelfHosted => {
        let token = SettingsManager::instance()
          .get_sync_token(app_handle)
          .await
          .ok()
          .flatten()
          .unwrap_or_else(|| crate::settings_manager::DEFAULT_DON_SYNC_TOKEN.to_string());
        Ok(Some(token))
      }
    }
  }

  async fn connect_and_listen(
    client: &Client,
    base_url: &str,
    token: &str,
    work_tx: &mpsc::UnboundedSender<SyncWorkItem>,
    running: &Arc<AtomicBool>,
  ) -> Result<(), String> {
    let url = format!("{base_url}/v1/objects/subscribe");

    let response = client
      .get(&url)
      .header("Authorization", format!("Bearer {token}"))
      .header("Accept", "text/event-stream")
      .send()
      .await
      .map_err(|e| format!("Failed to connect to SSE: {e}"))?;

    if !response.status().is_success() {
      return Err(format!(
        "SSE connection failed with status: {}",
        response.status()
      ));
    }

    log::info!("Connected to sync subscription");
    let _ = events::emit("sync-subscription-status", "connected");

    let mut buffer = String::new();
    let mut bytes_stream = response.bytes_stream();

    use futures_util::StreamExt;

    while running.load(Ordering::SeqCst) {
      match tokio::time::timeout(Duration::from_secs(60), bytes_stream.next()).await {
        Ok(Some(Ok(bytes))) => {
          let chunk = String::from_utf8_lossy(&bytes);
          buffer.push_str(&chunk);

          while let Some(event_end) = buffer.find("\n\n") {
            let event_str = buffer[..event_end].to_string();
            buffer = buffer[event_end + 2..].to_string();

            if let Some(event) = Self::parse_sse_event(&event_str) {
              Self::handle_event(&event, work_tx);
            }
          }
        }
        Ok(Some(Err(e))) => {
          return Err(format!("SSE stream error: {e}"));
        }
        Ok(None) => {
          return Ok(());
        }
        Err(_) => {
          log::debug!("SSE timeout, continuing...");
        }
      }
    }

    Ok(())
  }

  fn parse_sse_event(event_str: &str) -> Option<SubscribeEvent> {
    let mut data_line = None;

    for line in event_str.lines() {
      if let Some(data) = line.strip_prefix("data:") {
        data_line = Some(data.trim());
      }
    }

    data_line.and_then(|data| serde_json::from_str(data).ok())
  }

  fn strip_team_prefix(key: &str) -> &str {
    if key.starts_with("teams/") {
      if let Some(rest) = key.find('/').and_then(|first_slash| {
        key[first_slash + 1..]
          .find('/')
          .map(|second_slash| first_slash + 1 + second_slash + 1)
      }) {
        return &key[rest..];
      }
    }
    key
  }

  fn handle_event(event: &SubscribeEvent, work_tx: &mpsc::UnboundedSender<SyncWorkItem>) {
    let Some(raw_key) = &event.key else {
      return;
    };

    if event.event_type == "ping" {
      return;
    }

    let key = Self::strip_team_prefix(raw_key);

    let work_item = if key.starts_with("profiles/") {
      // Match both bundle uploads (profiles/{id}.tar.gz) and delta sync updates
      // (profiles/{id}/manifest.json, profiles/{id}/files/*, profiles/{id}/metadata.json)
      let profile_id = key.strip_prefix("profiles/").and_then(|rest| {
        // profiles/{id}.tar.gz → id
        rest
          .strip_suffix(".tar.gz")
          // profiles/{id}/manifest.json → id
          .or_else(|| rest.split('/').next().filter(|s| !s.is_empty()))
      });
      profile_id.map(|s| SyncWorkItem::Profile(s.to_string()))
    } else if key.starts_with("proxies/") {
      key
        .strip_prefix("proxies/")
        .and_then(|s| s.strip_suffix(".json"))
        .map(|s| SyncWorkItem::Proxy(s.to_string()))
    } else if key.starts_with("groups/") {
      key
        .strip_prefix("groups/")
        .and_then(|s| s.strip_suffix(".json"))
        .map(|s| SyncWorkItem::Group(s.to_string()))
    } else if key.starts_with("vpns/") {
      key
        .strip_prefix("vpns/")
        .and_then(|s| s.strip_suffix(".json"))
        .map(|s| SyncWorkItem::Vpn(s.to_string()))
    } else if key.starts_with("extensions/") {
      key
        .strip_prefix("extensions/")
        .and_then(|s| s.strip_suffix(".json"))
        .map(|s| SyncWorkItem::Extension(s.to_string()))
    } else if key.starts_with("extension_groups/") {
      key
        .strip_prefix("extension_groups/")
        .and_then(|s| s.strip_suffix(".json"))
        .map(|s| SyncWorkItem::ExtensionGroup(s.to_string()))
    } else if key.starts_with("tombstones/") {
      key.strip_prefix("tombstones/").and_then(|rest| {
        if rest.starts_with("profiles/") {
          rest
            .strip_prefix("profiles/")
            .and_then(|s| s.strip_suffix(".json"))
            .map(|id| SyncWorkItem::Tombstone("profile".to_string(), id.to_string()))
        } else if rest.starts_with("proxies/") {
          rest
            .strip_prefix("proxies/")
            .and_then(|s| s.strip_suffix(".json"))
            .map(|id| SyncWorkItem::Tombstone("proxy".to_string(), id.to_string()))
        } else if rest.starts_with("groups/") {
          rest
            .strip_prefix("groups/")
            .and_then(|s| s.strip_suffix(".json"))
            .map(|id| SyncWorkItem::Tombstone("group".to_string(), id.to_string()))
        } else if rest.starts_with("vpns/") {
          rest
            .strip_prefix("vpns/")
            .and_then(|s| s.strip_suffix(".json"))
            .map(|id| SyncWorkItem::Tombstone("vpn".to_string(), id.to_string()))
        } else if rest.starts_with("extensions/") {
          rest
            .strip_prefix("extensions/")
            .and_then(|s| s.strip_suffix(".json"))
            .map(|id| SyncWorkItem::Tombstone("extension".to_string(), id.to_string()))
        } else if rest.starts_with("extension_groups/") {
          rest
            .strip_prefix("extension_groups/")
            .and_then(|s| s.strip_suffix(".json"))
            .map(|id| SyncWorkItem::Tombstone("extension_group".to_string(), id.to_string()))
        } else {
          None
        }
      })
    } else {
      None
    };

    if let Some(item) = work_item {
      log::debug!("Queueing sync work: {:?}", item);
      let _ = work_tx.send(item);
    }
  }
}

pub struct SubscriptionManager {
  subscription: Option<SyncSubscription>,
  work_tx: mpsc::UnboundedSender<SyncWorkItem>,
  work_rx: Option<mpsc::UnboundedReceiver<SyncWorkItem>>,
}

impl Default for SubscriptionManager {
  fn default() -> Self {
    Self::new()
  }
}

impl SubscriptionManager {
  pub fn new() -> Self {
    let (work_tx, work_rx) = mpsc::unbounded_channel();
    Self {
      subscription: None,
      work_tx,
      work_rx: Some(work_rx),
    }
  }

  pub fn get_work_sender(&self) -> mpsc::UnboundedSender<SyncWorkItem> {
    self.work_tx.clone()
  }

  pub fn take_work_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<SyncWorkItem>> {
    self.work_rx.take()
  }

  pub async fn start(&mut self, app_handle: tauri::AppHandle) -> Result<(), String> {
    if self.subscription.is_some() {
      return Ok(());
    }

    let subscription =
      SyncSubscription::create_from_settings(&app_handle, self.work_tx.clone()).await?;

    if let Some(mut sub) = subscription {
      sub.start(app_handle).await;
      self.subscription = Some(sub);
      log::info!("Sync subscription manager started");
    } else {
      log::debug!("Sync not configured, subscription not started");
    }

    Ok(())
  }

  pub async fn stop(&mut self) {
    if let Some(sub) = &mut self.subscription {
      sub.stop().await;
    }
    self.subscription = None;
    log::info!("Sync subscription manager stopped");
  }

  pub fn is_running(&self) -> bool {
    self.subscription.as_ref().is_some_and(|s| s.is_running())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tokio::io::{AsyncReadExt, AsyncWriteExt};
  use tokio::time::timeout;

  // Exercise the real HTTP/SSE listener without cloud credentials or a GUI.
  async fn idle_subscription() -> (
    SubscriptionManager,
    std::sync::Weak<AtomicBool>,
    tokio::task::JoinHandle<()>,
  ) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
      let (mut socket, _) = listener.accept().await.unwrap();
      let mut request = Vec::new();
      while !request.ends_with(b"\r\n\r\n") {
        request.push(socket.read_u8().await.unwrap());
      }
      socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"type\":\"change\",\"key\":\"proxies/fixture.json\"}\n\n")
        .await
        .unwrap();
      let mut remaining = Vec::new();
      socket.read_to_end(&mut remaining).await.unwrap();
    });
    let mut manager = SubscriptionManager::new();
    let mut subscription = SyncSubscription::new(
      url.clone(),
      "fixture".into(),
      TokenSource::SelfHosted,
      manager.work_tx.clone(),
    );
    subscription.running.store(true, Ordering::SeqCst);
    let running = subscription.running.clone();
    let weak = Arc::downgrade(&running);
    let client = subscription.client.clone();
    let sender = subscription.work_tx.clone();
    subscription.task = Some(tokio::spawn(async move {
      SyncSubscription::connect_and_listen(&client, &url, "fixture", &sender, &running)
        .await
        .unwrap();
    }));
    manager.subscription = Some(subscription);
    let event = timeout(
      Duration::from_secs(2),
      manager.work_rx.as_mut().unwrap().recv(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(event, SyncWorkItem::Proxy(id) if id == "fixture"));
    (manager, weak, server)
  }

  #[tokio::test]
  async fn repeated_replacement_keeps_one_idle_sse_listener() {
    let mut active: Option<SubscriptionManager> = None;
    let mut listeners = Vec::new();
    let mut servers = Vec::new();
    for _ in 0..11 {
      if let Some(mut previous) = active.take() {
        timeout(Duration::from_secs(1), previous.stop())
          .await
          .unwrap();
        assert!(!previous.is_running());
      }
      let (manager, listener, server) = idle_subscription().await;
      active = Some(manager);
      listeners.push(listener);
      servers.push(server);
    }
    let alive = listeners
      .iter()
      .filter(|listener| listener.strong_count() > 0)
      .count();
    println!("After 10 replacements: {alive} live SSE listener(s)");
    assert_eq!(alive, 1);
    active.as_mut().unwrap().stop().await;
    assert!(listeners
      .iter()
      .all(|listener| listener.strong_count() == 0));
    for server in servers {
      timeout(Duration::from_secs(1), server)
        .await
        .unwrap()
        .unwrap();
    }
  }

  #[tokio::test]
  async fn dropping_manager_closes_idle_sse_socket() {
    let (manager, listener, server) = idle_subscription().await;
    drop(manager);
    timeout(Duration::from_secs(1), server)
      .await
      .unwrap()
      .unwrap();
    assert_eq!(listener.strong_count(), 0);
  }
}
