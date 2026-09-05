use crate::browser_runner::BrowserRunner;
use crate::profile::BrowserProfile;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[cfg(any(target_os = "macos", test))]
fn select_new_wayfern_process(
  candidates: &[(u32, Option<u16>)],
  existing: &std::collections::HashSet<u32>,
  expected_cdp_port: u16,
) -> Option<u32> {
  candidates
    .iter()
    .find(|(pid, port)| !existing.contains(pid) && *port == Some(expected_cdp_port))
    .map(|(pid, _)| *pid)
}

#[cfg(any(target_os = "macos", test))]
fn parse_lsof_listener_pids(output: &str) -> Vec<u32> {
  let mut pids = Vec::new();
  for line in output.lines() {
    let Some(pid) = line.trim().parse::<u32>().ok().filter(|pid| *pid > 0) else {
      continue;
    };
    if !pids.contains(&pid) {
      pids.push(pid);
    }
  }
  pids
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WayfernConfig {
  #[serde(default)]
  pub fingerprint: Option<String>,
  /// Shared device preset id. The validation rules live in the frontend asset
  /// consumed by both sides, so adding a preset does not require a new Rust
  /// branch with hard-coded device values.
  #[serde(default)]
  pub device_preset: Option<String>,
  #[serde(default)]
  pub randomize_fingerprint_on_launch: Option<bool>,
  #[serde(default)]
  pub os: Option<String>,
  #[serde(default)]
  pub screen_max_width: Option<u32>,
  #[serde(default)]
  pub screen_max_height: Option<u32>,
  #[serde(default)]
  pub screen_min_width: Option<u32>,
  #[serde(default)]
  pub screen_min_height: Option<u32>,
  /// Host display scale the generated fingerprint must match (e.g. 1.5 on
  /// Windows 150%, 2.0 on macOS Retina). Mismatched DPR is the Stripe/Claude
  /// payment-iframe double-scale bug.
  #[serde(default)]
  pub expected_device_pixel_ratio: Option<f64>,
  #[serde(default)]
  pub geoip: Option<serde_json::Value>, // For compatibility with shared config form
  #[serde(default)]
  pub block_images: Option<bool>, // For compatibility with shared config form
  /// Legacy WebRTC switch. When `webrtc_mode` is absent, `true` maps to the
  /// proxy-safe mode and `false` preserves the old open behavior.
  #[serde(default)]
  pub block_webrtc: Option<bool>,
  /// WebRTC handling: `proxy`, `off`, or `real`.
  #[serde(default)]
  pub webrtc_mode: Option<String>,
  /// Opt-in software rendering fallback for Wayfern builds whose GPU process
  /// consumes excessive CPU. Hardware acceleration remains the default.
  #[serde(default)]
  pub gpu_compatibility_mode: Option<bool>,
  #[serde(default)]
  pub block_webgl: Option<bool>,
  #[serde(default, skip_serializing)]
  pub proxy: Option<String>,
  /// Stable signature of the proxy/VPN/geoip the fingerprint's location data
  /// (timezone, latitude/longitude, language) was last computed for. Compared
  /// on launch to detect that the routing changed since creation, so the
  /// location can be refreshed instead of showing stale data.
  #[serde(default)]
  pub geo_proxy_signature: Option<String>,
}

/// Max full-fingerprint regenerations when a candidate violates host constraints.
const FINGERPRINT_GENERATION_ATTEMPTS: usize = 30;
const WEBRTC_PROXY_POLICY_FLAG: &str = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
const DEVICE_PRESETS_JSON: &str = include_str!("../../src/lib/device-presets.json");

fn base_wayfern_launch_args(port: u16, profile_path: &str) -> Vec<String> {
  let base = vec![
    format!("--remote-debugging-port={port}"),
    "--remote-debugging-address=127.0.0.1".to_string(),
    format!("--user-data-dir={profile_path}"),
    format!(
      "--profile-directory={}",
      crate::profile_import::INITIAL_PROFILE_DIR
    ),
    "--no-first-run".to_string(),
    "--no-default-browser-check".to_string(),
    "--disable-background-mode".to_string(),
    "--disable-component-update".to_string(),
    "--crash-server-url=".to_string(),
    "--disable-updater".to_string(),
    "--disable-session-crashed-bubble".to_string(),
    "--hide-crash-restore-bubble".to_string(),
    "--disable-infobars".to_string(),
    // Prefetch* / NoStatePrefetch: cross-site Speculation-Rules prefetch uses
    // an isolated NetworkContext that defaults to DIRECT egress (real host IP
    // leaks past the per-profile proxy). Disabling via a LAUNCH FLAG cannot be
    // re-enabled by an imported/synced network_prediction_options pref (which a
    // compile-time pref default could be).
    "--disable-features=DialMediaRouteProvider,DnsOverHttps,AsyncDns,Prefetch,PrefetchProxy,SpeculationRulesPrefetchFuture,NoStatePrefetch".to_string(),
    "--use-mock-keychain".to_string(),
    "--password-store=basic".to_string(),
  ];
  #[cfg(target_os = "macos")]
  let args = {
    let mut v = base;
    v.push("--use-angle=default".to_string());
    v
  };
  #[cfg(not(target_os = "macos"))]
  let args = base;
  args
}

#[derive(Debug, Deserialize)]
struct DevicePresetCatalog {
  presets: Vec<DevicePreset>,
}

#[derive(Debug, Deserialize)]
struct DevicePreset {
  id: String,
  constraints: DevicePresetConstraints,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePresetConstraints {
  #[serde(default)]
  platform_values: Vec<String>,
  #[serde(default)]
  user_agent_tokens: Vec<String>,
  #[serde(default)]
  brand_tokens: Vec<String>,
  min_touch_points: Option<u32>,
  max_touch_points: Option<u32>,
  orientation: Option<String>,
  min_dpr: Option<f64>,
  max_dpr: Option<f64>,
  #[serde(default)]
  gpu_tokens: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default)]
struct FingerprintHostConstraints {
  device_pixel_ratio: Option<f64>,
  screen_max_width: Option<u32>,
  screen_max_height: Option<u32>,
  screen_available_max_width: Option<u32>,
  screen_available_max_height: Option<u32>,
}

fn device_preset(id: &str) -> Result<DevicePreset, String> {
  let catalog = serde_json::from_str::<DevicePresetCatalog>(DEVICE_PRESETS_JSON)
    .map_err(|error| format!("invalid device preset catalog: {error}"))?;
  catalog
    .presets
    .into_iter()
    .find(|preset| preset.id == id)
    .ok_or_else(|| format!("unknown device preset {id}"))
}

fn contains_all_tokens(value: &str, tokens: &[String]) -> bool {
  let value = value.to_ascii_lowercase();
  tokens
    .iter()
    .all(|token| value.contains(&token.to_ascii_lowercase()))
}

fn stored_fingerprint_compatibility_mismatch(
  fingerprint: &serde_json::Value,
  browser_version: &str,
) -> Option<String> {
  let fingerprint = fingerprint.get("fingerprint").unwrap_or(fingerprint);
  if fingerprint
    .get("deviceProfileApplied")
    .and_then(serde_json::Value::as_bool)
    != Some(true)
  {
    return Some("fingerprint predates complete device-profile application".to_string());
  }

  let major = |version: &str| version.split('.').next()?.parse::<u64>().ok();
  let fingerprint_major = fingerprint.get("brandVersion").and_then(|version| {
    version
      .as_str()
      .and_then(major)
      .or_else(|| version.as_u64())
  });
  let browser_major = major(browser_version);
  match (fingerprint_major, browser_major) {
    (Some(fingerprint_major), Some(browser_major)) if fingerprint_major != browser_major => {
      Some(format!(
        "fingerprint browser major {fingerprint_major} does not match Wayfern {browser_major}"
      ))
    }
    _ => None,
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebRtcMode {
  Proxy,
  Off,
  Real,
}

impl WayfernConfig {
  fn effective_webrtc_mode(&self) -> WebRtcMode {
    match self.webrtc_mode.as_deref() {
      Some("proxy") => WebRtcMode::Proxy,
      Some("off") => WebRtcMode::Off,
      Some("real") => WebRtcMode::Real,
      // An invalid explicit value fails closed. Legacy values remain
      // compatible when no new mode has been stored yet.
      Some(_) => WebRtcMode::Proxy,
      None => match self.block_webrtc {
        Some(true) => WebRtcMode::Proxy,
        Some(false) => WebRtcMode::Real,
        None => WebRtcMode::Proxy,
      },
    }
  }

  fn webrtc_launch_arg(&self) -> Option<&'static str> {
    match self.effective_webrtc_mode() {
      WebRtcMode::Proxy | WebRtcMode::Off => Some(WEBRTC_PROXY_POLICY_FLAG),
      WebRtcMode::Real => None,
    }
  }

  fn append_configured_launch_args(args: &mut Vec<String>, config: &WayfernConfig) {
    if let Some(flag) = config.webrtc_launch_arg() {
      args.push(flag.to_string());
    }
    if config.gpu_compatibility_mode == Some(true) {
      args.push("--disable-gpu".to_string());
    }
  }

  /// Whether a Wayfern fingerprint candidate is safe for the host display and
  /// generation bounds. Bad candidates are discarded whole — never partially
  /// patched — because setFingerprint re-normalizes inconsistent local edits.
  pub fn fingerprint_satisfies_constraints(fingerprint: &serde_json::Value) -> Result<(), String> {
    Self::fingerprint_satisfies_constraints_with(fingerprint, None)
  }

  pub fn fingerprint_satisfies_constraints_with(
    fingerprint: &serde_json::Value,
    config: Option<&WayfernConfig>,
  ) -> Result<(), String> {
    let fingerprint = fingerprint.get("fingerprint").unwrap_or(fingerprint);
    let dpr = fingerprint
      .get("devicePixelRatio")
      .and_then(|v| v.as_f64())
      .filter(|value| value.is_finite() && *value > 0.0)
      .ok_or_else(|| "missing or invalid devicePixelRatio".to_string())?;

    if let Some(expected) = config.and_then(|c| c.expected_device_pixel_ratio) {
      if (dpr - expected).abs() > 0.05 {
        return Err(format!(
          "devicePixelRatio {dpr} does not match expected {expected}"
        ));
      }
    }

    let dimension = |key: &str| -> Result<u32, String> {
      fingerprint
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0 && *value <= u64::from(u32::MAX))
        .map(|value| value as u32)
        .ok_or_else(|| format!("missing or invalid {key}"))
    };
    let screen_w = dimension("screenWidth")?;
    let screen_h = dimension("screenHeight")?;

    if let Some(max_w) = config.and_then(|c| c.screen_max_width) {
      if screen_w > max_w {
        return Err(format!("screenWidth {screen_w} exceeds max {max_w}"));
      }
    }
    if let Some(max_h) = config.and_then(|c| c.screen_max_height) {
      if screen_h > max_h {
        return Err(format!("screenHeight {screen_h} exceeds max {max_h}"));
      }
    }
    if let Some(min_w) = config.and_then(|c| c.screen_min_width) {
      if screen_w < min_w {
        return Err(format!("screenWidth {screen_w} below min {min_w}"));
      }
    }
    if let Some(min_h) = config.and_then(|c| c.screen_min_height) {
      if screen_h < min_h {
        return Err(format!("screenHeight {screen_h} below min {min_h}"));
      }
    }

    let avail_w = dimension("screenAvailWidth")?;
    let avail_h = dimension("screenAvailHeight")?;
    let outer_w = dimension("windowOuterWidth")?;
    let outer_h = dimension("windowOuterHeight")?;
    let inner_w = dimension("windowInnerWidth")?;
    let inner_h = dimension("windowInnerHeight")?;

    if avail_w > screen_w || avail_h > screen_h {
      return Err(format!(
        "available screen {avail_w}x{avail_h} exceeds full screen {screen_w}x{screen_h}"
      ));
    }
    if outer_w > avail_w || outer_h > avail_h {
      return Err(format!(
        "outer window {outer_w}x{outer_h} exceeds available screen {avail_w}x{avail_h}"
      ));
    }
    if inner_w > outer_w || inner_h > outer_h {
      return Err(format!(
        "inner window {inner_w}x{inner_h} exceeds outer window {outer_w}x{outer_h}"
      ));
    }

    if let Some(preset_id) = config.and_then(|config| config.device_preset.as_deref()) {
      let preset = device_preset(preset_id)?;
      let constraints = preset.constraints;
      let platform = fingerprint
        .get("platform")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("device preset {preset_id} requires platform"))?;
      if !constraints.platform_values.is_empty()
        && !constraints
          .platform_values
          .iter()
          .any(|value| value.eq_ignore_ascii_case(platform))
      {
        return Err(format!(
          "platform {platform} is inconsistent with device preset {preset_id}"
        ));
      }

      let user_agent = fingerprint
        .get("userAgent")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("device preset {preset_id} requires userAgent"))?;
      if !contains_all_tokens(user_agent, &constraints.user_agent_tokens) {
        return Err(format!(
          "userAgent is inconsistent with device preset {preset_id}"
        ));
      }

      let brand = fingerprint
        .get("brand")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("device preset {preset_id} requires brand"))?;
      if !contains_all_tokens(brand, &constraints.brand_tokens) {
        return Err(format!(
          "brand is inconsistent with device preset {preset_id}"
        ));
      }

      let touch_points = fingerprint
        .get("maxTouchPoints")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| format!("device preset {preset_id} requires maxTouchPoints"))?
        as u32;
      if constraints
        .min_touch_points
        .is_some_and(|minimum| touch_points < minimum)
        || constraints
          .max_touch_points
          .is_some_and(|maximum| touch_points > maximum)
      {
        return Err(format!(
          "maxTouchPoints {touch_points} is inconsistent with device preset {preset_id}"
        ));
      }

      if let Some(orientation) = constraints.orientation.as_deref() {
        let is_portrait = screen_h > screen_w;
        let matches = match orientation {
          "portrait" => is_portrait,
          "landscape" => !is_portrait,
          _ => true,
        };
        if !matches {
          return Err(format!(
            "screen orientation is inconsistent with device preset {preset_id}"
          ));
        }
      }

      if constraints
        .min_dpr
        .is_some_and(|minimum| dpr < minimum || dpr > constraints.max_dpr.unwrap_or(f64::MAX))
        || constraints.max_dpr.is_some_and(|maximum| dpr > maximum)
      {
        return Err(format!(
          "devicePixelRatio {dpr} is inconsistent with device preset {preset_id}"
        ));
      }

      let gpu = [
        fingerprint
          .get("webglVendor")
          .and_then(|value| value.as_str())
          .unwrap_or_default(),
        fingerprint
          .get("webglRenderer")
          .and_then(|value| value.as_str())
          .unwrap_or_default(),
      ]
      .join(" ");
      if !constraints.gpu_tokens.is_empty() && !contains_all_tokens(&gpu, &constraints.gpu_tokens) {
        return Err(format!(
          "GPU renderer is inconsistent with device preset {preset_id}"
        ));
      }
    }

    Ok(())
  }

  fn fingerprint_satisfies_host_constraints(
    fingerprint: &serde_json::Value,
    config: &WayfernConfig,
    host: FingerprintHostConstraints,
  ) -> Result<(), String> {
    let strictest_max = |configured: Option<u32>, live: Option<u32>| match (configured, live) {
      (Some(configured), Some(live)) => Some(configured.min(live)),
      (configured, live) => configured.or(live),
    };
    let mut resolved = config.clone();
    // Native fingerprints must match the live display scale. An explicitly
    // selected cross-OS or mobile identity keeps its simulated DPR, while its
    // browser window still has to fit within the host's logical screen bounds.
    let target_matches_host = config
      .os
      .as_deref()
      .is_none_or(|target| target == crate::profile::types::get_host_os());
    if target_matches_host {
      resolved.expected_device_pixel_ratio = host
        .device_pixel_ratio
        .or(resolved.expected_device_pixel_ratio);
    }
    resolved.screen_max_width = strictest_max(resolved.screen_max_width, host.screen_max_width);
    resolved.screen_max_height = strictest_max(resolved.screen_max_height, host.screen_max_height);

    Self::fingerprint_satisfies_constraints_with(fingerprint, Some(&resolved))?;
    let fingerprint = fingerprint.get("fingerprint").unwrap_or(fingerprint);
    let dimension = |key: &str| {
      fingerprint
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| format!("missing or invalid {key}"))
    };
    let available_width = dimension("screenAvailWidth")?;
    let available_height = dimension("screenAvailHeight")?;
    if host
      .screen_available_max_width
      .is_some_and(|maximum| available_width > maximum)
    {
      return Err(format!(
        "screenAvailWidth {available_width} exceeds display work area {}",
        host.screen_available_max_width.unwrap()
      ));
    }
    if host
      .screen_available_max_height
      .is_some_and(|maximum| available_height > maximum)
    {
      return Err(format!(
        "screenAvailHeight {available_height} exceeds display work area {}",
        host.screen_available_max_height.unwrap()
      ));
    }
    Ok(())
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct WayfernLaunchResult {
  pub id: String,
  #[serde(alias = "process_id")]
  pub processId: Option<u32>,
  #[serde(alias = "profile_path")]
  pub profilePath: Option<String>,
  pub url: Option<String>,
  pub cdp_port: Option<u16>,
  /// The fingerprint Wayfern actually applied, echoed back by
  /// Wayfern.setFingerprint. It may be UPGRADED from the stored fingerprint
  /// (e.g. when the stored one targets an older browser version). Internal
  /// only — the caller persists it to the profile; never sent to the frontend.
  #[serde(default, skip_serializing)]
  pub used_fingerprint: Option<String>,
}

