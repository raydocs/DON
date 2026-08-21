//! Live fingerprint auditing for a Wayfern profile.
//!
//! The browser is the authority for what a page can observe. This module keeps
//! the probe in an ordinary loopback page, then compares its result with the
//! stored fingerprint without mutating the profile. This avoids privileged
//! JavaScript evaluation commands that some Wayfern builds intentionally block.

use crate::profile::types::BrowserProfile;
use axum::{
  extract::{Path, State},
  http::{header, StatusCode},
  response::{Html, IntoResponse, Response},
  routing::{get, post},
  Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Mutex};

const JSON_STRING_FIELDS: &[&str] = &[
  "webglParameters",
  "webgl2Parameters",
  "webglShaderPrecisionFormats",
  "webgl2ShaderPrecisionFormats",
  "fonts",
  "plugins",
  "mimeTypes",
  "voices",
];

const AUDIT_FIELDS: &[(&str, &str)] = &[
  ("navigator", "userAgent"),
  ("navigator", "platform"),
  ("navigator", "platformVersion"),
  ("navigator", "brand"),
  ("navigator", "brandVersion"),
  ("navigator", "hardwareConcurrency"),
  ("navigator", "maxTouchPoints"),
  ("navigator", "deviceMemory"),
  ("navigator", "language"),
  ("navigator", "languages"),
  ("navigator", "doNotTrack"),
  ("navigator", "cookieEnabled"),
  ("navigator", "webdriver"),
  ("navigator", "pdfViewerEnabled"),
  ("screen", "screenWidth"),
  ("screen", "screenHeight"),
  ("screen", "screenAvailWidth"),
  ("screen", "screenAvailHeight"),
  ("screen", "screenColorDepth"),
  ("screen", "screenPixelDepth"),
  ("screen", "devicePixelRatio"),
  ("window", "windowOuterWidth"),
  ("window", "windowOuterHeight"),
  ("window", "windowInnerWidth"),
  ("window", "windowInnerHeight"),
  ("window", "screenX"),
  ("window", "screenY"),
  ("timezone", "timezone"),
  ("webgl", "webglVendor"),
  ("webgl", "webglRenderer"),
  ("webgl", "webglVersion"),
  ("webgl", "webglShadingLanguageVersion"),
  ("media", "prefersReducedMotion"),
  ("media", "prefersDarkMode"),
  ("media", "prefersContrast"),
  ("media", "prefersReducedData"),
  ("color", "colorGamutSrgb"),
  ("color", "colorGamutP3"),
  ("color", "colorGamutRec2020"),
  ("color", "hdrSupport"),
  ("storage", "localStorage"),
  ("storage", "sessionStorage"),
  ("storage", "indexedDb"),
  ("battery", "batteryCharging"),
  ("battery", "batteryChargingTime"),
  ("battery", "batteryDischargingTime"),
  ("battery", "batteryLevel"),
  ("fonts", "fonts"),
  ("browser", "plugins"),
  ("browser", "mimeTypes"),
  ("browser", "voices"),
  ("network", "connectionEffectiveType"),
  ("network", "connectionDownlink"),
  ("network", "connectionRtt"),
  ("performance", "performanceMemory"),
];

