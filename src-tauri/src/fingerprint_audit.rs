//! Live fingerprint auditing for a running Wayfern profile.
//!
//! The browser is the authority for what a page can observe. This module keeps
//! the probe in one CDP evaluation, then compares its result with the stored
//! fingerprint without mutating the profile. A stopped profile is launched in
//! headless automation mode by the Tauri command and cleaned up afterwards.

use crate::cdp_target::{run_command, CdpError, CdpTarget};
use crate::profile::types::BrowserProfile;
use serde::Serialize;
use serde_json::{json, Value};

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
        return { frameCount: 0, crossOrigin: false, testUrls: [] };
      }

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
      const crossOrigin = frames.some((frame) => {
        try {
          void frame.contentWindow.location.href;
          return false;
        } catch {
          return true;
        }
      });
      return {
        frameCount: window.frames.length,
        crossOrigin,
        testUrls: urls,
      };
    } catch {
      return {
        frameCount: 0,
        crossOrigin: false,
        testUrls: [],
      };
    }
  })();

  const userAgentData = valueOrNull(() => navigator.userAgentData);
  const brands = valueOrNull(() => userAgentData?.brands || null);
  const firstBrand = Array.isArray(brands) ? brands.find((item) => item?.brand && item.brand !== "Not.A/Brand") : null;
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
    platformVersion: valueOrNull(() => userAgentData?.platformVersion || null),
    brand: firstBrand?.brand || null,
    brandVersion: firstBrand?.version || null,
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

fn cdp_detail(error: CdpError) -> String {
  error.to_string()
}

fn local_oopif_urls(target: &CdpTarget) -> Vec<String> {
  let Some(port) = (match target {
    CdpTarget::Local { ws_url } => url::Url::parse(ws_url).ok().and_then(|url| url.port()),
    CdpTarget::Remote { .. } => None,
  }) else {
    return Vec::new();
  };
  vec![
    format!("http://127.0.0.1:{port}/json/version?donut_fingerprint_audit=127"),
    format!("http://localhost:{port}/json/version?donut_fingerprint_audit=localhost"),
  ]
}

async fn local_oopif_targets(target: &CdpTarget) -> Option<Vec<Value>> {
  let port = match target {
    CdpTarget::Local { ws_url } => url::Url::parse(ws_url).ok()?.port()?,
    CdpTarget::Remote { .. } => return None,
  };
  reqwest::Client::new()
    .get(format!("http://127.0.0.1:{port}/json/list"))
    .send()
    .await
    .ok()?
    .json::<Vec<Value>>()
    .await
    .ok()
}

async fn evaluate(target: &CdpTarget, expression: String) -> Result<Value, String> {
  let response = run_command(
    target,
    "Runtime.evaluate",
    json!({
      "expression": expression,
      "returnByValue": true,
      "awaitPromise": true,
      "userGesture": false,
    }),
  )
  .await
  .map_err(cdp_detail)?;
  if let Some(exception) = response.get("exceptionDetails") {
    return Err(format!("browser evaluation failed: {exception}"));
  }
  response
    .get("result")
    .and_then(|result| result.get("value"))
    .cloned()
    .ok_or_else(|| "browser evaluation returned no value".to_string())
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

/// Run the live probe and compare it to the profile's stored fingerprint.
pub async fn run(
  profile: &BrowserProfile,
  target: &CdpTarget,
) -> Result<FingerprintAuditReport, String> {
  let expected = stored_fingerprint(profile);
  let expected_for_script = {
    let mut probe_input = json!({ "oopifUrls": local_oopif_urls(target) });
    if let Some(raw) = expected.get("fonts").and_then(Value::as_str) {
      if let Ok(fonts) = serde_json::from_str::<Value>(raw) {
        probe_input["fonts"] = fonts;
      }
    }
    probe_input
  };
  let expression = format!(
    "({AUDIT_SCRIPT})({})",
    serde_json::to_string(&expected_for_script).map_err(|e| e.to_string())?
  );
  let actual = evaluate(target, expression).await?;

  let target_infos = run_command(target, "Target.getTargets", json!({}))
    .await
    .ok();
  let local_targets = local_oopif_targets(target).await;
  let _ = evaluate(
    target,
    "document.querySelectorAll('[id^=__donut_fingerprint_audit_oopif_]').forEach((frame) => frame.remove()); true".to_string(),
  )
  .await;

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
  let test_url_marker = "donut_fingerprint_audit=";
  let mut child_targets = local_targets
    .as_ref()
    .map(|targets| {
      targets
        .iter()
        .filter(|target| {
          target.get("type").and_then(Value::as_str) == Some("iframe")
            && target
              .get("url")
              .and_then(Value::as_str)
              .is_some_and(|url| url.contains(test_url_marker))
        })
        .collect::<Vec<_>>()
    })
    .unwrap_or_default();
  if child_targets.is_empty() {
    child_targets = target_infos
      .as_ref()
      .map(|result| {
        result
          .get("targetInfos")
          .and_then(Value::as_array)
          .map(|targets| {
            targets
              .iter()
              .filter(|target| {
                target.get("type").and_then(Value::as_str) == Some("iframe")
                  && target
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| url.contains(test_url_marker))
              })
              .collect::<Vec<_>>()
          })
          .unwrap_or_default()
      })
      .unwrap_or_default();
  }
  let main_device_pixel_ratio =
    get_object_value(&actual, "devicePixelRatio").and_then(Value::as_f64);
  let main_screen_width = get_object_value(&actual, "screenWidth").and_then(Value::as_f64);
  let mut children = Vec::new();
  for child in child_targets {
    let Some(ws_url) = child.get("webSocketDebuggerUrl").and_then(Value::as_str) else {
      continue;
    };
    let child_target = CdpTarget::Local {
      ws_url: ws_url.to_string(),
    };
    let child_actual = evaluate(
      &child_target,
      "({origin: location.origin, devicePixelRatio: window.devicePixelRatio, screenWidth: screen.width})".to_string(),
    )
    .await;
    let Ok(child_actual) = child_actual else {
      continue;
    };
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
  let has_oopif_target = !children.is_empty()
    || target_infos
      .as_ref()
      .and_then(|result| result.get("targetInfos"))
      .and_then(Value::as_array)
      .is_some_and(|targets| {
        targets
          .iter()
          .any(|target| target.get("type").and_then(Value::as_str) == Some("iframe"))
      });
  let oopif = FingerprintAuditOopif {
    status: if has_oopif_target {
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
    detail: Some(
      if !local_oopif_urls(target).is_empty() && has_oopif_target {
        "Local 127.0.0.1 and localhost iframe targets were inspected through CDP /json/list."
          .to_string()
      } else if has_oopif_target {
        "A cross-origin iframe target was visible to CDP.".to_string()
      } else if cross_origin {
        "A cross-origin frame was created; the browser did not expose a separate iframe target."
          .to_string()
      } else {
        "The browser did not expose a separate OOPIF target during the probe.".to_string()
      },
    ),
  };

  Ok(FingerprintAuditReport {
    profile_id: profile.id.to_string(),
    profile_name: profile.name.clone(),
    generated_at: std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|duration| duration.as_secs())
      .unwrap_or_default(),
    target: target.describe(),
    summary: summarize(&items),
    items,
    observations,
    oopif,
  })
}

#[cfg(test)]
mod tests {
  use super::{compare_item, expected_value, summarize};
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