struct WayfernInstance {
  id: String,
  process_id: Option<u32>,
  profile_path: Option<String>,
  url: Option<String>,
  cdp_port: Option<u16>,
}

pub(crate) struct WayfernTab {
  port: u16,
  target_id: String,
  armed: bool,
}

struct PendingWayfernTabGuard {
  port: u16,
  url: String,
  armed: bool,
}

impl PendingWayfernTabGuard {
  fn new(port: u16, url: &str) -> Self {
    Self {
      port,
      url: url.to_string(),
      armed: true,
    }
  }

  fn disarm(&mut self) {
    self.armed = false;
  }
}

impl Drop for PendingWayfernTabGuard {
  fn drop(&mut self) {
    if !self.armed {
      return;
    }
    let port = self.port;
    let url = self.url.clone();
    tauri::async_runtime::spawn(async move {
      let manager = WayfernManager::instance();
      let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
      loop {
        if manager.close_tab_by_url(port, &url).await.is_ok() {
          return;
        }
        if tokio::time::Instant::now() >= deadline {
          break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
      }
      log::warn!("Failed to reconcile dropped temporary Wayfern tab");
    });
  }
}

impl Drop for WayfernTab {
  fn drop(&mut self) {
    if !self.armed {
      return;
    }
    let port = self.port;
    let target_id = self.target_id.clone();
    tauri::async_runtime::spawn(async move {
      if let Err(error) = WayfernManager::instance()
        .close_tab_by_id(port, &target_id)
        .await
      {
        log::warn!("Failed to close dropped temporary Wayfern tab: {error}");
      }
    });
  }
}

struct WayfernManagerInner {
  instances: HashMap<String, WayfernInstance>,
}

pub struct WayfernManager {
  inner: Arc<AsyncMutex<WayfernManagerInner>>,
  http_client: Client,
}

struct SpawnedWayfernGuard {
  process_id: Option<u32>,
  launcher_process_id: Option<u32>,
  profile_path: PathBuf,
  port: u16,
  armed: bool,
}

impl SpawnedWayfernGuard {
  fn new(process_id: Option<u32>, profile_path: PathBuf, port: u16) -> Self {
    Self {
      process_id,
      launcher_process_id: None,
      profile_path,
      port,
      armed: true,
    }
  }

  fn disarm(&mut self) {
    self.armed = false;
  }
}

impl Drop for SpawnedWayfernGuard {
  fn drop(&mut self) {
    if !self.armed {
      return;
    }
    WayfernManager::terminate_process(self.process_id);
    WayfernManager::terminate_process(self.launcher_process_id);
    for (pid, _, cdp_port) in WayfernManager::find_wayfern_processes_by_profile(&self.profile_path)
    {
      if cdp_port == Some(self.port) && Some(pid) != self.process_id {
        WayfernManager::terminate_process(Some(pid));
      }
    }
  }
}

#[derive(Debug, Deserialize)]
struct CdpTarget {
  #[serde(rename = "type")]
  target_type: String,
  #[serde(rename = "webSocketDebuggerUrl")]
  websocket_debugger_url: Option<String>,
}

impl WayfernManager {
  fn new() -> Self {
    Self {
      inner: Arc::new(AsyncMutex::new(WayfernManagerInner {
        instances: HashMap::new(),
      })),
      // CDP is always on loopback. Disable env/system proxies so a Windows
      // WinHTTP/IE proxy (or HTTP_PROXY) cannot intercept /json/version and
      // return 502 Bad Gateway while the browser is actually listening.
      http_client: Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .expect("Failed to build reqwest client for wayfern_manager"),
    }
  }

  pub fn instance() -> &'static WayfernManager {
    &WAYFERN_MANAGER
  }

  #[allow(dead_code)]
  pub fn get_profiles_dir(&self) -> PathBuf {
    crate::app_dirs::profiles_dir()
  }

  #[allow(dead_code)]
  fn get_binaries_dir(&self) -> PathBuf {
    crate::app_dirs::binaries_dir()
  }