/// The script deliberately returns plain serializable values. Browser APIs
/// that are unavailable or permission-gated become null instead of aborting
/// the complete report.
const AUDIT_SCRIPT: &str = r#"async (expected) => {
  const valueOrNull = (callback) => {
    try {
      const value = callback();
      return value === undefined ? null : value;
    } catch {
      return null;
    }
  };

  const sha256 = async (text) => {
    try {
      if (!globalThis.crypto?.subtle) return null;
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      return null;
    }
  };

  const webglInfo = (context) => {
    if (!context) return {};
    const debug = valueOrNull(() =>
      context.getExtension("WEBGL_debug_renderer_info"),
    );
    return {
      webglVendor: debug
        ? valueOrNull(() => context.getParameter(debug.UNMASKED_VENDOR_WEBGL))
        : null,
      webglRenderer: debug
        ? valueOrNull(() => context.getParameter(debug.UNMASKED_RENDERER_WEBGL))
        : null,
      webglVersion: valueOrNull(() => context.getParameter(context.VERSION)),
      webglShadingLanguageVersion: valueOrNull(() =>
        context.getParameter(context.SHADING_LANGUAGE_VERSION),
      ),
    };
  };

  const canvas = document.createElement("canvas");
  const webgl = canvas.getContext("webgl");
  const webgl2 = canvas.getContext("webgl2");
  const webglValues = webglInfo(webgl || webgl2);

  const storageAvailable = (name) =>
    valueOrNull(() => {
      const storage = window[name];
      return storage != null;
    });

  const media = (query) => valueOrNull(() => matchMedia(query).matches);
  const connection = valueOrNull(() => navigator.connection) || {};

  const fonts = Array.isArray(expected?.fonts)
    ? expected.fonts.filter((font) => typeof font === "string")
    : [];
  const detectedFonts = fonts.filter((font) =>
    valueOrNull(() => document.fonts?.check(`12px "${font.replaceAll('"', '')}"`))
  );

  const plugins = valueOrNull(() =>
    Array.from(navigator.plugins || []).map((plugin) => ({
      name: plugin.name,
      filename: plugin.filename,
      description: plugin.description,
    })),
  );
  const mimeTypes = valueOrNull(() =>
    Array.from(navigator.mimeTypes || []).map((mime) => ({
      type: mime.type,
      description: mime.description,
      suffixes: mime.suffixes,
    })),
  );
  const voices = valueOrNull(() =>
    globalThis.speechSynthesis
      ? speechSynthesis.getVoices().map((voice) => ({
          name: voice.name,
          lang: voice.lang,
          localService: voice.localService,
        }))
      : null,
  );

  const audioHash = await (async () => {
    try {
      const AudioContextCtor =
        globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!AudioContextCtor) return null;
      const context = new AudioContextCtor(1, 4096, 44100);
      const oscillator = context.createOscillator();
      const compressor = context.createDynamicsCompressor();
      oscillator.type = "triangle";
      oscillator.frequency.value = 1000;
      oscillator.connect(compressor);
      compressor.connect(context.destination);
      oscillator.start(0);
      const rendered = await context.startRendering();
      return sha256(JSON.stringify(Array.from(rendered.getChannelData(0).slice(0, 512))));
    } catch {
      return null;
    }
  })();

  const battery = await (async () => {
    try {
      if (!navigator.getBattery) return {};
      const value = await navigator.getBattery();
      return {
        batteryCharging: value.charging,
        batteryChargingTime: value.chargingTime,
        batteryDischargingTime: value.dischargingTime,
        batteryLevel: value.level,
      };
    } catch {
      return {};
    }
  })();

  const webrtcCandidates = await (async () => {
    try {
      if (!globalThis.RTCPeerConnection) return [];
      const peer = new RTCPeerConnection({ iceServers: [] });
      const candidates = [];
      peer.onicecandidate = (event) => {
        if (event.candidate?.candidate) candidates.push(event.candidate.candidate);
      };
      peer.createDataChannel("donut-fingerprint-audit");
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await new Promise((resolve) => {
        const done = () => resolve();
        peer.addEventListener("icegatheringstatechange", () => {
          if (peer.iceGatheringState === "complete") done();
        });
        setTimeout(done, 1800);
      });
      peer.close();
      return candidates;
    } catch {
      return [];
    }
  })();

  const oopifProbe = await (async () => {
    try {
      const urls = Array.isArray(expected?.oopifUrls)
        ? expected.oopifUrls.filter((url) => typeof url === "string")
        : [];
      if (urls.length < 2) {
        return { frameCount: 0, crossOrigin: false, children: [] };
      }

      const children = [];
      const childOrigins = new Set();
      const receiveChild = (event) => {
        const message = event.data;
        if (
          message?.auditToken !== expected?.auditToken ||
          typeof message?.child?.origin !== "string" ||
          childOrigins.has(message.child.origin)
        ) {
          return;
        }
        childOrigins.add(message.child.origin);
        children.push(message.child);
      };
      window.addEventListener("message", receiveChild);
      const frames = urls.map((url, index) => {
        const existing = document.getElementById(`__donut_fingerprint_audit_oopif_${index}`);
        existing?.remove();
        const frame = document.createElement("iframe");
        frame.id = `__donut_fingerprint_audit_oopif_${index}`;
        frame.setAttribute("aria-hidden", "true");
        frame.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
        frame.src = url;
        document.documentElement.appendChild(frame);
        return frame;
      });
      await Promise.all(
        frames.map(
          (frame) =>
            new Promise((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
              };
              frame.addEventListener("load", finish, { once: true });
              frame.addEventListener("error", finish, { once: true });
              setTimeout(finish, 2500);
            }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const crossOrigin = frames.some((frame) => {
        try {
          void frame.contentWindow.location.href;
          return false;
        } catch {
          return true;
        }
      });
      window.removeEventListener("message", receiveChild);
      frames.forEach((frame) => frame.remove());
      return {
        frameCount: frames.length,
        crossOrigin,
        children,
      };
    } catch {
      return {
        frameCount: 0,
        crossOrigin: false,
        children: [],
      };
    }
  })();

  const userAgentData = valueOrNull(() => navigator.userAgentData);
  const brands = valueOrNull(() => userAgentData?.brands || null);
  const highEntropy = await (async () => {
    try {
      if (!userAgentData?.getHighEntropyValues) return {};
      return await userAgentData.getHighEntropyValues([
        "fullVersionList",
        "platformVersion",
      ]);
    } catch {
      return {};
    }
  })();
  const fullVersionList = Array.isArray(highEntropy?.fullVersionList)
    ? highEntropy.fullVersionList
    : [];
  const matchingBrands = [
    ...fullVersionList,
    ...(Array.isArray(brands) ? brands : []),
  ].filter((item) => item?.brand === expected?.brand);
  const selectedBrand = matchingBrands.find(
    (item) => item?.version === expected?.brandVersion,
  ) || matchingBrands[0] || null;
  const performanceMemory = valueOrNull(() => performance.memory?.jsHeapSizeLimit);
  const webglParameters = webglValues.webglVendor || webglValues.webglRenderer
    ? { vendor: webglValues.webglVendor, renderer: webglValues.webglRenderer }
    : null;
  const mediaDevices = await (async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return null;
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.map((device) => device.kind);
    } catch {
      return null;
    }
  })();

  return {
    userAgent: valueOrNull(() => navigator.userAgent),
    platform: valueOrNull(() => navigator.platform),
    platformVersion: valueOrNull(() => highEntropy?.platformVersion || null),
    brand: selectedBrand?.brand || null,
    brandVersion: selectedBrand?.version || null,
    hardwareConcurrency: valueOrNull(() => navigator.hardwareConcurrency),
    maxTouchPoints: valueOrNull(() => navigator.maxTouchPoints),
    deviceMemory: valueOrNull(() => navigator.deviceMemory),
    language: valueOrNull(() => navigator.language),
    languages: valueOrNull(() => navigator.languages),
    doNotTrack: valueOrNull(() => navigator.doNotTrack),
    cookieEnabled: valueOrNull(() => navigator.cookieEnabled),
    webdriver: valueOrNull(() => navigator.webdriver),
    pdfViewerEnabled: valueOrNull(() => navigator.pdfViewerEnabled),
    screenWidth: valueOrNull(() => screen.width),
    screenHeight: valueOrNull(() => screen.height),
    screenAvailWidth: valueOrNull(() => screen.availWidth),
    screenAvailHeight: valueOrNull(() => screen.availHeight),
    screenColorDepth: valueOrNull(() => screen.colorDepth),
    screenPixelDepth: valueOrNull(() => screen.pixelDepth),
    devicePixelRatio: valueOrNull(() => window.devicePixelRatio),
    windowOuterWidth: valueOrNull(() => window.outerWidth),
    windowOuterHeight: valueOrNull(() => window.outerHeight),
    windowInnerWidth: valueOrNull(() => window.innerWidth),
    windowInnerHeight: valueOrNull(() => window.innerHeight),
    screenX: valueOrNull(() => window.screenX),
    screenY: valueOrNull(() => window.screenY),
    timezone: valueOrNull(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    ...webglValues,
    webglParameters,
    prefersReducedMotion: media("(prefers-reduced-motion: reduce)"),
    prefersDarkMode: media("(prefers-color-scheme: dark)"),
    prefersContrast: media("(prefers-contrast: more)") ? "more" : "no-preference",
    prefersReducedData: media("(prefers-reduced-data: reduce)"),
    colorGamutSrgb: media("(color-gamut: srgb)"),
    colorGamutP3: media("(color-gamut: p3)"),
    colorGamutRec2020: media("(color-gamut: rec2020)"),
    hdrSupport: media("(dynamic-range: high)"),
    localStorage: storageAvailable("localStorage"),
    sessionStorage: storageAvailable("sessionStorage"),
    indexedDb: valueOrNull(() => typeof indexedDB !== "undefined"),
    ...battery,
    fonts: detectedFonts,
    plugins,
    mimeTypes,
    voices,
    connectionEffectiveType: valueOrNull(() => connection.effectiveType),
    connectionDownlink: valueOrNull(() => connection.downlink),
    connectionRtt: valueOrNull(() => connection.rtt),
    performanceMemory,
    audioHash,
    mediaDevices,
    webrtcCandidates,
    oopifProbe,
  };
}"#;