  async fn find_free_port() -> Result<u16, Box<dyn std::error::Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
  }

  fn terminate_process(process_id: Option<u32>) {
    let Some(process_id) = process_id else {
      return;
    };

    #[cfg(unix)]
    {
      use nix::sys::signal::{kill, Signal};
      use nix::unistd::Pid;
      let _ = kill(Pid::from_raw(process_id as i32), Signal::SIGTERM);
    }
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      const CREATE_NO_WINDOW: u32 = 0x08000000;
      let _ = std::process::Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    }
  }

  /// Normalize fingerprint data from Wayfern CDP format to our storage format.
  /// Wayfern returns fields like fonts, webglParameters as JSON strings which we keep as-is.
  fn normalize_fingerprint(mut fingerprint: serde_json::Value) -> serde_json::Value {
    // Our storage format matches what Wayfern returns:
    // - fonts, plugins, mimeTypes, voices are JSON strings
    // - webglParameters, webgl2Parameters, etc. are JSON strings
    // The form displays them as JSON text areas, so no conversion needed.
    if let Some(device_memory) = fingerprint.get_mut("deviceMemory") {
      *device_memory = page_visible_device_memory(device_memory);
    }
    fingerprint
  }

  /// Denormalize fingerprint data from our storage format to Wayfern CDP format.
  /// Wayfern expects certain fields as JSON strings.
  fn denormalize_fingerprint(fingerprint: serde_json::Value) -> serde_json::Value {
    // Our storage format matches what Wayfern expects:
    // - fonts, plugins, mimeTypes, voices are JSON strings
    // - webglParameters, webgl2Parameters, etc. are JSON strings
    // So no conversion is needed
    fingerprint
  }

  fn fingerprint_host_constraints(app_handle: &AppHandle) -> FingerprintHostConstraints {
    app_handle
      .primary_monitor()
      .ok()
      .flatten()
      .map(|monitor| {
        let scale_factor = monitor.scale_factor();
        let size = monitor.size();
        let work_area = monitor.work_area().size;
        FingerprintHostConstraints {
          device_pixel_ratio: Some(scale_factor),
          screen_max_width: Some((f64::from(size.width) / scale_factor).round() as u32),
          screen_max_height: Some((f64::from(size.height) / scale_factor).round() as u32),
          screen_available_max_width: Some(
            (f64::from(work_area.width) / scale_factor).round() as u32
          ),
          screen_available_max_height: Some(
            (f64::from(work_area.height) / scale_factor).round() as u32
          ),
        }
      })
      .unwrap_or_default()
  }

  pub(crate) fn stored_fingerprint_mismatch(
    &self,
    app_handle: &AppHandle,
    config: &WayfernConfig,
    browser_version: &str,
  ) -> Option<String> {
    let fingerprint_json = match config.fingerprint.as_deref().map(str::trim) {
      Some(fingerprint_json) if !fingerprint_json.is_empty() => fingerprint_json,
      _ => return Some("fingerprint is missing".to_string()),
    };
    let fingerprint = match serde_json::from_str(fingerprint_json) {
      Ok(fingerprint) => fingerprint,
      Err(error) => return Some(format!("fingerprint JSON is invalid: {error}")),
    };
    if let Some(reason) = stored_fingerprint_compatibility_mismatch(&fingerprint, browser_version) {
      return Some(reason);
    }
    WayfernConfig::fingerprint_satisfies_host_constraints(
      &fingerprint,
      config,
      Self::fingerprint_host_constraints(app_handle),
    )
    .err()
  }

  /// Derive the on-screen window size Chromium should open at, from the stored
  /// fingerprint. `Wayfern.setFingerprint` only spoofs what the page *reports*
  /// for `windowOuterWidth`/`screenWidth`/etc.; it does not move or resize the
  /// real top-level window. Without `--window-size` the OS window keeps
  /// Chromium's default, so the visible window contradicts the reported
  /// dimensions — a detectable mismatch. We pass `--window-size` so the actual
  /// window matches the fingerprint.
  ///
  /// Keys are the camelCase fields Wayfern uses in its fingerprint
  /// (`windowOuterWidth`, `screenAvailWidth`, …) — NOT the dotted
  /// Preference order, matching how the fingerprint
  /// describes the window:
  /// 1. `windowOuterWidth` / `windowOuterHeight` — the real window size.
  /// 2. `screenAvailWidth` / `screenAvailHeight` — usable screen area.
  /// 3. `screenWidth` / `screenHeight` — full screen.
  ///
  /// Returns `None` when the fingerprint carries no usable dimensions, leaving
  /// Chromium's default untouched. The fingerprint JSON may be the bare object
  /// or the legacy `{ "fingerprint": {...} }` wrapper.
  fn window_size_from_fingerprint(fingerprint_json: &str) -> Option<(u32, u32)> {
    let parsed: serde_json::Value = serde_json::from_str(fingerprint_json).ok()?;
    let fp = parsed.get("fingerprint").unwrap_or(&parsed);
    let obj = fp.as_object()?;

    // Accept both numeric and stringified numbers (Wayfern emits numbers, but a
    // CDP echo or older saved fingerprint may stringify them).
    let read = |key: &str| -> Option<u32> {
      let v = obj.get(key)?;
      v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        .filter(|n| *n > 0)
        .map(|n| n as u32)
    };
    let pair = |w: &str, h: &str| -> Option<(u32, u32)> { Some((read(w)?, read(h)?)) };

    pair("windowOuterWidth", "windowOuterHeight")
      .or_else(|| pair("screenAvailWidth", "screenAvailHeight"))
      .or_else(|| pair("screenWidth", "screenHeight"))
  }

  async fn wait_for_cdp_ready(
    &self,
    port: u16,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    // On first launch, macOS Gatekeeper verifies the binary which can take 30+ seconds.
    // Use a generous timeout (60s) to handle this.
    let max_attempts = 120;
    let delay = Duration::from_millis(500);

    let mut last_error: Option<String> = None;
    for attempt in 0..max_attempts {
      match self.http_client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
          log::info!("CDP ready on port {port} after {attempt} attempts");
          return Ok(());
        }
        Ok(resp) => {
          last_error = Some(format!("HTTP {} from {url}", resp.status()));
          tokio::time::sleep(delay).await;
        }
        Err(e) => {
          last_error = Some(format!("request failed: {e}"));
          tokio::time::sleep(delay).await;
        }
      }
    }

    let detail = last_error.unwrap_or_else(|| "no attempts completed".to_string());
    // Log at error level so we can diagnose Windows/AV/firewall-induced CDP hangs
    // in customer reports without needing them to reproduce in the moment.
    log::error!("CDP not ready after {max_attempts} attempts on port {port}: {detail}");
    Err(format!("CDP not ready after {max_attempts} attempts on port {port}: {detail}").into())
  }

  #[cfg(target_os = "macos")]
  async fn listener_pid_for_launch(port: u16, profile_path: &str) -> Option<u32> {
    let lsof_output = TokioCommand::new("/usr/sbin/lsof")
      .arg("-nP")
      .arg(format!("-iTCP:{port}"))
      .arg("-sTCP:LISTEN")
      .arg("-t")
      .output()
      .await
      .ok()?;
    if !lsof_output.status.success() {
      return None;
    }
    let output = String::from_utf8_lossy(&lsof_output.stdout);
    for pid in parse_lsof_listener_pids(&output) {
      let process_output = TokioCommand::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .await
        .ok()?;
      if !process_output.status.success() {
        continue;
      }
      let command = String::from_utf8_lossy(&process_output.stdout);
      if command.contains(&format!("--remote-debugging-port={port}"))
        && command.contains(profile_path)
        && !command.contains("--type=")
      {
        return Some(pid);
      }
    }
    None
  }

  async fn spawn_wayfern_and_wait(
    &self,
    executable_path: &std::path::Path,
    args: &[String],
    wayfern_token: Option<&str>,
    _profile_path: &str,
    port: u16,
  ) -> Result<SpawnedWayfernGuard, Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(target_os = "macos")]
    if crate::platform_browser::macos::app_bundle_for_executable(executable_path).is_some() {
      let target_path = std::path::Path::new(_profile_path)
        .canonicalize()
        .unwrap_or_else(|_| std::path::Path::new(_profile_path).to_path_buf());
      let environment: Vec<(&str, &str)> = wayfern_token
        .map(|token| vec![("WAYFERN_TOKEN", token)])
        .unwrap_or_default();
      let mut launcher = crate::platform_browser::macos::launch_browser_process_with_environment(
        executable_path,
        args,
        &environment,
      )
      .await?;
      let mut process_guard = SpawnedWayfernGuard::new(None, target_path.clone(), port);
      process_guard.launcher_process_id = Some(launcher.id());
      let launcher_status = tokio::task::spawn_blocking(move || launcher.wait()).await??;
      process_guard.launcher_process_id = None;
      if !launcher_status.success() {
        return Err(
          format!("macOS Launch Services failed to start Wayfern with status {launcher_status}")
            .into(),
        );
      }

      self.wait_for_cdp_ready(port).await?;

      if let Some(pid) = Self::listener_pid_for_launch(port, _profile_path).await {
        process_guard.process_id = Some(pid);
        return Ok(process_guard);
      }

      let candidates: Vec<(u32, Option<u16>)> =
        Self::find_wayfern_processes_by_profile(&target_path)
          .into_iter()
          .map(|(pid, _, cdp_port)| (pid, cdp_port))
          .collect();
      let existing = std::collections::HashSet::new();
      if let Some(pid) = select_new_wayfern_process(&candidates, &existing, port) {
        process_guard.process_id = Some(pid);
        return Ok(process_guard);
      }
      return Err("Wayfern launched through macOS Launch Services, but its real process could not be identified".into());
    }

    let mut command = TokioCommand::new(executable_path);
    command
      .args(args)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    if let Some(token) = wayfern_token {
      command.env("WAYFERN_TOKEN", token);
    }
    let child = command
      .spawn()
      .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> {
        let hint = if error.raw_os_error() == Some(14001) {
          ". This usually means the Visual C++ Redistributable is not installed. \
           Download it from https://aka.ms/vs/17/release/vc_redist.x64.exe"
        } else {
          ""
        };
        format!("Failed to spawn Wayfern: {error}{hint}").into()
      })?;
    let process_id = child.id();
    drop(child);
    let target_path = std::path::Path::new(_profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(_profile_path).to_path_buf());
    let process_guard = SpawnedWayfernGuard::new(process_id, target_path, port);
    self.wait_for_cdp_ready(port).await?;
    Ok(process_guard)
  }

  async fn get_cdp_targets(
    &self,
    port: u16,
  ) -> Result<Vec<CdpTarget>, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("http://127.0.0.1:{port}/json");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
      let resp = self.http_client.get(&url).send().await?;
      let targets: Vec<CdpTarget> = resp.json().await?;
      let has_page = targets
        .iter()
        .any(|target| target.target_type == "page" && target.websocket_debugger_url.is_some());
      if has_page || tokio::time::Instant::now() >= deadline {
        return Ok(targets);
      }
      tokio::time::sleep(Duration::from_millis(100)).await;
    }
  }

  async fn send_cdp_command(
    &self,
    ws_url: &str,
    method: &str,
    params: serde_json::Value,
  ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
    let (mut ws_stream, _) = connect_async(ws_url).await?;

    let command = json!({
      "id": 1,
      "method": method,
      "params": params
    });

    use futures_util::sink::SinkExt;
    use futures_util::stream::StreamExt;

    ws_stream
      .send(Message::Text(command.to_string().into()))
      .await?;

    while let Some(msg) = ws_stream.next().await {
      match msg? {
        Message::Text(text) => {
          let response: serde_json::Value = serde_json::from_str(text.as_str())?;
          if response.get("id") == Some(&json!(1)) {
            if let Some(error) = response.get("error") {
              return Err(format!("CDP error: {}", error).into());
            }
            return Ok(response.get("result").cloned().unwrap_or(json!({})));
          }
        }
        Message::Close(_) => break,
        _ => {}
      }
    }

    Err("No response received from CDP".into())
  }

  /// Stable signature describing what determines this profile's geolocation
  /// (timezone, latitude/longitude, language): the geoip mode first, then the
  /// VPN, the proxy, or a direct connection. Compared across creation and
  /// launch to detect a change. The VPN case keys off `vpn_id` rather than the
  /// per-launch local port, and the proxy case off type/host/port/username so
  /// that editing the proxy is also caught.
  pub fn geo_signature(
    proxy: Option<&crate::browser::ProxySettings>,
    vpn_id: Option<&str>,
    geoip: Option<&serde_json::Value>,
  ) -> String {
    // The "v2:" prefix invalidates every signature stamped before geolocation
    // failures stopped being stamped: those may describe fingerprints that
    // silently carry the host's location, so each pre-v2 profile gets one
    // launch-time refresh and is re-stamped in the current format.
    let base = match geoip {
      Some(serde_json::Value::Bool(false)) => "off".to_string(),
      Some(serde_json::Value::String(ip)) if !ip.is_empty() => format!("ip:{ip}"),
      _ => {
        if let Some(id) = vpn_id {
          format!("vpn:{id}")
        } else if let Some(p) = proxy {
          format!(
            "proxy:{}://{}@{}:{}",
            p.proxy_type.to_lowercase(),
            p.username.as_deref().unwrap_or(""),
            p.host,
            p.port
          )
        } else {
          "direct".to_string()
        }
      }
    };
    format!("v2:{base}")
  }

  /// Apply timezone/geolocation fields to a fingerprint object from the proxy's
  /// exit IP (or a fixed geoip IP). Mutates `fingerprint` in place. Returns true
  /// if fresh geolocation was fetched and applied, false if geolocation is
  /// disabled or could not be resolved (in which case only safe defaults are
  /// filled in). Shared by fingerprint generation and the launch-time refresh
  /// so both produce identical location data.
  async fn apply_geolocation(
    fingerprint: &mut serde_json::Value,
    proxy: Option<&str>,
    geoip: Option<&serde_json::Value>,
  ) -> bool {
    // Default to auto-detect; only an explicit `false` disables geolocation.
    let should_geolocate = !matches!(geoip, Some(serde_json::Value::Bool(false)));
    if !should_geolocate {
      return false;
    }

    let geo_result = async {
      let ip = match geoip {
        Some(serde_json::Value::String(ip_str)) => ip_str.clone(),
        _ => crate::ip_utils::fetch_public_ip(proxy)
          .await
          .map_err(|e| format!("Failed to fetch public IP: {e}"))?,
      };
      crate::geolocation::get_geolocation_async(&ip, proxy)
        .await
        .map_err(|e| format!("Failed to get geolocation for IP {ip}: {e}"))
    }
    .await;

    match geo_result {
      Ok(geo) => {
        if let Some(obj) = fingerprint.as_object_mut() {
          obj.insert("timezone".to_string(), json!(geo.timezone));
          // Calculate timezone offset from IANA timezone name
          if let Ok(tz) = geo.timezone.parse::<chrono_tz::Tz>() {
            use chrono::Offset;
            let now = chrono::Utc::now().with_timezone(&tz);
            let offset_seconds = now.offset().fix().local_minus_utc();
            let offset_minutes = -(offset_seconds / 60);
            obj.insert("timezoneOffset".to_string(), json!(offset_minutes));
          }
          obj.insert("latitude".to_string(), json!(geo.latitude));
          obj.insert("longitude".to_string(), json!(geo.longitude));
          let locale_str = geo.locale.as_string();
          obj.insert("language".to_string(), json!(&locale_str));
          obj.insert(
            "languages".to_string(),
            json!([&locale_str, &geo.locale.language]),
          );
        }
        log::info!(
          "Applied geolocation to Wayfern fingerprint: {} ({})",
          geo.locale.as_string(),
          geo.timezone
        );
        true
      }
      Err(e) => {
        log::warn!("Geolocation failed, using defaults: {e}");
        if let Some(obj) = fingerprint.as_object_mut() {
          if !obj.contains_key("timezone") {
            obj.insert("timezone".to_string(), json!("America/New_York"));
          }
          if !obj.contains_key("timezoneOffset") {
            obj.insert("timezoneOffset".to_string(), json!(300));
          }
        }
        false
      }
    }
  }

  /// Refresh ONLY the location fields (timezone, offset, latitude/longitude,
  /// language) of an already-generated fingerprint to match the current proxy,
  /// leaving every other fingerprint field untouched. `proxy` is the local
  /// proxy URL the browser will use. Returns the updated fingerprint JSON on
  /// success, or None if geolocation is disabled or could not be resolved, in
  /// which case the caller keeps the existing fingerprint and retries on the
  /// next launch.
  pub async fn refresh_fingerprint_geolocation(
    fingerprint_json: &str,
    proxy: Option<&str>,
    geoip: Option<&serde_json::Value>,
  ) -> Option<String> {
    let mut fp: serde_json::Value = serde_json::from_str(fingerprint_json).ok()?;
    if Self::apply_geolocation(&mut fp, proxy, geoip).await {
      serde_json::to_string(&fp).ok()
    } else {
      None
    }
  }

  /// True when `url` is a socks proxy on a remote (non-loopback) host — the
  /// case where reqwest's SOCKS connector can't be trusted with the
  /// geolocation fetch. Loopback socks URLs are the app's own donut-proxy
  /// workers, whose single-segment replies don't trigger the connector bug.
  fn is_remote_socks_url(url: &str) -> bool {
    url.starts_with("socks")
      && url::Url::parse(url)
        .ok()
        .and_then(|u| match u.host() {
          Some(url::Host::Ipv4(ip)) => Some(!ip.is_loopback()),
          Some(url::Host::Ipv6(ip)) => Some(!ip.is_loopback()),
          // socks is a non-special scheme, so the url crate keeps even
          // IP-literal hosts as Domain — parse them before comparing.
          Some(url::Host::Domain(domain)) => Some(
            domain != "localhost"
              && domain
                .parse::<std::net::IpAddr>()
                .map(|ip| !ip.is_loopback())
                .unwrap_or(true),
          ),
          None => None,
        })
        .unwrap_or(false)
  }

  /// Generate a fingerprint for `config`, returning the fingerprint JSON and
  /// whether fresh geolocation was applied to it. Callers must only stamp
  /// `geo_proxy_signature` when geolocation succeeded: the base fingerprint
  /// comes from a headless Wayfern launched without a proxy, so on failure it
  /// silently carries the HOST timezone/locale — stamping the signature then
  /// would tell the launch-time refresh the location is already correct for
  /// this proxy and permanently disable the one path that can repair it.
  pub async fn generate_fingerprint_config(
    &self,
    app_handle: &AppHandle,
    profile: &BrowserProfile,
    config: &WayfernConfig,
  ) -> Result<(String, bool), Box<dyn std::error::Error + Send + Sync>> {
    let executable_path = BrowserRunner::instance()
      .get_browser_executable_path(profile)
      .map_err(|e| format!("Failed to get Wayfern executable path: {e}"))?;

    let port = Self::find_free_port().await?;
    log::info!("Launching headless Wayfern on port {port} for fingerprint generation");

    let temp_profile_dir =
      std::env::temp_dir().join(format!("wayfern_fingerprint_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_profile_dir)?;

    let mut cmd = TokioCommand::new(&executable_path);
    cmd
      .arg("--headless=new")
      .arg(format!("--remote-debugging-port={port}"))
      .arg("--remote-debugging-address=127.0.0.1")
      .arg("--remote-allow-origins=*")
      .arg(format!("--user-data-dir={}", temp_profile_dir.display()))
      .arg("--no-first-run")
      .arg("--no-default-browser-check")
      .arg("--disable-background-mode")
      .arg("--use-mock-keychain")
      .arg("--password-store=basic")
      .arg("--disable-features=DialMediaRouteProvider");

    #[cfg(target_os = "linux")]
    cmd
      .arg("--no-sandbox")
      .arg("--disable-setuid-sandbox")
      .arg("--disable-dev-shm-usage");

    cmd.stdout(Stdio::null()).stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| {
      // OS error 14001 = SxS / missing Visual C++ Redistributable
      let hint = if e.raw_os_error() == Some(14001) {
        ". This usually means the Visual C++ Redistributable is not installed. \
         Download it from https://aka.ms/vs/17/release/vc_redist.x64.exe"
      } else {
        ""
      };
      format!("Failed to spawn headless Wayfern: {e}{hint}")
    })?;
    let child_id = child.id();

    let cleanup = || async {
      Self::terminate_process(child_id);
      let _ = std::fs::remove_dir_all(&temp_profile_dir);
    };

    if let Err(e) = self.wait_for_cdp_ready(port).await {
      // Try to capture stderr from the failed process for diagnostics
      let stderr_output = if let Some(id) = child_id {
        // Check if process is still running
        let is_running = sysinfo::System::new_with_specifics(
          sysinfo::RefreshKind::nothing().with_processes(sysinfo::ProcessRefreshKind::nothing()),
        )
        .process(sysinfo::Pid::from(id as usize))
        .is_some();

        if !is_running {
          // Process exited — try to read its stderr
          String::from("(process exited before CDP became ready)")
        } else {
          String::from("(process still running but not responding on CDP)")
        }
      } else {
        String::new()
      };

      log::error!(
        "Fingerprint-generation Wayfern (headless, pid={child_id:?}) never became CDP-ready: {e}. {stderr_output}"
      );
      cleanup().await;
      return Err(e);
    }

    let targets = match self.get_cdp_targets(port).await {
      Ok(t) => t,
      Err(e) => {
        cleanup().await;
        return Err(e);
      }
    };

    let page_target = targets
      .iter()
      .find(|t| t.target_type == "page" && t.websocket_debugger_url.is_some());

    let ws_url = match page_target {
      Some(target) => target.websocket_debugger_url.as_ref().unwrap().clone(),
      None => {
        cleanup().await;
        return Err("No page target found for CDP".into());
      }
    };

    let os = config
      .os
      .as_deref()
      .unwrap_or(if cfg!(target_os = "macos") {
        "macos"
      } else if cfg!(target_os = "linux") {
        "linux"
      } else {
        "windows"
      });

    // Include wayfern token if available (enables cross-OS fingerprinting for paid users)
    let wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
    let mut refresh_params = json!({ "operatingSystem": os });
    if let Some(ref token) = wayfern_token {
      refresh_params
        .as_object_mut()
        .unwrap()
        .insert("wayfernToken".to_string(), json!(token));
    }

    // DON: regenerate full fingerprints until host display constraints pass.
    // Never patch individual fields — Wayfern re-normalizes inconsistent edits.
    let host_constraints = Self::fingerprint_host_constraints(app_handle);
    let mut last_reject = String::from("no fingerprint candidate");
    let mut normalized = None;
    for attempt in 1..=FINGERPRINT_GENERATION_ATTEMPTS {
      let refresh_result = self
        .send_cdp_command(
          &ws_url,
          "Wayfern.refreshFingerprint",
          refresh_params.clone(),
        )
        .await;
      if let Err(e) = refresh_result {
        cleanup().await;
        return Err(format!("Failed to refresh fingerprint: {e}").into());
      }

      let get_result = self
        .send_cdp_command(&ws_url, "Wayfern.getFingerprint", json!({}))
        .await;
      let result = match get_result {
        Ok(r) => r,
        Err(e) => {
          cleanup().await;
          return Err(format!("Failed to get fingerprint: {e}").into());
        }
      };

      let fp = result.get("fingerprint").cloned().unwrap_or(result);
      let candidate = Self::normalize_fingerprint(fp);
      match WayfernConfig::fingerprint_satisfies_host_constraints(
        &candidate,
        config,
        host_constraints,
      ) {
        Ok(()) => {
          log::info!(
            "DON: accepted fingerprint candidate on attempt {attempt} (dpr={:?} screen={:?}x{:?})",
            candidate.get("devicePixelRatio"),
            candidate.get("screenWidth"),
            candidate.get("screenHeight")
          );
          normalized = Some(candidate);
          break;
        }
        Err(reason) => {
          last_reject = reason.clone();
          log::info!("DON: rejecting fingerprint attempt {attempt}: {reason}");
        }
      }
    }

    let mut normalized = match normalized {
      Some(fp) => fp,
      None => {
        cleanup().await;
        return Err(
          format!(
            "Failed to generate a host-compatible fingerprint after {FINGERPRINT_GENERATION_ATTEMPTS} attempts (last: {last_reject}). \
             Prefer matching devicePixelRatio to your display scale and keep screen size within the logical monitor bounds."
          )
          .into(),
        );
      }
    };

    // reqwest's SOCKS connector (hyper-util) corrupts its parse buffer
    // when a proxy splits a handshake reply across TCP segments, so a
    // socks upstream here can fail even though the proxy is healthy.
    // Route the geolocation lookup through a temporary local donut-proxy
    // worker — the same path the browser itself uses — and fall back to
    // the upstream URL only if the worker can't start. Two exclusions:
    // no worker when geolocation won't fetch through the proxy at all
    // (disabled, or a fixed geoip IP), and none for loopback socks URLs —
    // launch-time callers pass the already-running local worker's
    // socks5://127.0.0.1 URL, whose single-segment replies don't trigger
    // the bug, so chaining a second worker would only add latency.
    let needs_proxied_geo_fetch = !matches!(
      config.geoip.as_ref(),
      Some(serde_json::Value::Bool(false)) | Some(serde_json::Value::String(_))
    );
    let remote_socks_upstream = config
      .proxy
      .as_deref()
      .filter(|url| Self::is_remote_socks_url(url));
    let (geo_proxy, temp_worker_id) = match remote_socks_upstream {
      Some(url) if needs_proxied_geo_fetch => {
        match crate::proxy_runner::start_proxy_process(Some(url.to_string()), None)
          .await
          .map_err(|e| e.to_string())
        {
          Ok(worker) => {
            let local_url = format!("http://127.0.0.1:{}", worker.local_port.unwrap_or(0));
            (Some(local_url), Some(worker.id))
          }
          Err(e) => {
            log::warn!(
              "Could not start local proxy worker for geolocation ({e}); using the socks upstream directly"
            );
            (config.proxy.clone(), None)
          }
        }
      }
      _ => (config.proxy.clone(), None),
    };

    // Apply timezone/geolocation for the proxy this fingerprint is being
    // generated against. Shared with the launch-time location refresh.
    let geolocation_applied =
      Self::apply_geolocation(&mut normalized, geo_proxy.as_deref(), config.geoip.as_ref()).await;

    if let Some(worker_id) = temp_worker_id {
      let _ = crate::proxy_runner::stop_proxy_process(&worker_id).await;
    }

    let fingerprint = normalized;

    cleanup().await;

    let fingerprint_json = serde_json::to_string(&fingerprint)
      .map_err(|e| format!("Failed to serialize fingerprint: {e}"))?;

    // Report the platform the engine actually produced alongside the one that
    // was asked for. Logging only the request made this line useless for
    // diagnosing a fingerprint that came back as something else.
    log::info!(
      "Generated Wayfern fingerprint for requested OS: {}, produced platform: {:?}, fields: {:?}",
      os,
      fingerprint.get("platform").and_then(|p| p.as_str()),
      fingerprint
        .as_object()
        .map(|o| o.keys().collect::<Vec<_>>())
    );

    // Log timezone/geolocation fields specifically for debugging
    if let Some(obj) = fingerprint.as_object() {
      log::info!(
        "Generated fingerprint - timezone: {:?}, timezoneOffset: {:?}, latitude: {:?}, longitude: {:?}, language: {:?}",
        obj.get("timezone"),
        obj.get("timezoneOffset"),
        obj.get("latitude"),
        obj.get("longitude"),
        obj.get("language")
      );
    }

    Ok((fingerprint_json, geolocation_applied))
  }

  #[allow(clippy::too_many_arguments)]
  pub async fn launch_wayfern(
    &self,
    app_handle: &AppHandle,
    profile: &BrowserProfile,
    profile_path: &str,
    config: &WayfernConfig,
    url: Option<&str>,
    proxy_url: Option<&str>,
    ephemeral: bool,
    extension_paths: &[String],
    remote_debugging_port: Option<u16>,
    headless: bool,
  ) -> Result<WayfernLaunchResult, Box<dyn std::error::Error + Send + Sync>> {
    let executable_path = BrowserRunner::instance()
      .get_browser_executable_path(profile)
      .map_err(|e| format!("Failed to get Wayfern executable path: {e}"))?;

    let port = match remote_debugging_port {
      Some(p) => p,
      None => Self::find_free_port().await?,
    };
    log::info!("Launching Wayfern on CDP port {port} (detached)");

    let mut args = base_wayfern_launch_args(port, profile_path);
    WayfernConfig::append_configured_launch_args(&mut args, config);

    if headless {
      args.push("--headless=new".to_string());
    } else if let Some((w, h)) = config
      .fingerprint
      .as_deref()
      .and_then(Self::window_size_from_fingerprint)
    {
      // Size the real OS window to match the fingerprint so the visible window
      // agrees with the reported windowOuterWidth/screen dimensions. Anchor at
      // 0,0 so the window also fits within the spoofed screen origin. Skipped in
      // headless mode, where there is no on-screen window.
      log::info!("Sizing Wayfern window to fingerprint dimensions: {w}x{h}");
      args.push(format!("--window-size={w},{h}"));
      args.push("--window-position=0,0".to_string());
    }

    #[cfg(target_os = "linux")]
    {
      args.push("--no-sandbox".to_string());
      args.push("--disable-setuid-sandbox".to_string());
      args.push("--disable-dev-shm-usage".to_string());
    }

    if ephemeral {
      args.push("--disk-cache-size=1".to_string());
      args.push("--disable-breakpad".to_string());
      args.push("--disable-crash-reporter".to_string());
      args.push("--no-service-autorun".to_string());
      args.push("--disable-sync".to_string());
    }

    if !extension_paths.is_empty() {
      args.push(format!("--load-extension={}", extension_paths.join(",")));
    }

    // Per-profile window label + distinct frame color so concurrent profile
    // windows are easy to tell apart. Wayfern reads these in
    // BrowserView::GetWindowTitle() (label) and BrowserFrameView::GetFrameColor()
    // (color). The label is the profile name; the color is the user's
    // window_color when set, otherwise deterministically derived from the
    // profile id so every profile still gets a stable, distinct color.
    if !profile.name.is_empty() {
      args.push(format!("--wayfern-profile-label={}", profile.name));
    }
    // Profiles created before this feature have no stored color; persist the
    // id-derived one so the info dialog shows the same frame color the window
    // uses. It's deterministic per id, so no updated_at bump/sync is needed.
    if profile
      .window_color
      .as_deref()
      .map(str::trim)
      .unwrap_or("")
      .is_empty()
    {
      let derived_color = derive_profile_color(&profile.id);
      let _ = crate::profile::ProfileManager::instance().mutate_profile(
        &profile.id.to_string(),
        move |latest| {
          if latest
            .window_color
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
          {
            latest.window_color = Some(derived_color);
          }
          Ok(())
        },
      );
    }
    let profile_color = profile
      .window_color
      .clone()
      .filter(|c| !c.trim().is_empty())
      .unwrap_or_else(|| derive_profile_color(&profile.id));
    // Wayfern expects the frame color as bare RRGGBB hex, with no leading '#'
    // (the stored/user value may include one).
    let profile_color = profile_color.trim().trim_start_matches('#');
    args.push(format!("--wayfern-profile-color={profile_color}"));

    let mut wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
    // Waiting is only meaningful for a plan a token can actually be minted for.
    // On "any active plan" this stalled every Solo launch by the full three
    // seconds waiting for a token the backend will never issue to them.
    if wayfern_token.is_none()
      && crate::cloud_auth::CLOUD_AUTH
        .is_entitled_to_wayfern_token()
        .await
    {
      // Brief wait for the background token fetch — when the API is healthy
      // the token usually lands in well under a second. If api.donutbrowser.com
      // is unreachable we don't want to gate the whole launch on it; the
      // browser still works without the token (cross-OS fingerprinting just
      // won't be enabled for this session, and the next launch will pick it
      // up once the token arrives).
      log::info!("Wayfern token not ready for paid user, waiting briefly...");
      for _ in 0..3 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
        if wayfern_token.is_some() {
          break;
        }
      }
      if wayfern_token.is_none() {
        log::warn!(
          "Wayfern token still unavailable after wait; launching without it (api.donutbrowser.com may be unreachable)"
        );
      }
    }
    if let Some(proxy) = proxy_url {
      // Map the local proxy scheme to the matching PAC directive. SOCKS5 lets
      // Chromium route UDP (QUIC/WebRTC) and resolve DNS through the proxy;
      // PROXY is HTTP CONNECT (TCP only). The host:port is the same either way.
      let (pac_directive, host_port) = if let Some(rest) = proxy.strip_prefix("socks5://") {
        ("SOCKS5", rest)
      } else {
        (
          "PROXY",
          proxy
            .trim_start_matches("http://")
            .trim_start_matches("https://"),
        )
      };
      let pac_data = format!(
        "data:application/x-ns-proxy-autoconfig,function FindProxyForURL(url,host){{return \"{pac_directive} {host_port}\";}}",
      );
      args.push(format!("--proxy-pac-url={pac_data}"));
      args.push("--dns-prefetch-disable".to_string());
    }

    if wayfern_token.is_some() {
      log::info!("Wayfern authorization configured for browser process");
    }
    let mut process_guard = self
      .spawn_wayfern_and_wait(
        &executable_path,
        &args,
        wayfern_token.as_deref(),
        profile_path,
        port,
      )
      .await?;
    let process_id = process_guard.process_id;

    let targets = self.get_cdp_targets(port).await?;
    log::info!("Found {} CDP targets", targets.len());

    let page_targets: Vec<_> = targets.iter().filter(|t| t.target_type == "page").collect();
    log::info!("Found {} page targets", page_targets.len());

    // Apply fingerprint if configured
    let mut used_fingerprint: Option<String> = None;
    if let Some(fingerprint_json) = &config.fingerprint {
      log::info!(
        "Applying fingerprint to Wayfern browser, fingerprint length: {} chars",
        fingerprint_json.len()
      );

      let stored_value: serde_json::Value = serde_json::from_str(fingerprint_json)
        .map_err(|e| format!("Failed to parse stored fingerprint JSON: {e}"))?;

      // The stored fingerprint should be the fingerprint object directly (after our fix in generate_fingerprint_config)
      // But for backwards compatibility, also handle the wrapped format
      let mut fingerprint = if stored_value.get("fingerprint").is_some() {
        // Old format: {"fingerprint": {...}} - extract the inner fingerprint
        stored_value.get("fingerprint").cloned().unwrap()
      } else {
        // New format: fingerprint object directly {...}
        stored_value.clone()
      };

      // Add default timezone if not present (for profiles created before timezone was added)
      if let Some(obj) = fingerprint.as_object_mut() {
        if !obj.contains_key("timezone") {
          obj.insert("timezone".to_string(), json!("America/New_York"));
          log::info!("Added default timezone to fingerprint");
        }
        if !obj.contains_key("timezoneOffset") {
          obj.insert("timezoneOffset".to_string(), json!(300));
          log::info!("Added default timezoneOffset to fingerprint");
        }
      }

      // Auto-correct timezone and geolocation if proxy is present
      let should_geolocate = !matches!(config.geoip.as_ref(), Some(serde_json::Value::Bool(false)));
      if should_geolocate
        && (proxy_url.is_some() || config.proxy.is_some() || config.geoip.is_some())
      {
        let active_proxy = proxy_url.or(config.proxy.as_deref());
        Self::apply_geolocation(&mut fingerprint, active_proxy, config.geoip.as_ref()).await;
      }

      // Denormalize fingerprint for Wayfern CDP (convert arrays/objects to JSON strings)
      let mut fingerprint_for_cdp = Self::denormalize_fingerprint(fingerprint);

      // Normalize languages: if it's a comma-separated string, convert to array
      if let Some(obj) = fingerprint_for_cdp.as_object_mut() {
        if let Some(serde_json::Value::String(s)) = obj.get("languages").cloned() {
          let arr: Vec<&str> = s.split(',').map(|l| l.trim()).collect();
          obj.insert("languages".to_string(), json!(arr));
        }
      }

      log::info!(
        "Fingerprint prepared for CDP command, fields: {:?}",
        fingerprint_for_cdp
          .as_object()
          .map(|o| o.keys().collect::<Vec<_>>())
      );

      // Log timezone and geolocation fields specifically for debugging
      if let Some(obj) = fingerprint_for_cdp.as_object() {
        log::info!(
          "Timezone/Geolocation fields - timezone: {:?}, timezoneOffset: {:?}, latitude: {:?}, longitude: {:?}, language: {:?}, languages: {:?}",
          obj.get("timezone"),
          obj.get("timezoneOffset"),
          obj.get("latitude"),
          obj.get("longitude"),
          obj.get("language"),
          obj.get("languages")
        );
      }

      // Include wayfern token if available (enables cross-OS fingerprinting for paid users)
      let wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
      let mut fingerprint_params = fingerprint_for_cdp.clone();
      if let Some(ref token) = wayfern_token {
        if let Some(obj) = fingerprint_params.as_object_mut() {
          obj.insert("wayfernToken".to_string(), json!(token));
        }
      }

      let host_constraints = Self::fingerprint_host_constraints(app_handle);

      for target in &page_targets {
        if let Some(ws_url) = &target.websocket_debugger_url {
          log::info!("Applying fingerprint to page target");
          match self
            .send_cdp_command(ws_url, "Wayfern.setFingerprint", fingerprint_params.clone())
            .await
          {
            Ok(result) => {
              log::info!("Successfully applied fingerprint to page target");
              // Wayfern.setFingerprint echoes back the fingerprint it actually
              // used, which may be UPGRADED from what we sent (e.g. when the
              // stored fingerprint targets an older browser version). Capture
              // it once, from the first target that succeeds, so the caller can
              // persist the upgraded value to the profile.
              if used_fingerprint.is_none() {
                // getFingerprint/setFingerprint wrap the object as
                // { fingerprint: {...} }; tolerate a bare object too.
                let fp = result.get("fingerprint").cloned().unwrap_or(result);
                if fp.is_object() {
                  let normalized = Self::normalize_fingerprint(fp);
                  if let Err(reason) = WayfernConfig::fingerprint_satisfies_host_constraints(
                    &normalized,
                    config,
                    host_constraints,
                  ) {
                    return Err(
                      format!(
                        "Wayfern applied a fingerprint that violates display constraints: {reason}"
                      )
                      .into(),
                    );
                  }
                  match serde_json::to_string(&normalized) {
                    Ok(s) => used_fingerprint = Some(s),
                    Err(e) => {
                      log::warn!("Failed to serialize used fingerprint: {e}")
                    }
                  }
                }
              }
            }
            Err(e) => log::error!("Failed to apply fingerprint to target: {e}"),
          }
        }
      }

      if used_fingerprint.is_none() {
        return Err("Wayfern did not return a complete applied fingerprint for validation".into());
      }
    } else {
      log::warn!("No fingerprint found in config, browser will use default fingerprint");
    }

    // Geolocation is handled internally by the browser binary.

    if let Some(url) = url {
      log::info!("Navigating to URL via CDP");
      if let Some(target) = page_targets.first() {
        if let Some(ws_url) = &target.websocket_debugger_url {
          if let Err(e) = self
            .send_cdp_command(ws_url, "Page.navigate", json!({ "url": url }))
            .await
          {
            log::error!("Failed to navigate to URL: {e}");
          }
        }
      }
    }

    for target in &page_targets {
      if let Some(ws_url) = &target.websocket_debugger_url {
        let _ = self
          .send_cdp_command(ws_url, "Emulation.clearDeviceMetricsOverride", json!({}))
          .await;
        let _ = self
          .send_cdp_command(
            ws_url,
            "Emulation.setFocusEmulationEnabled",
            json!({ "enabled": false }),
          )
          .await;
        let _ = self
          .send_cdp_command(
            ws_url,
            "Emulation.setEmulatedMedia",
            json!({ "media": "", "features": [] }),
          )
          .await;
      }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let instance = WayfernInstance {
      id: id.clone(),
      process_id,
      profile_path: Some(profile_path.to_string()),
      url: url.map(|s| s.to_string()),
      cdp_port: Some(port),
    };

    let mut inner = self.inner.lock().await;
    inner.instances.insert(id.clone(), instance);
    process_guard.disarm();

    Ok(WayfernLaunchResult {
      id,
      processId: process_id,
      profilePath: Some(profile_path.to_string()),
      url: url.map(|s| s.to_string()),
      cdp_port: Some(port),
      used_fingerprint,
    })
  }

  pub async fn stop_wayfern(
    &self,
    id: &str,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut inner = self.inner.lock().await;

    if let Some(instance) = inner.instances.remove(id) {
      log::info!("Cleaning up Wayfern instance {}", instance.id);
      if let Some(pid) = instance.process_id {
        Self::terminate_process(Some(pid));
        log::info!("Stopped Wayfern instance {id} (PID: {pid})");
      }
    }

    Ok(())
  }

  /// Opens a URL in a new tab for an existing Wayfern instance.
  pub(crate) async fn open_url_in_tab(
    &self,
    profile_path: &str,
    url: &str,
  ) -> Result<WayfernTab, Box<dyn std::error::Error + Send + Sync>> {
    self.open_url_in_tab_inner(profile_path, url, false).await
  }

  pub(crate) async fn open_temporary_url_in_tab(
    &self,
    profile_path: &str,
    url: &str,
  ) -> Result<WayfernTab, Box<dyn std::error::Error + Send + Sync>> {
    self.open_url_in_tab_inner(profile_path, url, true).await
  }

  async fn open_url_in_tab_inner(
    &self,
    profile_path: &str,
    url: &str,
    temporary: bool,
  ) -> Result<WayfernTab, Box<dyn std::error::Error + Send + Sync>> {
    let inner = self.inner.lock().await;
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    let port = inner
      .instances
      .values()
      .find(|i| {
        i.profile_path
          .as_deref()
          .map(|p| {
            std::path::Path::new(p)
              .canonicalize()
              .unwrap_or_else(|_| std::path::Path::new(p).to_path_buf())
              == target_path
          })
          .unwrap_or(false)
      })
      .and_then(|i| i.cdp_port)
      .ok_or("Wayfern instance (with CDP port) not found for profile")?;
    drop(inner);

    // Open the URL in a new tab via the CDP HTTP convenience endpoint.
    let new_tab_url = format!(
      "http://127.0.0.1:{port}/json/new?{}",
      urlencoding::encode(url)
    );
    let mut pending_tab = temporary.then(|| PendingWayfernTabGuard::new(port, url));
    let resp = self
      .http_client
      .put(&new_tab_url)
      .send()
      .await
      .map_err(|e| format!("Failed to open new tab: {e}"))?;
    if !resp.status().is_success() {
      if let Some(pending_tab) = pending_tab.as_mut() {
        pending_tab.disarm();
      }
      return Err(format!("CDP /json/new returned HTTP {}", resp.status()).into());
    }
    let response = match resp.json::<serde_json::Value>().await {
      Ok(response) => response,
      Err(error) => {
        let cleanup = if temporary {
          self.close_tab_by_url(port, url).await
        } else {
          Ok(())
        };
        if cleanup.is_ok() {
          if let Some(pending_tab) = pending_tab.as_mut() {
            pending_tab.disarm();
          }
        }
        return Err(match cleanup {
          Ok(()) => format!("CDP /json/new returned invalid JSON: {error}"),
          Err(cleanup_error) => format!(
            "CDP /json/new returned invalid JSON: {error}; temporary tab cleanup failed: {cleanup_error}"
          ),
        }
        .into());
      }
    };
    let target_id = response
      .get("id")
      .and_then(serde_json::Value::as_str)
      .filter(|id| !id.is_empty())
      .map(str::to_string);
    let target_id = match target_id {
      Some(target_id) => target_id,
      None => {
        let cleanup = if temporary {
          self.close_tab_by_url(port, url).await
        } else {
          Ok(())
        };
        if cleanup.is_ok() {
          if let Some(pending_tab) = pending_tab.as_mut() {
            pending_tab.disarm();
          }
        }
        return Err(match cleanup {
          Ok(()) => "CDP /json/new response omitted the target ID".to_string(),
          Err(cleanup_error) => format!(
            "CDP /json/new response omitted the target ID; temporary tab cleanup failed: {cleanup_error}"
          ),
        }
        .into());
      }
    };
    if let Some(pending_tab) = pending_tab.as_mut() {
      pending_tab.disarm();
    }

    log::info!("Opened URL in new tab via CDP");
    Ok(WayfernTab {
      port,
      target_id,
      armed: temporary,
    })
  }

  pub(crate) async fn close_tab(
    &self,
    mut tab: WayfernTab,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    self.close_tab_by_id(tab.port, &tab.target_id).await?;
    tab.armed = false;
    Ok(())
  }

  async fn close_tab_by_id(
    &self,
    port: u16,
    target_id: &str,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let response = self
      .http_client
      .get(format!(
        "http://127.0.0.1:{}/json/close/{}",
        port,
        urlencoding::encode(target_id)
      ))
      .send()
      .await
      .map_err(|error| format!("Failed to close temporary tab: {error}"))?;
    if !response.status().is_success() {
      return Err(format!("CDP /json/close returned HTTP {}", response.status()).into());
    }
    Ok(())
  }

  async fn close_tab_by_url(
    &self,
    port: u16,
    url: &str,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let targets = self
      .http_client
      .get(format!("http://127.0.0.1:{port}/json/list"))
      .send()
      .await?
      .json::<Vec<serde_json::Value>>()
      .await?;
    let target_id = targets
      .iter()
      .find(|target| target.get("url").and_then(serde_json::Value::as_str) == Some(url))
      .and_then(|target| target.get("id"))
      .and_then(serde_json::Value::as_str)
      .ok_or("Temporary Wayfern tab was not present in /json/list")?;
    self.close_tab_by_id(port, target_id).await
  }

  pub async fn get_cdp_port(&self, profile_path: &str) -> Option<u16> {
    let inner = self.inner.lock().await;
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    for instance in inner.instances.values() {
      if let Some(path) = &instance.profile_path {
        let instance_path = std::path::Path::new(path)
          .canonicalize()
          .unwrap_or_else(|_| std::path::Path::new(path).to_path_buf());
        if instance_path == target_path {
          return instance.cdp_port;
        }
      }
    }
    None
  }

  pub async fn find_wayfern_by_profile(&self, profile_path: &str) -> Option<WayfernLaunchResult> {
    let mut inner = self.inner.lock().await;

    // Canonicalize the target path for comparison
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    // Find the instance with the matching profile path
    let mut found_id: Option<String> = None;
    for (id, instance) in &inner.instances {
      if let Some(path) = &instance.profile_path {
        let instance_path = std::path::Path::new(path)
          .canonicalize()
          .unwrap_or_else(|_| std::path::Path::new(path).to_path_buf());
        if instance_path == target_path {
          found_id = Some(id.clone());
          break;
        }
      }
    }

    // If we found an instance, verify the process is still running
    if let Some(id) = found_id {
      if let Some(instance) = inner.instances.get(&id) {
        if let Some(pid) = instance.process_id {
          // The five-second status loop normally already knows the browser's
          // PID. Refresh only that process instead of rebuilding the entire
          // process table (including every renderer command line) while the
          // user is browsing. A full profile-path scan remains below solely
          // for recovery after the DON GUI restarts.
          if crate::proxy_storage::is_process_running(pid) {
            return Some(WayfernLaunchResult {
              id: id.clone(),
              processId: instance.process_id,
              profilePath: instance.profile_path.clone(),
              url: instance.url.clone(),
              cdp_port: instance.cdp_port,
              used_fingerprint: None,
            });
          } else {
            log::info!(
              "Wayfern process {} for profile {} is no longer running, cleaning up",
              pid,
              profile_path
            );
            inner.instances.remove(&id);
            return None;
          }
        }
      }
    }

    // If not found in in-memory instances, scan system processes.
    // This handles the case where the GUI was restarted but Wayfern is still running.
    if let Some((pid, found_profile_path, cdp_port)) =
      Self::find_wayfern_process_by_profile(&target_path)
    {
      log::info!(
        "Found running Wayfern process (PID: {}) for profile path via system scan",
        pid
      );

      let instance_id = format!("recovered_{}", pid);
      inner.instances.insert(
        instance_id.clone(),
        WayfernInstance {
          id: instance_id.clone(),
          process_id: Some(pid),
          profile_path: Some(found_profile_path.clone()),
          url: None,
          cdp_port,
        },
      );

      return Some(WayfernLaunchResult {
        id: instance_id,
        processId: Some(pid),
        profilePath: Some(found_profile_path),
        url: None,
        cdp_port,
        used_fingerprint: None,
      });
    }

    None
  }

  /// Scan system processes to find a Wayfern/Chromium process using a specific profile path
  fn find_wayfern_process_by_profile(
    target_path: &std::path::Path,
  ) -> Option<(u32, String, Option<u16>)> {
    Self::find_wayfern_processes_by_profile(target_path)
      .into_iter()
      .next()
  }

  fn find_wayfern_processes_by_profile(
    target_path: &std::path::Path,
  ) -> Vec<(u32, String, Option<u16>)> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};

    let system = System::new_with_specifics(
      RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );

    let target_path_str = target_path.to_string_lossy();
    let mut matches = Vec::new();

    for (pid, process) in system.processes() {
      let cmd = process.cmd();
      if cmd.is_empty() {
        continue;
      }

      let exe_name = process.name().to_string_lossy().to_lowercase();
      let is_chromium_like = exe_name.contains("wayfern")
        || exe_name.contains("chromium")
        || exe_name.contains("chrome");

      if !is_chromium_like {
        continue;
      }

      // Skip child processes (renderer, GPU, utility, zygote, etc.)
      // Only the main browser process lacks a --type= argument
      let is_child = cmd
        .iter()
        .any(|a| a.to_str().is_some_and(|s| s.starts_with("--type=")));
      if is_child {
        continue;
      }

      let mut matched = false;
      let mut cdp_port: Option<u16> = None;

      for arg in cmd.iter() {
        if let Some(arg_str) = arg.to_str() {
          if let Some(dir_val) = arg_str.strip_prefix("--user-data-dir=") {
            let cmd_path = std::path::Path::new(dir_val)
              .canonicalize()
              .unwrap_or_else(|_| std::path::Path::new(dir_val).to_path_buf());
            if cmd_path == target_path {
              matched = true;
            }
          }

          if let Some(port_val) = arg_str.strip_prefix("--remote-debugging-port=") {
            cdp_port = port_val.parse().ok();
          }
        }
      }

      if matched {
        matches.push((pid.as_u32(), target_path_str.to_string(), cdp_port));
      }
    }

    matches
  }

  #[allow(dead_code)]
  pub async fn launch_wayfern_profile(
    &self,
    app_handle: &AppHandle,
    profile: &BrowserProfile,
    config: &WayfernConfig,
    url: Option<&str>,
    proxy_url: Option<&str>,
  ) -> Result<WayfernLaunchResult, Box<dyn std::error::Error + Send + Sync>> {
    let profiles_dir = self.get_profiles_dir();
    let profile_path = profiles_dir.join(profile.id.to_string()).join("profile");
    let profile_path_str = profile_path.to_string_lossy().to_string();

    std::fs::create_dir_all(&profile_path)?;

    if let Some(existing) = self.find_wayfern_by_profile(&profile_path_str).await {
      log::info!("Stopping existing Wayfern instance for profile");
      self.stop_wayfern(&existing.id).await?;
    }

    self
      .launch_wayfern(
        app_handle,
        profile,
        &profile_path_str,
        config,
        url,
        proxy_url,
        profile.ephemeral,
        &[],
        None,
        false,
      )
      .await
  }

  #[allow(dead_code)]
  pub async fn cleanup_dead_instances(&self) {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};

    let mut inner = self.inner.lock().await;
    let mut dead_ids = Vec::new();

    let system = System::new_with_specifics(
      RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );

    for (id, instance) in &inner.instances {
      if let Some(pid) = instance.process_id {
        let pid = sysinfo::Pid::from_u32(pid);
        if !system.processes().contains_key(&pid) {
          dead_ids.push(id.clone());
        }
      }
    }

    for id in dead_ids {
      log::info!("Cleaning up dead Wayfern instance: {id}");
      inner.instances.remove(&id);
    }
  }
}