#[derive(Debug, Clone, Serialize)]
pub struct FingerprintAuditItem {
  pub category: String,
  pub key: String,
  pub expected: Option<Value>,
  pub actual: Option<Value>,
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FingerprintAuditSummary {
  pub total: usize,
  pub matches: usize,
  pub mismatches: usize,
  pub unknown: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct FingerprintAuditFrame {
  pub origin: String,
  pub status: String,
  pub device_pixel_ratio: Option<f64>,
  pub screen_width: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FingerprintAuditOopif {
  pub status: String,
  pub frame_count: u64,
  pub child_device_pixel_ratio: Option<f64>,
  pub child_screen_width: Option<f64>,
  pub children: Vec<FingerprintAuditFrame>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FingerprintAuditReport {
  pub profile_id: String,
  pub profile_name: String,
  pub generated_at: u64,
  pub target: String,
  pub summary: FingerprintAuditSummary,
  pub items: Vec<FingerprintAuditItem>,
  pub observations: Vec<FingerprintAuditItem>,
  pub oopif: FingerprintAuditOopif,
}

fn stored_fingerprint(profile: &BrowserProfile) -> Value {
  let Some(raw) = profile
    .wayfern_config
    .as_ref()
    .and_then(|config| config.fingerprint.as_deref())
  else {
    return json!({});
  };
  let parsed = serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({}));
  parsed.get("fingerprint").cloned().unwrap_or(parsed)
}

fn expected_value(key: &str, value: &Value) -> Value {
  if key == "deviceMemory" {
    return crate::wayfern_manager::page_visible_device_memory(value);
  }
  if JSON_STRING_FIELDS.contains(&key) {
    if let Some(raw) = value.as_str() {
      if let Ok(parsed) = serde_json::from_str(raw) {
        return parsed;
      }
    }
  }
  value.clone()
}

fn values_match(expected: &Value, actual: &Value) -> bool {
  if expected == actual {
    return true;
  }
  match (expected.as_f64(), actual.as_f64()) {
    (Some(left), Some(right)) => (left - right).abs() < 0.000_001,
    _ => false,
  }
}

fn compare_item(
  category: &str,
  key: &str,
  expected: Option<Value>,
  actual: Option<Value>,
) -> FingerprintAuditItem {
  let (status, detail) = match (&expected, &actual) {
    (Some(expected), Some(actual)) if values_match(expected, actual) => ("match", None),
    (Some(_), Some(_)) => ("mismatch", None),
    (None, Some(_)) => ("unknown", Some("No stored value to compare".to_string())),
    (Some(_), None) => (
      "unknown",
      Some("The browser did not expose this value".to_string()),
    ),
    (None, None) => (
      "unknown",
      Some("Neither stored nor live value is available".to_string()),
    ),
  };
  FingerprintAuditItem {
    category: category.to_string(),
    key: key.to_string(),
    expected,
    actual,
    status: status.to_string(),
    detail,
  }
}

fn summarize(items: &[FingerprintAuditItem]) -> FingerprintAuditSummary {
  let mut summary = FingerprintAuditSummary {
    total: items.len(),
    matches: 0,
    mismatches: 0,
    unknown: 0,
  };
  for item in items {
    match item.status.as_str() {
      "match" => summary.matches += 1,
      "mismatch" => summary.mismatches += 1,
      _ => summary.unknown += 1,
    }
  }
  summary
}

const COLLECTOR_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct CollectorState {
  token: String,
  expected_rx: watch::Receiver<Option<Value>>,
  result_tx: Arc<Mutex<Option<oneshot::Sender<Value>>>>,
}

struct AuditCollector {
  token: String,
  loopback_base: String,
  localhost_base: String,
  expected_tx: Option<watch::Sender<Option<Value>>>,
  result_rx: Option<oneshot::Receiver<Value>>,
  shutdown_tx: Option<oneshot::Sender<()>>,
  server_task: tokio::task::JoinHandle<()>,
}

struct AuditBrowserGuard {
  app_handle: tauri::AppHandle,
  profile: Option<BrowserProfile>,
}

impl AuditBrowserGuard {
  fn new(app_handle: tauri::AppHandle, profile: BrowserProfile) -> Self {
    Self {
      app_handle,
      profile: Some(profile),
    }
  }

  async fn cleanup(&mut self) -> Result<(), String> {
    let Some(profile) = self.profile.as_ref().cloned() else {
      return Ok(());
    };
    crate::browser_runner::kill_browser_profile(self.app_handle.clone(), profile).await?;
    self.profile = None;
    Ok(())
  }
}

impl Drop for AuditBrowserGuard {
  fn drop(&mut self) {
    let Some(profile) = self.profile.take() else {
      return;
    };
    let app_handle = self.app_handle.clone();
    tauri::async_runtime::spawn(async move {
      if let Err(error) = crate::browser_runner::kill_browser_profile(app_handle, profile).await {
        log::warn!("Failed to clean up dropped fingerprint audit browser: {error}");
      }
    });
  }
}

fn no_store(response: impl IntoResponse) -> Response {
  ([(header::CACHE_CONTROL, "no-store")], response).into_response()
}

fn token_matches(state: &CollectorState, token: &str) -> bool {
  state.token.as_bytes() == token.as_bytes()
}

async fn audit_page(Path(token): Path<String>, State(state): State<CollectorState>) -> Response {
  if !token_matches(&state, &token) {
    return StatusCode::NOT_FOUND.into_response();
  }
  let html = [
    r#"<!doctype html><meta charset="utf-8"><title>Fingerprint audit</title><script>
(async () => {
  try {
    const expectedResponse = await fetch("./expected", { cache: "no-store" });
    if (!expectedResponse.ok) throw new Error("expected fingerprint unavailable");
    const expected = await expectedResponse.json();
    const probe = ("#,
    AUDIT_SCRIPT,
    r#");
    const actual = await probe(expected);
    const resultResponse = await fetch("./result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(actual),
    });
    if (!resultResponse.ok) throw new Error("audit result rejected");
  } catch {
    document.body.textContent = "Fingerprint audit failed";
  }
})();
</script>"#,
  ]
  .concat();
  no_store(Html(html))
}

async fn audit_expected(
  Path(token): Path<String>,
  State(state): State<CollectorState>,
) -> Response {
  if !token_matches(&state, &token) {
    return StatusCode::NOT_FOUND.into_response();
  }
  let mut expected_rx = state.expected_rx.clone();
  let wait_for_expected = async {
    loop {
      if let Some(expected) = expected_rx.borrow().as_ref().cloned() {
        return Some(expected);
      }
      if expected_rx.changed().await.is_err() {
        return None;
      }
    }
  };
  match wait_for_expected.await {
    Some(expected) => no_store(Json(expected)),
    _ => StatusCode::GATEWAY_TIMEOUT.into_response(),
  }
}

async fn audit_frame(Path(token): Path<String>, State(state): State<CollectorState>) -> Response {
  if !token_matches(&state, &token) {
    return StatusCode::NOT_FOUND.into_response();
  }
  no_store(Html(
    r#"<!doctype html><meta charset="utf-8"><script>
(async () => {
  try {
    const expected = await fetch("./expected", { cache: "no-store" }).then((response) => response.json());
    parent.postMessage({
      auditToken: expected.auditToken,
      child: {
        origin: location.origin,
        devicePixelRatio: window.devicePixelRatio,
        screenWidth: screen.width,
      },
    }, "*");
  } catch {}
})();
</script>"#,
  ))
}

async fn audit_result(
  Path(token): Path<String>,
  State(state): State<CollectorState>,
  Json(actual): Json<Value>,
) -> Response {
  if !token_matches(&state, &token) {
    return StatusCode::NOT_FOUND.into_response();
  }
  let Some(sender) = state.result_tx.lock().await.take() else {
    return StatusCode::CONFLICT.into_response();
  };
  if sender.send(actual).is_err() {
    return StatusCode::GONE.into_response();
  }
  StatusCode::NO_CONTENT.into_response()
}

impl AuditCollector {
  async fn start() -> Result<Self, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
      .await
      .map_err(|error| format!("failed to bind fingerprint audit collector: {error}"))?;
    let port = listener
      .local_addr()
      .map_err(|error| format!("failed to read fingerprint audit address: {error}"))?
      .port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let (expected_tx, expected_rx) = watch::channel(None);
    let (result_tx, result_rx) = oneshot::channel();
    let state = CollectorState {
      token: token.clone(),
      expected_rx,
      result_tx: Arc::new(Mutex::new(Some(result_tx))),
    };
    let app = Router::new()
      .route("/{token}/audit", get(audit_page))
      .route("/{token}/expected", get(audit_expected))
      .route("/{token}/frame", get(audit_frame))
      .route("/{token}/result", post(audit_result))
      .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server_task = tokio::spawn(async move {
      if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(async {
          let _ = shutdown_rx.await;
        })
        .await
      {
        log::warn!("Fingerprint audit collector stopped unexpectedly: {error}");
      }
    });
    Ok(Self {
      token,
      loopback_base: format!("http://127.0.0.1:{port}"),
      localhost_base: format!("http://localhost:{port}"),
      expected_tx: Some(expected_tx),
      result_rx: Some(result_rx),
      shutdown_tx: Some(shutdown_tx),
      server_task,
    })
  }

  fn audit_url(&self) -> String {
    format!("{}/{}/audit", self.loopback_base, self.token)
  }

  fn set_profile(&self, profile: &BrowserProfile) {
    let expected = stored_fingerprint(profile);
    let mut probe_input = json!({
      "auditToken": self.token,
      "oopifUrls": [
        format!("{}/{}/frame", self.loopback_base, self.token),
        format!("{}/{}/frame", self.localhost_base, self.token),
      ]
    });
    for key in ["brand", "brandVersion"] {
      if let Some(value) = expected.get(key) {
        probe_input[key] = value.clone();
      }
    }
    if let Some(raw) = expected.get("fonts").and_then(Value::as_str) {
      if let Ok(fonts) = serde_json::from_str::<Value>(raw) {
        probe_input["fonts"] = fonts;
      }
    }
    if let Some(expected_tx) = &self.expected_tx {
      expected_tx.send_replace(Some(probe_input));
    }
  }

  async fn stop_server(&mut self) {
    self.expected_tx.take();
    if let Some(shutdown_tx) = self.shutdown_tx.take() {
      let _ = shutdown_tx.send(());
    }
    if tokio::time::timeout(Duration::from_secs(2), &mut self.server_task)
      .await
      .is_err()
    {
      self.server_task.abort();
    }
  }

  async fn collect(mut self) -> Result<Value, String> {
    let result_rx = self
      .result_rx
      .take()
      .ok_or_else(|| "fingerprint audit collector was already consumed".to_string())?;
    let result = match tokio::time::timeout(COLLECTOR_TIMEOUT, result_rx).await {
      Ok(Ok(actual)) => Ok(actual),
      Ok(Err(_)) => Err("fingerprint audit page closed before returning a result".to_string()),
      Err(_) => Err("fingerprint audit page timed out".to_string()),
    };
    self.stop_server().await;
    result
  }

  async fn shutdown(mut self) {
    self.stop_server().await;
  }
}

fn get_object_value<'a>(actual: &'a Value, key: &str) -> Option<&'a Value> {
  actual.get(key).filter(|value| !value.is_null())
}

fn observation(key: &str, actual: Option<Value>, detail: Option<String>) -> FingerprintAuditItem {
  FingerprintAuditItem {
    category: "observation".to_string(),
    key: key.to_string(),
    expected: None,
    actual,
    status: "observed".to_string(),
    detail,
  }
}

fn build_report(profile: &BrowserProfile, actual: Value, target: &str) -> FingerprintAuditReport {
  let expected = stored_fingerprint(profile);
  let mut items = Vec::with_capacity(AUDIT_FIELDS.len());
  for (category, key) in AUDIT_FIELDS {
    let expected_value = expected.get(*key).map(|value| expected_value(key, value));
    let actual_value = get_object_value(&actual, key).cloned();
    items.push(compare_item(category, key, expected_value, actual_value));
  }

  let mut observations = Vec::new();
  for key in [
    "audioHash",
    "mediaDevices",
    "webrtcCandidates",
    "webglParameters",
  ] {
    observations.push(observation(
      key,
      get_object_value(&actual, key).cloned(),
      None,
    ));
  }

  let probe = actual
    .get("oopifProbe")
    .cloned()
    .unwrap_or_else(|| json!({}));
  let main_device_pixel_ratio =
    get_object_value(&actual, "devicePixelRatio").and_then(Value::as_f64);
  let main_screen_width = get_object_value(&actual, "screenWidth").and_then(Value::as_f64);
  let mut children = Vec::new();
  for child_actual in probe
    .get("children")
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
  {
    let child_device_pixel_ratio = child_actual.get("devicePixelRatio").and_then(Value::as_f64);
    let child_screen_width = child_actual.get("screenWidth").and_then(Value::as_f64);
    let status = match (
      child_device_pixel_ratio.zip(main_device_pixel_ratio),
      child_screen_width.zip(main_screen_width),
    ) {
      (Some((child_dpr, main_dpr)), Some((child_width, main_width)))
        if (child_dpr - main_dpr).abs() < 0.000_001
          && (child_width - main_width).abs() < 0.000_001 =>
      {
        "match"
      }
      (Some(_), Some(_)) => "mismatch",
      _ => "unknown",
    };
    children.push(FingerprintAuditFrame {
      origin: child_actual
        .get("origin")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string(),
      status: status.to_string(),
      device_pixel_ratio: child_device_pixel_ratio,
      screen_width: child_screen_width,
    });
  }
  let frame_count = children.len() as u64;
  let frame_count = frame_count.max(probe.get("frameCount").and_then(Value::as_u64).unwrap_or(0));
  let cross_origin = probe
    .get("crossOrigin")
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let has_observed_children = !children.is_empty();
  let oopif = FingerprintAuditOopif {
    status: if has_observed_children {
      "observed"
    } else if cross_origin {
      "cross_origin_frame"
    } else if frame_count > 0 {
      "frame_present"
    } else {
      "unknown"
    }
    .to_string(),
    frame_count,
    child_device_pixel_ratio: children.first().and_then(|child| child.device_pixel_ratio),
    child_screen_width: children.first().and_then(|child| child.screen_width),
    children,
    detail: Some(if has_observed_children {
      "Loopback 127.0.0.1 and localhost frames reported their page-visible values.".to_string()
    } else if cross_origin {
      "A cross-origin frame was created but did not return page-visible values.".to_string()
    } else {
      "The browser did not expose a cross-origin frame during the probe.".to_string()
    }),
  };

  FingerprintAuditReport {
    profile_id: profile.id.to_string(),
    profile_name: profile.name.clone(),
    generated_at: std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|duration| duration.as_secs())
      .unwrap_or_default(),
    target: target.to_string(),
    summary: summarize(&items),
    items,
    observations,
    oopif,
  }
}