pub(crate) fn page_visible_device_memory(value: &serde_json::Value) -> serde_json::Value {
  if value.as_f64().is_some_and(|memory| memory >= 8.0) {
    serde_json::json!(8)
  } else {
    value.clone()
  }
}

lazy_static::lazy_static! {
  static ref WAYFERN_MANAGER: WayfernManager = WayfernManager::new();
}

/// Deterministically derive a pleasant, distinct window frame color from a
/// profile id so concurrent profile windows are visually distinguishable even
/// when the user has not picked a custom color. Stable per profile (same id
/// always yields the same color). Returns "#RRGGBB".
pub fn derive_profile_color(id: &uuid::Uuid) -> String {
  // FNV-1a over the 16 id bytes -> hue in [0,360). The hue varies per profile
  // while saturation/lightness are fixed to a pastel band (see below).
  let mut h: u32 = 2166136261;
  for &b in id.as_bytes() {
    h = (h ^ u32::from(b)).wrapping_mul(16777619);
  }
  let hue = f64::from(h % 360);
  // Pastel: high lightness + soft saturation so windows stay easy to tell apart
  // without a garish frame.
  let (r, g, b) = hsl_to_rgb(hue, 0.6, 0.8);
  format!("#{r:02x}{g:02x}{b:02x}")
}