/// Run the audit in an ordinary page. Existing browsers receive a temporary
/// tab; stopped profiles use a temporary headless launch that is always killed.
pub async fn run(
  app_handle: &tauri::AppHandle,
  mut profile: BrowserProfile,
) -> Result<FingerprintAuditReport, String> {
  if profile.browser != "wayfern" {
    return Err("fingerprint auditing only supports Wayfern profiles".to_string());
  }

  let runner = crate::browser_runner::BrowserRunner::instance();
  let is_running = match runner
    .check_browser_status(app_handle.clone(), &profile)
    .await
  {
    Ok(is_running) => is_running,
    Err(error) => return Err(format!("failed to check browser status: {error}")),
  };
  if is_running {
    profile = crate::profile::ProfileManager::instance()
      .load_profile(&profile.id.to_string())
      .map_err(|error| format!("failed to reload running profile: {error}"))?;
  }

  let collector = AuditCollector::start().await?;
  let mut launched_for_audit: Option<AuditBrowserGuard> = None;
  let mut temporary_tab = None;
  if is_running {
    collector.set_profile(&profile);
    let profiles_dir = crate::profile::ProfileManager::instance().get_profiles_dir();
    let profile_path = crate::ephemeral_dirs::get_effective_profile_path(&profile, &profiles_dir);
    temporary_tab = Some(
      match crate::wayfern_manager::WayfernManager::instance()
        .open_temporary_url_in_tab(&profile_path.to_string_lossy(), &collector.audit_url())
        .await
      {
        Ok(tab) => tab,
        Err(error) => {
          collector.shutdown().await;
          return Err(format!("failed to open fingerprint audit tab: {error}"));
        }
      },
    );
  } else {
    let launched = match crate::browser_runner::launch_browser_profile_impl(
      app_handle.clone(),
      profile,
      Some(collector.audit_url()),
      crate::browser_runner::LaunchOptions::automation(None, true),
    )
    .await
    {
      Ok(launched) => launched,
      Err(error) => {
        collector.shutdown().await;
        return Err(format!(
          "failed to launch fingerprint audit browser: {error}"
        ));
      }
    };
    collector.set_profile(&launched);
    profile = launched.clone();
    launched_for_audit = Some(AuditBrowserGuard::new(app_handle.clone(), launched));
  }

  let mut actual = collector.collect().await;
  if let Some(tab) = temporary_tab.take() {
    if let Err(error) = crate::wayfern_manager::WayfernManager::instance()
      .close_tab(tab)
      .await
    {
      if actual.is_ok() {
        actual = Err(format!("failed to close fingerprint audit tab: {error}"));
      } else {
        log::warn!("Fingerprint audit tab cleanup also failed: {error}");
      }
    }
  }
  if let Some(mut launched) = launched_for_audit {
    if let Err(error) = launched.cleanup().await {
      if actual.is_ok() {
        actual = Err(format!("fingerprint audit browser cleanup failed: {error}"));
      } else {
        log::warn!("Fingerprint audit browser cleanup also failed: {error}");
      }
    }
  }
  actual.map(|actual| build_report(&profile, actual, "local browser"))
}

#[cfg(test)]
mod tests {
  use super::{compare_item, expected_value, summarize, AuditCollector, AUDIT_SCRIPT};
  use serde_json::json;

  #[test]
  fn json_string_expected_values_are_parsed_before_comparison() {
    assert_eq!(
      expected_value("fonts", &json!("[\"Arial\"]")),
      json!(["Arial"])
    );
    assert_eq!(
      expected_value("userAgent", &json!("[\"value\"]")),
      json!("[\"value\"]")
    );
    assert_eq!(expected_value("deviceMemory", &json!(32)), json!(8));
  }

  #[test]
  fn audit_no_longer_depends_on_runtime_evaluate() {
    let source = include_str!("fingerprint_audit.rs");
    assert!(!source.contains(&["Runtime", ".evaluate"].concat()));
  }

  #[test]
  fn audit_cleanup_is_owned_by_rust_instead_of_page_script() {
    let audit_source = include_str!("fingerprint_audit.rs");
    let wayfern_source = include_str!("wayfern_manager.rs");
    assert!(!audit_source.contains(&["window", ".close()"].concat()));
    assert!(wayfern_source.contains("/json/close/"));
  }

  #[test]
  fn audit_selects_the_expected_brand_instead_of_a_grease_entry() {
    assert!(AUDIT_SCRIPT.contains("expected?.brand"));
    assert!(AUDIT_SCRIPT.contains("fullVersionList"));
  }