/// Convert HSL (h in [0,360), s/l in [0,1]) to 8-bit RGB.
fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
  let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
  let hp = h / 60.0;
  let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
  let (r1, g1, b1) = match hp as i32 {
    0 => (c, x, 0.0),
    1 => (x, c, 0.0),
    2 => (0.0, c, x),
    3 => (0.0, x, c),
    4 => (x, 0.0, c),
    _ => (c, 0.0, x),
  };
  let m = l - c / 2.0;
  let to_u8 = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
  (to_u8(r1), to_u8(g1), to_u8(b1))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashSet;
  use std::sync::atomic::{AtomicUsize, Ordering};

  #[tokio::test]
  async fn cdp_target_discovery_waits_for_the_first_page() {
    async fn targets(
      axum::extract::State(request_count): axum::extract::State<Arc<AtomicUsize>>,
    ) -> axum::Json<serde_json::Value> {
      let request = request_count.fetch_add(1, Ordering::SeqCst);
      if request == 0 {
        axum::Json(serde_json::json!([{
          "type": "browser",
          "webSocketDebuggerUrl": "ws://127.0.0.1/browser"
        }]))
      } else {
        axum::Json(serde_json::json!([{
          "type": "page",
          "webSocketDebuggerUrl": "ws://127.0.0.1/page"
        }]))
      }
    }

    let request_count = Arc::new(AtomicUsize::new(0));
    let app = axum::Router::new()
      .route("/json", axum::routing::get(targets))
      .with_state(request_count.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
      axum::serve(listener, app).await.unwrap();
    });

    let discovered = WayfernManager::new().get_cdp_targets(port).await.unwrap();
    server.abort();

    assert!(discovered.iter().any(|target| target.target_type == "page"));
    assert_eq!(request_count.load(Ordering::SeqCst), 2);
  }

  #[test]
  fn production_launch_selects_the_managed_default_profile() {
    let args = base_wayfern_launch_args(9222, "/tmp/profile");

    assert!(args.iter().any(|arg| arg == "--profile-directory=Default"));
  }

  #[test]
  fn production_launch_keeps_chromium_background_throttling_enabled() {
    let args = base_wayfern_launch_args(9222, "/tmp/profile");

    assert!(!args
      .iter()
      .any(|arg| arg == "--disable-background-timer-throttling"));
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn production_launch_requests_the_native_macos_angle_backend() {
    let args = base_wayfern_launch_args(9222, "/tmp/profile");

    assert!(args.iter().any(|arg| arg == "--use-angle=default"));
  }

  #[test]
  fn fingerprint_memory_is_normalized_to_the_page_visible_limit() {
    let fingerprint = WayfernManager::normalize_fingerprint(serde_json::json!({
      "deviceMemory": 32
    }));

    assert_eq!(fingerprint["deviceMemory"], serde_json::json!(8));
  }

  #[test]
  fn launch_services_pid_recovery_excludes_existing_and_wrong_cdp_processes() {
    let existing = HashSet::from([100]);
    let candidates = vec![(100, Some(9222)), (200, Some(9333)), (300, Some(9222))];

    assert_eq!(
      select_new_wayfern_process(&candidates, &existing, 9222),
      Some(300)
    );
  }

  #[test]
  fn lsof_listener_pid_parser_ignores_noise_and_duplicates() {
    assert_eq!(
      parse_lsof_listener_pids(" 321\nnot-a-pid\n654\n321\n0\n"),
      vec![321, 654]
    );
  }

  #[test]
  fn webrtc_launch_args_follow_explicit_modes() {
    for (mode, expected) in [
      ("proxy", Some(WEBRTC_PROXY_POLICY_FLAG)),
      ("off", Some(WEBRTC_PROXY_POLICY_FLAG)),
      ("real", None),
    ] {
      let config = WayfernConfig {
        webrtc_mode: Some(mode.to_string()),
        ..Default::default()
      };
      let mut args = Vec::new();
      WayfernConfig::append_configured_launch_args(&mut args, &config);
      assert_eq!(args.first().map(String::as_str), expected);
    }
  }

  #[test]
  fn webrtc_mode_keeps_legacy_block_switch_compatible() {
    let blocked = WayfernConfig {
      block_webrtc: Some(true),
      ..Default::default()
    };
    let open = WayfernConfig {
      block_webrtc: Some(false),
      ..Default::default()
    };
    let fresh = WayfernConfig::default();

    assert_eq!(blocked.effective_webrtc_mode(), WebRtcMode::Proxy);
    assert_eq!(open.effective_webrtc_mode(), WebRtcMode::Real);
    assert_eq!(fresh.effective_webrtc_mode(), WebRtcMode::Proxy);
    assert_eq!(blocked.webrtc_launch_arg(), Some(WEBRTC_PROXY_POLICY_FLAG));
    assert_eq!(open.webrtc_launch_arg(), None);
    assert_eq!(fresh.webrtc_launch_arg(), Some(WEBRTC_PROXY_POLICY_FLAG));
  }

  #[test]
  fn gpu_compatibility_mode_disables_hardware_acceleration_only_when_enabled() {
    let enabled: WayfernConfig = serde_json::from_value(json!({
      "webrtc_mode": "real",
      "gpu_compatibility_mode": true
    }))
    .unwrap();
    let disabled: WayfernConfig = serde_json::from_value(json!({
      "webrtc_mode": "real"
    }))
    .unwrap();
    let mut enabled_args = Vec::new();
    let mut disabled_args = Vec::new();

    WayfernConfig::append_configured_launch_args(&mut enabled_args, &enabled);
    WayfernConfig::append_configured_launch_args(&mut disabled_args, &disabled);

    assert_eq!(enabled_args, ["--disable-gpu"]);
    assert!(disabled_args.is_empty());
  }

  #[test]
  fn device_preset_catalog_contains_desktop_and_mobile_profiles() {
    let catalog = serde_json::from_str::<DevicePresetCatalog>(DEVICE_PRESETS_JSON)
      .expect("device preset catalog must remain valid JSON");
    assert!(catalog
      .presets
      .iter()
      .any(|preset| preset.id == "windows-11-chrome-nvidia"));
    assert!(catalog
      .presets
      .iter()
      .any(|preset| preset.id == "macos-sonoma-chrome-apple-m"));
    assert!(catalog
      .presets
      .iter()
      .any(|preset| preset.id == "iphone-15-pro"));
    assert!(catalog.presets.iter().any(|preset| preset.id == "pixel-9"));
    assert!(catalog
      .presets
      .iter()
      .any(|preset| preset.id == "galaxy-s25"));
  }

  #[test]
  fn device_preset_constraints_require_a_consistent_fingerprint() {
    let catalog: serde_json::Value = serde_json::from_str(DEVICE_PRESETS_JSON).unwrap();
    let mut fingerprint = catalog["presets"]
      .as_array()
      .unwrap()
      .iter()
      .find(|preset| preset["id"] == "iphone-15-pro")
      .unwrap()["fingerprint"]
      .clone();
    fingerprint["screenAvailWidth"] = serde_json::json!(393);
    fingerprint["screenAvailHeight"] = serde_json::json!(852);
    fingerprint["windowOuterWidth"] = serde_json::json!(393);
    fingerprint["windowOuterHeight"] = serde_json::json!(852);
    fingerprint["windowInnerWidth"] = serde_json::json!(393);
    fingerprint["windowInnerHeight"] = serde_json::json!(760);
    let config = WayfernConfig {
      device_preset: Some("iphone-15-pro".to_string()),
      ..Default::default()
    };
    assert!(
      WayfernConfig::fingerprint_satisfies_constraints_with(&fingerprint, Some(&config)).is_ok()
    );

    fingerprint["platform"] = serde_json::json!("Win32");
    assert!(
      WayfernConfig::fingerprint_satisfies_constraints_with(&fingerprint, Some(&config)).is_err()
    );
  }

  #[test]
  fn remote_socks_url_detection() {
    // Remote socks upstreams (the hyper-util-affected case) are detected...
    assert!(WayfernManager::is_remote_socks_url(
      "socks5://user:pass@gw.dataimpulse.com:10000"
    ));
    assert!(WayfernManager::is_remote_socks_url("socks5://1.2.3.4:1080"));
    assert!(WayfernManager::is_remote_socks_url("socks4://1.2.3.4:1080"));

    // ...but the app's own loopback workers are not. socks is a non-special
    // URL scheme, so the IP literal parses as Host::Domain — the launch-time
    // randomize path depends on this returning false.
    assert!(!WayfernManager::is_remote_socks_url(
      "socks5://127.0.0.1:24001"
    ));
    assert!(!WayfernManager::is_remote_socks_url("socks5://[::1]:24001"));
    assert!(!WayfernManager::is_remote_socks_url(
      "socks5://localhost:24001"
    ));

    // Non-socks schemes and unparsable URLs never need the workaround.
    assert!(!WayfernManager::is_remote_socks_url(
      "http://gw.dataimpulse.com:10000"
    ));
    assert!(!WayfernManager::is_remote_socks_url(
      "https://gw.dataimpulse.com:10000"
    ));
    assert!(!WayfernManager::is_remote_socks_url("socks5://"));
    assert!(!WayfernManager::is_remote_socks_url("not a url"));
  }

  #[test]
  fn window_size_prefers_outer_window_dimensions() {
    // Field names + values mirror a real Wayfern fingerprint (camelCase).
    let fp = r#"{"windowOuterWidth": 1268, "windowOuterHeight": 764,
                 "windowInnerWidth": 1253, "windowInnerHeight": 630,
                 "screenAvailWidth": 1280, "screenAvailHeight": 775,
                 "screenWidth": 1280, "screenHeight": 800}"#;
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(fp),
      Some((1268, 764))
    );
  }

  #[test]
  fn window_size_falls_back_to_avail_then_full_screen() {
    let avail = r#"{"screenAvailWidth": 1280, "screenAvailHeight": 775,
                    "screenWidth": 1280, "screenHeight": 800}"#;
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(avail),
      Some((1280, 775))
    );

    let full = r#"{"screenWidth": 2560, "screenHeight": 1440}"#;
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(full),
      Some((2560, 1440))
    );
  }

  #[test]
  fn window_size_handles_wrapper_and_stringified_numbers() {
    let wrapped = r#"{"fingerprint": {"windowOuterWidth": "1366", "windowOuterHeight": "768"}}"#;
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(wrapped),
      Some((1366, 768))
    );
  }

  #[test]
  fn window_size_none_when_missing_or_invalid() {
    // No dimensions at all.
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(r#"{"userAgent": "x"}"#),
      None
    );
    // A width with no matching height is not a usable pair.
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(r#"{"windowOuterWidth": 1268}"#),
      None
    );
    // Zero is rejected as a degenerate size.
    assert_eq!(
      WayfernManager::window_size_from_fingerprint(
        r#"{"windowOuterWidth": 0, "windowOuterHeight": 0}"#
      ),
      None
    );
    // Not valid JSON.
    assert_eq!(
      WayfernManager::window_size_from_fingerprint("not json"),
      None
    );
  }

  #[test]
  fn fingerprint_constraints_reject_incomplete_candidates() {
    let fingerprint = serde_json::json!({
      "devicePixelRatio": 2,
      "screenWidth": 1470,
      "screenHeight": 956
    });

    assert!(WayfernConfig::fingerprint_satisfies_constraints(&fingerprint).is_err());
  }

  #[test]
  fn legacy_fingerprint_without_applied_device_profile_is_regenerated() {
    let legacy = complete_desktop_fingerprint(2.0);
    assert!(stored_fingerprint_compatibility_mismatch(&legacy, "151.0.7922.72").is_some());

    let mut current = legacy;
    current["deviceProfileApplied"] = serde_json::json!(true);
    assert_eq!(
      stored_fingerprint_compatibility_mismatch(&current, "151.0.7922.72"),
      None
    );
  }

  #[test]
  fn fingerprint_from_an_older_browser_major_is_regenerated() {
    let mut fingerprint = complete_desktop_fingerprint(2.0);
    fingerprint["deviceProfileApplied"] = serde_json::json!(true);
    fingerprint["brandVersion"] = serde_json::json!("150");

    assert_eq!(
      stored_fingerprint_compatibility_mismatch(&fingerprint, "151.0.7922.72"),
      Some("fingerprint browser major 150 does not match Wayfern 151".to_string())
    );
  }

  #[test]
  fn fingerprint_constraints_reject_internally_inconsistent_dimensions() {
    let available_exceeds_screen = serde_json::json!({
      "devicePixelRatio": 2,
      "screenWidth": 1470,
      "screenHeight": 956,
      "screenAvailWidth": 1600,
      "screenAvailHeight": 956,
      "windowOuterWidth": 1400,
      "windowOuterHeight": 900,
      "windowInnerWidth": 1300,
      "windowInnerHeight": 800
    });
    let outer_exceeds_available = serde_json::json!({
      "devicePixelRatio": 2,
      "screenWidth": 1470,
      "screenHeight": 956,
      "screenAvailWidth": 1400,
      "screenAvailHeight": 900,
      "windowOuterWidth": 1450,
      "windowOuterHeight": 920,
      "windowInnerWidth": 1300,
      "windowInnerHeight": 800
    });
    let inner_exceeds_outer = serde_json::json!({
      "devicePixelRatio": 2,
      "screenWidth": 1470,
      "screenHeight": 956,
      "screenAvailWidth": 1400,
      "screenAvailHeight": 900,
      "windowOuterWidth": 1300,
      "windowOuterHeight": 800,
      "windowInnerWidth": 1350,
      "windowInnerHeight": 850
    });

    for fingerprint in [
      available_exceeds_screen,
      outer_exceeds_available,
      inner_exceeds_outer,
    ] {
      assert!(WayfernConfig::fingerprint_satisfies_constraints(&fingerprint).is_err());
    }
  }

  fn complete_desktop_fingerprint(device_pixel_ratio: f64) -> serde_json::Value {
    serde_json::json!({
      "devicePixelRatio": device_pixel_ratio,
      "screenWidth": 1470,
      "screenHeight": 956,
      "screenAvailWidth": 1470,
      "screenAvailHeight": 923,
      "windowOuterWidth": 1400,
      "windowOuterHeight": 900,
      "windowInnerWidth": 1380,
      "windowInnerHeight": 800
    })
  }

  #[test]
  fn host_constraints_require_the_live_desktop_scale() {
    let fingerprint = complete_desktop_fingerprint(1.0);
    let host = FingerprintHostConstraints {
      device_pixel_ratio: Some(2.0),
      screen_max_width: Some(1470),
      screen_max_height: Some(956),
      screen_available_max_width: Some(1470),
      screen_available_max_height: Some(923),
    };

    assert!(WayfernConfig::fingerprint_satisfies_host_constraints(
      &fingerprint,
      &WayfernConfig::default(),
      host,
    )
    .is_err());
  }

  #[test]
  fn host_constraints_reject_dimensions_outside_the_live_work_area() {
    let fingerprint = complete_desktop_fingerprint(2.0);
    let host = FingerprintHostConstraints {
      device_pixel_ratio: Some(2.0),
      screen_max_width: Some(1470),
      screen_max_height: Some(956),
      screen_available_max_width: Some(1470),
      screen_available_max_height: Some(900),
    };

    assert!(WayfernConfig::fingerprint_satisfies_host_constraints(
      &fingerprint,
      &WayfernConfig::default(),
      host,
    )
    .is_err());
  }

  #[test]
  fn cross_os_device_presets_use_the_simulated_display_scale() {
    let mut fingerprint = complete_desktop_fingerprint(3.0);
    fingerprint["screenWidth"] = serde_json::json!(393);
    fingerprint["screenHeight"] = serde_json::json!(852);
    fingerprint["screenAvailWidth"] = serde_json::json!(393);
    fingerprint["screenAvailHeight"] = serde_json::json!(852);
    fingerprint["windowOuterWidth"] = serde_json::json!(393);
    fingerprint["windowOuterHeight"] = serde_json::json!(852);
    fingerprint["windowInnerWidth"] = serde_json::json!(393);
    fingerprint["windowInnerHeight"] = serde_json::json!(760);
    fingerprint["platform"] = serde_json::json!("iPhone");
    fingerprint["userAgent"] =
      serde_json::json!("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) CriOS/128 Mobile");
    fingerprint["brand"] = serde_json::json!("Google Chrome");
    fingerprint["maxTouchPoints"] = serde_json::json!(5);
    fingerprint["webglVendor"] = serde_json::json!("Apple");
    fingerprint["webglRenderer"] = serde_json::json!("Apple A17 Pro GPU, Metal");
    let config = WayfernConfig {
      device_preset: Some("iphone-15-pro".to_string()),
      os: Some("ios".to_string()),
      expected_device_pixel_ratio: Some(3.0),
      ..Default::default()
    };
    let host = FingerprintHostConstraints {
      device_pixel_ratio: Some(2.0),
      screen_max_width: Some(1470),
      screen_max_height: Some(956),
      screen_available_max_width: Some(1470),
      screen_available_max_height: Some(923),
    };

    assert!(
      WayfernConfig::fingerprint_satisfies_host_constraints(&fingerprint, &config, host).is_ok()
    );
  }
}