  #[tokio::test]
  async fn collector_accepts_one_result_only_at_its_random_path() {
    let collector = AuditCollector::start().await.unwrap();
    collector
      .expected_tx
      .as_ref()
      .unwrap()
      .send_replace(Some(json!({ "auditToken": collector.token.clone() })));
    let client = reqwest::Client::new();
    let invalid = client
      .post(format!("{}/wrong/result", collector.loopback_base))
      .json(&json!({ "value": 1 }))
      .send()
      .await
      .unwrap();
    assert_eq!(invalid.status(), reqwest::StatusCode::NOT_FOUND);

    let accepted = client
      .post(format!(
        "{}/{}/result",
        collector.loopback_base, collector.token
      ))
      .json(&json!({ "value": 2 }))
      .send()
      .await
      .unwrap();
    assert_eq!(accepted.status(), reqwest::StatusCode::NO_CONTENT);
    assert_eq!(collector.collect().await.unwrap(), json!({ "value": 2 }));
  }

  #[test]
  fn audit_summary_counts_matches_mismatches_and_unknowns() {
    let items = vec![
      compare_item("test", "same", Some(json!(1)), Some(json!(1))),
      compare_item("test", "different", Some(json!(1)), Some(json!(2))),
      compare_item("test", "unknown", None, Some(json!(2))),
    ];
    assert_eq!(summarize(&items).total, 3);
    assert_eq!(summarize(&items).matches, 1);
    assert_eq!(summarize(&items).mismatches, 1);
    assert_eq!(summarize(&items).unknown, 1);
  }
}
