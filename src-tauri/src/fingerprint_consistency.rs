//! Measures a proxy's exit node and compares it to a profile's fingerprint.
//!
//! Resolve the exit IP through the upstream, geolocate it with the bundled
//! MaxMind database (the same source the fingerprint generator uses), then
//! compare its timezone and country against the fingerprint's timezone and
//! language. A mismatch (e.g. a US fingerprint behind a German exit IP) is a
//! strong anti-bot tell even though the real device never leaks.
//!
//! This module only measures. Deciding what a mismatch *means* for a launch —
//! block, warn, or ignore — belongs to `launch_gate`, which calls
//! `probe_and_check_consistency` before the browser is spawned. Launches never
//! rewrite the fingerprint silently, so a real mismatch always surfaces.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::profile::types::BrowserProfile;
use crate::proxy_manager::PROXY_MANAGER;

/// Exit-node lookups are cached per proxy for this long. A stored proxy's exit
/// geolocation is stable enough that re-resolving the exit IP through the proxy
/// on every launch is wasteful.
const EXIT_CACHE_TTL_SECS: u64 = 30 * 60;

/// Ceiling on a single exit probe. `fetch_public_ip` races six endpoints with
/// a 10s timeout each, which is fine for a background check but far longer
/// than a user will wait staring at a launch that has not started yet.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

#[derive(Clone)]
struct CachedExit {
  fetched_at: u64,
  /// The endpoint this exit was measured through. Editing a stored proxy keeps
  /// its id, so without this an entry outlives the endpoint it describes: the
  /// check would compare a re-generated fingerprint against the *old* exit and
  /// either warn about a correct profile or — worse — call a genuinely
  /// mismatched one consistent, which is exactly the tell it exists to catch.
  ///
  /// Never a loopback URL: the Xray/VPN workers a launch spins up get a fresh
  /// random port and credentials each time, so keying on those would miss on
  /// every relaunch and re-probe forever.
  identity: String,
  timezone: Option<String>,
  country_code: Option<String>,
  ip: Option<String>,
}

/// Identity of the exit a profile routes through, stable across worker
/// restarts.
///
/// `scope` keys the cache; `identity` detects that the endpoint behind that
/// key changed. Cloud-derived proxies inject a per-profile sticky-session id,
/// so two profiles sharing one stored proxy correctly get different identities
/// and never inherit each other's verdict.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExitCacheKey {
  pub scope: String,
  pub identity: String,
}

/// Resolve the cache identity from the profile's *stored* configuration.
///
/// Deliberately not derived from the normalized upstream the launcher passes
/// to the probe: for VLESS and VPN that upstream is a loopback worker whose
/// port and credentials are regenerated per launch.
pub fn exit_cache_key(profile: &BrowserProfile) -> Option<ExitCacheKey> {
  if let Some(proxy_id) = &profile.proxy_id {
    let settings = PROXY_MANAGER
      .resolve_proxy_for_profile(proxy_id, &profile.id.to_string())
      .or_else(|| PROXY_MANAGER.get_proxy_settings_by_id(proxy_id))?;
    // build_proxy_url returns the VLESS URI verbatim for vless proxies, so one
    // call covers every transport.
    return Some(ExitCacheKey {
      scope: format!("proxy:{proxy_id}"),
      identity: crate::proxy_manager::ProxyManager::build_proxy_url(&settings),
    });
  }
  if let Some(vpn_id) = &profile.vpn_id {
    return Some(ExitCacheKey {
      scope: format!("vpn:{vpn_id}"),
      identity: vpn_id.clone(),
    });
  }
  None
}

type ExitProbeResult = Result<Option<CachedExit>, String>;

struct InFlightExitProbe {
  generation: u64,
  result: Arc<tokio::sync::OnceCell<ExitProbeResult>>,
}

#[derive(Default)]
struct ExitCacheState {
  cache: HashMap<ExitCacheKey, CachedExit>,
  generations: HashMap<String, u64>,
  in_flight: HashMap<ExitCacheKey, InFlightExitProbe>,
}

lazy_static::lazy_static! {
  static ref EXIT_CACHE: Mutex<ExitCacheState> = Mutex::new(ExitCacheState::default());
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConsistencyResult {
  /// True when everything we could check lines up (or there was nothing to
  /// check — no proxy assigned).
  pub consistent: bool,
  /// True when we actually reached an exit node and compared something.
  pub checked: bool,
  pub exit_ip: Option<String>,
  pub exit_country_code: Option<String>,
  pub exit_timezone: Option<String>,
  pub fingerprint_timezone: Option<String>,
  pub fingerprint_language: Option<String>,
  /// One of "timezone", "language" — the dimensions that disagree.
  pub mismatches: Vec<String>,
}

impl ConsistencyResult {
  pub fn skip() -> Self {
    Self {
      consistent: true,
      checked: false,
      exit_ip: None,
      exit_country_code: None,
      exit_timezone: None,
      fingerprint_timezone: None,
      fingerprint_language: None,
      mismatches: Vec::new(),
    }
  }
}

/// Whether this upstream can carry a probe request at all.
///
/// Shadowsocks and anything else reqwest cannot dial directly is skipped
/// rather than guessed at.
fn probe_url(settings: &crate::browser::ProxySettings) -> Option<String> {
  match settings.proxy_type.to_lowercase().as_str() {
    "http" | "https" | "socks4" | "socks5" => Some(
      crate::proxy_manager::ProxyManager::build_probe_proxy_url(settings),
    ),
    _ => None,
  }
}

/// Whether the fingerprint's language is plausible for the exit country.
///
/// Validated against the same CLDR data the fingerprint generator samples from
/// (`geolocation::LocaleSelector`), not a hand-written country->language table.
/// The generator picks a language at random weighted by CLDR speaker share, so
/// any table naming one "expected" language per country flags fingerprints
/// Donut itself produced — roughly 10% of US profiles legitimately get `es-US`
/// and ~23% of Canadian ones get `fr-CA`. `None` means the country has no CLDR
/// data and the check is skipped.
fn language_matches_country(cc: &str, language: &str) -> Option<bool> {
  crate::geolocation::locale_selector()?.region_speaks(cc, language)
}

/// Extract (timezone, language) from a profile's stored fingerprint JSON.
fn fingerprint_locale(profile: &BrowserProfile) -> (Option<String>, Option<String>) {
  let Some(config) = &profile.wayfern_config else {
    return (None, None);
  };
  let Some(fp_str) = &config.fingerprint else {
    return (None, None);
  };
  let Ok(fp) = serde_json::from_str::<serde_json::Value>(fp_str) else {
    return (None, None);
  };
  let timezone = fp
    .get("timezone")
    .and_then(|v| v.as_str())
    .map(str::to_string);
  let language = fp
    .get("language")
    .and_then(|v| v.as_str())
    .map(str::to_string);
  (timezone, language)
}

/// A mutex whose poison is not fatal.
///
/// A panic anywhere under this lock used to brick the check process-wide.
/// That was tolerable when a failed check only skipped a warning; now a launch
/// consults it, so a poisoned lock must degrade rather than propagate.
fn exit_cache() -> std::sync::MutexGuard<'static, ExitCacheState> {
  EXIT_CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Compare a measured exit against a profile's fingerprint. Pure — no I/O.
pub fn compare_exit_to_fingerprint(
  profile: &BrowserProfile,
  exit_timezone: Option<String>,
  exit_country_code: Option<String>,
  exit_ip: Option<String>,
) -> ConsistencyResult {
  let (fp_tz, fp_lang) = fingerprint_locale(profile);
  let mut mismatches = Vec::new();

  if let (Some(exit), Some(fp)) = (&exit_timezone, &fp_tz) {
    if !exit.eq_ignore_ascii_case(fp) {
      mismatches.push("timezone".to_string());
    }
  }

  if let (Some(cc), Some(lang)) = (&exit_country_code, &fp_lang) {
    if language_matches_country(cc, lang) == Some(false) {
      mismatches.push("language".to_string());
    }
  }

  ConsistencyResult {
    consistent: mismatches.is_empty(),
    checked: true,
    exit_ip,
    exit_country_code,
    exit_timezone,
    fingerprint_timezone: fp_tz,
    fingerprint_language: fp_lang,
    mismatches,
  }
}

/// Look up a still-valid cached exit for this profile.
fn cached_exit(key: &ExitCacheKey) -> Option<CachedExit> {
  let now = crate::proxy_manager::now_secs();
  let mut state = exit_cache();
  let cached = state
    .cache
    .get(key)
    .filter(|cached| {
      cached.identity == key.identity && now.saturating_sub(cached.fetched_at) < EXIT_CACHE_TTL_SECS
    })
    .cloned();
  if cached.is_none() {
    state.cache.remove(key);
  }
  cached
}

async fn cached_or_probe_exit<F, Fut>(
  key: &ExitCacheKey,
  probe: F,
) -> Result<Option<CachedExit>, String>
where
  F: FnOnce() -> Fut,
  Fut: std::future::Future<Output = Result<Option<CachedExit>, String>>,
{
  let (generation, result_cell) = {
    let now = crate::proxy_manager::now_secs();
    let mut state = exit_cache();
    if let Some(cached) = state
      .cache
      .get(key)
      .filter(|cached| {
        cached.identity == key.identity
          && now.saturating_sub(cached.fetched_at) < EXIT_CACHE_TTL_SECS
      })
      .cloned()
    {
      return Ok(Some(cached));
    }
    state.cache.remove(key);

    let generation = *state.generations.get(&key.scope).unwrap_or(&0);
    let result_cell = state
      .in_flight
      .entry(key.clone())
      .or_insert_with(|| InFlightExitProbe {
        generation,
        result: Arc::new(tokio::sync::OnceCell::new()),
      })
      .result
      .clone();
    (generation, result_cell)
  };

  let result = result_cell.get_or_init(probe).await.clone();

  let mut state = exit_cache();
  let current_generation = *state.generations.get(&key.scope).unwrap_or(&0);
  let is_current = state.in_flight.get(key).is_some_and(|in_flight| {
    in_flight.generation == generation && Arc::ptr_eq(&in_flight.result, &result_cell)
  });
  if is_current {
    state.in_flight.remove(key);
    if current_generation == generation {
      if let Ok(Some(cached)) = &result {
        state.cache.insert(key.clone(), cached.clone());
      }
    }
  }

  if current_generation != generation {
    Ok(None)
  } else {
    result
  }
}

/// Cache-only check. Never performs I/O, so it is safe to call before a launch
/// and for every profile in a bulk run. Returns an unchecked result on a miss.
pub fn check_profile_consistency_cached(profile: &BrowserProfile) -> ConsistencyResult {
  let Some(key) = exit_cache_key(profile) else {
    return ConsistencyResult::skip();
  };
  let Some(cached) = cached_exit(&key) else {
    return ConsistencyResult::skip();
  };
  compare_exit_to_fingerprint(profile, cached.timezone, cached.country_code, cached.ip)
}

/// Drop any cached exit for this profile, so the next check re-measures.
pub fn invalidate_exit_cache(profile: &BrowserProfile) {
  if let Some(key) = exit_cache_key(profile) {
    invalidate_exit_cache_key(&key);
  }
}

fn invalidate_exit_cache_key(key: &ExitCacheKey) {
  let mut state = exit_cache();
  let generation = state.generations.entry(key.scope.clone()).or_default();
  *generation = generation.wrapping_add(1);
  state
    .cache
    .retain(|cached_key, _| cached_key.scope != key.scope);
  state
    .in_flight
    .retain(|probe_key, _| probe_key.scope != key.scope);
}

/// Measure the exit through an already-normalized upstream and compare it to
/// the fingerprint.
///
/// `upstream` is what the launcher will actually hand the browser — a loopback
/// worker for VLESS and VPN, the resolved endpoint for a stored proxy — so one
/// code path covers every transport. `None` means a genuine direct connection,
/// which has nothing to disagree with.
pub async fn probe_and_check_consistency(
  profile: &BrowserProfile,
  upstream: Option<&crate::browser::ProxySettings>,
  key: &ExitCacheKey,
) -> Result<ConsistencyResult, String> {
  if let Some(cached) = cached_exit(key) {
    return Ok(compare_exit_to_fingerprint(
      profile,
      cached.timezone,
      cached.country_code,
      cached.ip,
    ));
  }

  let Some(settings) = upstream else {
    return Ok(ConsistencyResult::skip());
  };
  let Some(url) = probe_url(settings) else {
    return Ok(ConsistencyResult::skip());
  };

  let identity = key.identity.clone();
  let cached = cached_or_probe_exit(key, || async move {
    // Resolve the exit IP through the proxy, then geolocate it with the SAME
    // bundled MaxMind database the fingerprint generator (and the on-demand
    // match) use. Using one geo source everywhere means the check can never
    // disagree with what generation produced — a second source (e.g. ip-api)
    // routinely reports a different IANA zone for the same IP in multi-zone
    // countries, which would flag correctly-generated fingerprints and would
    // leave the "match to proxy" fix unable to satisfy the check.
    //
    // Bounded independently of fetch_public_ip's own per-request timeout: that
    // one races six endpoints and can add up to far longer than a user will wait
    // in front of a launch.
    let fetched = tokio::time::timeout(PROBE_TIMEOUT, crate::ip_utils::fetch_public_ip(Some(&url)))
      .await
      .map_err(|_| crate::backend_error("EXIT_PROBE_FAILED"))?;
    let exit_ip = fetched.map_err(|e| crate::backend_error_with_detail("EXIT_PROBE_FAILED", e))?;

    match crate::geolocation::get_geolocation_async(&exit_ip, None).await {
      Ok(geo) => Ok(Some(CachedExit {
        fetched_at: crate::proxy_manager::now_secs(),
        identity,
        timezone: Some(geo.timezone),
        country_code: geo.locale.region.clone(),
        ip: Some(exit_ip),
      })),
      // Reached the exit but couldn't place it (database missing, or a private
      // exit IP). Skip rather than warn on an unknown location — the same
      // database gates fingerprint geo, so there's nothing to disagree with.
      Err(e) => {
        log::debug!("Consistency check: could not geolocate exit IP: {e}");
        Ok(None)
      }
    }
  })
  .await?;

  let Some(cached) = cached else {
    return Ok(ConsistencyResult::skip());
  };
  Ok(compare_exit_to_fingerprint(
    profile,
    cached.timezone,
    cached.country_code,
    cached.ip,
  ))
}

/// Warm one directly-dialable stored proxy in the background. VPN and VLESS
/// routes require launch-scoped workers, so attempting them here would add
/// process churn instead of reducing launch latency.
pub fn prewarm_profile_exit(profile: &BrowserProfile) {
  let Some(proxy_id) = profile.proxy_id.as_deref() else {
    return;
  };
  let Some(settings) = PROXY_MANAGER
    .resolve_proxy_for_profile(proxy_id, &profile.id.to_string())
    .or_else(|| PROXY_MANAGER.get_proxy_settings_by_id(proxy_id))
  else {
    return;
  };
  if probe_url(&settings).is_none() {
    return;
  }
  let Some(key) = exit_cache_key(profile) else {
    return;
  };
  let profile = profile.clone();
  tauri::async_runtime::spawn(async move {
    if let Err(error) = probe_and_check_consistency(&profile, Some(&settings), &key).await {
      log::debug!(
        "Could not prewarm fingerprint exit consistency: {}",
        crate::log_redaction::text(&error)
      );
    }
  });
}

/// Measure the exit this machine reaches without any proxy, and compare it to
/// the fingerprint.
///
/// Used when a profile declares a route that did not materialize: the browser
/// is about to connect directly, so the direct exit is the one that matters.
/// Deliberately NOT cached — a direct exit belongs to this machine's network,
/// not to any stored proxy, and it changes without a config edit.
pub async fn probe_direct_and_check(profile: &BrowserProfile) -> Result<ConsistencyResult, String> {
  let fetched = tokio::time::timeout(PROBE_TIMEOUT, crate::ip_utils::fetch_public_ip(None))
    .await
    .map_err(|_| crate::backend_error("EXIT_PROBE_FAILED"))?;
  let exit_ip = fetched.map_err(|e| crate::backend_error_with_detail("EXIT_PROBE_FAILED", e))?;

  match crate::geolocation::get_geolocation_async(&exit_ip, None).await {
    Ok(geo) => Ok(compare_exit_to_fingerprint(
      profile,
      Some(geo.timezone),
      geo.locale.region.clone(),
      Some(exit_ip),
    )),
    Err(e) => {
      log::debug!("Consistency check: could not geolocate direct exit IP: {e}");
      Ok(ConsistencyResult::skip())
    }
  }
}

/// Rewrite a profile's stored fingerprint so its geolocation (timezone,
/// language, coordinates) matches `exit_ip`, and persist it. This is the
/// on-demand resolution for the consistency warning: launches no longer rewrite
/// the fingerprint silently, so the user opts into matching it here.
///
/// `exit_ip` is the exit the consistency check already resolved, applied via
/// MaxMind directly — no second proxy round-trip — and it forces geolocation
/// even when the profile has geo spoofing disabled, since the user explicitly
/// asked to match. Takes effect on the next launch of the profile.
#[tauri::command]
pub async fn match_profile_fingerprint_to_exit(
  profile_id: String,
  exit_ip: String,
) -> Result<(), String> {
  let manager = crate::profile::ProfileManager::instance();
  let mut profile = manager
    .load_profile(&profile_id)
    .map_err(|_| serde_json::json!({ "code": "PROFILE_NOT_FOUND" }).to_string())?;

  let fingerprint = profile
    .wayfern_config
    .as_ref()
    .and_then(|config| config.fingerprint.clone())
    .ok_or_else(|| serde_json::json!({ "code": "FINGERPRINT_MATCH_FAILED" }).to_string())?;

  let geoip_override = serde_json::Value::String(exit_ip);
  let refreshed = crate::wayfern_manager::WayfernManager::refresh_fingerprint_geolocation(
    &fingerprint,
    None,
    Some(&geoip_override),
  )
  .await
  .ok_or_else(|| serde_json::json!({ "code": "FINGERPRINT_MATCH_FAILED" }).to_string())?;

  let source_fingerprint = fingerprint;
  profile = manager
    .mutate_profile(&profile_id, move |latest| {
      let config = latest
        .wayfern_config
        .as_mut()
        .filter(|config| config.fingerprint.as_deref() == Some(source_fingerprint.as_str()))
        .ok_or_else(|| "Fingerprint changed while matching it to the proxy exit".to_string())?;
      config.fingerprint = Some(refreshed);
      latest.updated_at = Some(crate::proxy_manager::now_secs());
      Ok(())
    })
    .map_err(|e| {
      serde_json::json!({ "code": "INTERNAL_ERROR", "params": { "detail": e.to_string() } })
        .to_string()
    })?;

  // The stored verdict was computed against the fingerprint we just rewrote.
  // Leaving it would re-block the very launch this fix exists to unblock.
  invalidate_exit_cache(&profile);

  Ok(())
}

/// On-demand consistency check for the post-create report: resolves the
/// profile's stored route, measures the exit through it (served from the
/// 30-minute cache when warm), and compares it against the fingerprint.
/// Unlike the launch gate this never blocks and never mints consent tokens —
/// it only reports.
#[tauri::command]
pub async fn check_profile_consistency_now(
  profile_id: String,
) -> Result<ConsistencyResult, String> {
  let manager = crate::profile::ProfileManager::instance();
  let profile = manager
    .load_profile(&profile_id)
    .map_err(|_| serde_json::json!({ "code": "PROFILE_NOT_FOUND" }).to_string())?;

  let Some(key) = exit_cache_key(&profile) else {
    return Ok(ConsistencyResult::skip());
  };

  // Resolve the same upstream the launcher would hand the browser. VPN
  // profiles have no persistent upstream (the worker is per-launch), so there
  // is nothing to probe for them here.
  let upstream = profile.proxy_id.as_ref().and_then(|proxy_id| {
    PROXY_MANAGER
      .resolve_proxy_for_profile(proxy_id, &profile.id.to_string())
      .or_else(|| PROXY_MANAGER.get_proxy_settings_by_id(proxy_id))
  });

  probe_and_check_consistency(&profile, upstream.as_ref(), &key).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn language_check_accepts_the_main_language_of_the_country() {
    assert_eq!(language_matches_country("US", "en-US"), Some(true));
    assert_eq!(language_matches_country("de", "de-DE"), Some(true));
    assert_eq!(language_matches_country("BR", "pt-BR"), Some(true));
  }

  #[test]
  fn language_check_accepts_what_the_fingerprint_generator_emits() {
    // These are not the "expected" language for the country, but the generator
    // samples the CLDR distribution and produces them routinely — CLDR puts es
    // at 9.6% in the US and fr at 30% in Canada. Flagging them warns the user
    // about a fingerprint Donut itself created.
    assert_eq!(language_matches_country("US", "es-US"), Some(true));
    assert_eq!(language_matches_country("CA", "fr-CA"), Some(true));
    assert_eq!(language_matches_country("CA", "en-CA"), Some(true));
  }

  #[test]
  fn language_check_flags_us_fingerprint_behind_armenian_exit() {
    // The reported scenario: a US (en) fingerprint routed through an Armenian
    // exit. Armenia's CLDR lists hy/ku/az, never en, so this must flag.
    assert_eq!(language_matches_country("AM", "en-US"), Some(false));
    // And a fingerprint actually matched to Armenia must not flag.
    assert_eq!(language_matches_country("AM", "hy-AM"), Some(true));
  }

  #[test]
  fn language_check_still_flags_implausible_combinations() {
    // Nothing in CLDR associates these with the country, so they remain the
    // anti-bot tell the check exists to surface. (Japan lists ja/ryu/ko only.)
    assert_eq!(language_matches_country("JP", "pt-BR"), Some(false));
    assert_eq!(language_matches_country("JP", "de-DE"), Some(false));
    assert_eq!(language_matches_country("BR", "ru-RU"), Some(false));
  }

  #[test]
  fn language_check_tolerates_minority_languages_the_generator_can_emit() {
    // CLDR lists ja for Brazil (0.21%, the Japanese-Brazilian community) and de
    // for the US (0.47%), and the generator samples both. They are weak signals
    // but flagging them would contradict our own fingerprints, so the check
    // accepts anything CLDR lists at all. That is the deliberate ceiling on
    // this dimension — timezone, compared exactly, carries the real signal.
    assert_eq!(language_matches_country("BR", "ja-JP"), Some(true));
    assert_eq!(language_matches_country("US", "de-DE"), Some(true));
  }

  #[test]
  fn language_check_skips_countries_without_cldr_data() {
    // The old hand-written table returned None for ~180 countries and silently
    // skipped the check; only genuinely unknown territories should do that now.
    assert_eq!(language_matches_country("ZZ", "en-US"), None);
    // Countries the old table never covered are now checked.
    assert!(language_matches_country("ID", "id-ID").is_some());
    assert!(language_matches_country("CH", "de-CH").is_some());
  }

  fn settings(
    proxy_type: &str,
    user: Option<&str>,
    pass: Option<&str>,
  ) -> crate::browser::ProxySettings {
    crate::browser::ProxySettings {
      proxy_type: proxy_type.into(),
      host: "gw.provider.io".into(),
      port: 8080,
      username: user.map(str::to_string),
      password: pass.map(str::to_string),
      vless_uri: None,
    }
  }

  #[test]
  fn probe_url_percent_encodes_credentials_and_skips_worker_transports() {
    assert_eq!(
      probe_url(&settings("http", Some("u"), Some("p"))).as_deref(),
      Some("http://u:p@gw.provider.io:8080")
    );

    // A password with URL-reserved characters must not break the authority —
    // unencoded, the `/` truncates the host and reqwest targets `u` instead.
    assert_eq!(
      probe_url(&settings("http", Some("user"), Some("ab/cd@ef"))).as_deref(),
      Some("http://user:ab%2Fcd%40ef@gw.provider.io:8080")
    );

    // Username-only proxies keep their auth.
    assert_eq!(
      probe_url(&settings("socks4", Some("justuser"), None)).as_deref(),
      Some("socks4://justuser@gw.provider.io:8080")
    );

    // Worker-backed transports cannot carry a direct reqwest probe, so they
    // are skipped rather than starting launch-scoped workers during prewarm.
    assert_eq!(probe_url(&settings("ss", None, None)), None);
    assert_eq!(probe_url(&settings("vless", None, None)), None);
  }

  #[test]
  fn probe_url_uses_socks5h_so_dns_resolves_at_the_exit() {
    let url = probe_url(&settings("socks5", Some("u"), Some("p"))).unwrap();
    assert!(
      url.starts_with("socks5h://"),
      "probe must not resolve the echo host locally, got {url}"
    );
    // The browser-facing builder is deliberately left alone.
    assert!(
      crate::proxy_manager::ProxyManager::build_proxy_url(&settings(
        "socks5",
        Some("u"),
        Some("p")
      ))
      .starts_with("socks5://")
    );
  }

  fn profile_with_fingerprint(timezone: &str, language: &str) -> BrowserProfile {
    let mut profile = BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: "p".into(),
      browser: "wayfern".into(),
      ..Default::default()
    };
    profile.wayfern_config = Some(crate::wayfern_manager::WayfernConfig {
      fingerprint: Some(
        serde_json::json!({ "timezone": timezone, "language": language }).to_string(),
      ),
      ..Default::default()
    });
    profile
  }

  #[test]
  fn compare_flags_a_timezone_mismatch() {
    let profile = profile_with_fingerprint("America/New_York", "en-US");
    let result = compare_exit_to_fingerprint(
      &profile,
      Some("Europe/Berlin".into()),
      Some("DE".into()),
      Some("1.2.3.4".into()),
    );
    assert!(result.checked);
    assert!(!result.consistent);
    assert!(result.mismatches.contains(&"timezone".to_string()));
  }

  #[test]
  fn compare_accepts_a_matching_exit() {
    let profile = profile_with_fingerprint("Europe/Berlin", "de-DE");
    let result = compare_exit_to_fingerprint(
      &profile,
      Some("Europe/Berlin".into()),
      Some("DE".into()),
      Some("1.2.3.4".into()),
    );
    assert!(result.consistent, "{:?}", result.mismatches);
  }

  #[test]
  fn compare_is_case_insensitive_on_timezone() {
    let profile = profile_with_fingerprint("Europe/Berlin", "de-DE");
    let result = compare_exit_to_fingerprint(
      &profile,
      Some("europe/berlin".into()),
      Some("DE".into()),
      None,
    );
    assert!(result.consistent);
  }

  #[test]
  fn compare_skips_dimensions_the_fingerprint_does_not_declare() {
    // A profile with no fingerprint has nothing to contradict; it must not be
    // reported as a mismatch and so must never block a launch.
    let profile = BrowserProfile {
      id: uuid::Uuid::new_v4(),
      browser: "wayfern".into(),
      ..Default::default()
    };
    let result = compare_exit_to_fingerprint(
      &profile,
      Some("Europe/Berlin".into()),
      Some("DE".into()),
      None,
    );
    assert!(result.consistent);
    assert!(result.mismatches.is_empty());
  }

  #[test]
  fn cached_check_reports_unchecked_without_a_proxy_or_vpn() {
    let profile = profile_with_fingerprint("Europe/Berlin", "de-DE");
    let result = check_profile_consistency_cached(&profile);
    assert!(!result.checked);
    assert!(result.consistent, "an unchecked profile must never block");
  }

  #[test]
  fn exit_cache_key_is_absent_without_a_proxy_or_vpn() {
    let profile = profile_with_fingerprint("Europe/Berlin", "de-DE");
    assert_eq!(exit_cache_key(&profile), None);
  }

  #[test]
  fn exit_cache_key_scopes_a_vpn_profile_by_vpn_id() {
    let mut profile = profile_with_fingerprint("Europe/Berlin", "de-DE");
    profile.vpn_id = Some("vpn-abc".into());
    let key = exit_cache_key(&profile).expect("vpn profiles must be cacheable");
    assert_eq!(key.scope, "vpn:vpn-abc");
    assert_eq!(key.identity, "vpn-abc");
  }

  #[test]
  fn cached_entry_is_ignored_once_the_endpoint_identity_changes() {
    let key = ExitCacheKey {
      scope: "proxy:test-identity-change".into(),
      identity: "http://old@host:1".into(),
    };
    exit_cache().cache.insert(
      key.clone(),
      CachedExit {
        fetched_at: crate::proxy_manager::now_secs(),
        identity: key.identity.clone(),
        timezone: Some("Europe/Berlin".into()),
        country_code: Some("DE".into()),
        ip: Some("1.2.3.4".into()),
      },
    );
    assert!(cached_exit(&key).is_some());

    // Editing a stored proxy keeps its id but changes the endpoint; the old
    // measurement must not be reused for the new one.
    let rotated = ExitCacheKey {
      identity: "http://new@host:2".into(),
      ..key.clone()
    };
    assert!(cached_exit(&rotated).is_none());
    invalidate_exit_cache_key(&key);
  }

  #[test]
  fn cached_entry_expires_after_the_ttl() {
    let key: ExitCacheKey = ExitCacheKey {
      scope: "proxy:test-ttl".into(),
      identity: "http://host:1".into(),
    };
    exit_cache().cache.insert(
      key.clone(),
      CachedExit {
        fetched_at: crate::proxy_manager::now_secs() - EXIT_CACHE_TTL_SECS - 1,
        identity: key.identity.clone(),
        timezone: Some("Europe/Berlin".into()),
        country_code: Some("DE".into()),
        ip: None,
      },
    );
    assert!(cached_exit(&key).is_none());
    invalidate_exit_cache_key(&key);
  }

  #[tokio::test]
  async fn concurrent_checks_share_one_exit_probe() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let key = ExitCacheKey {
      scope: format!("proxy:singleflight-{}", uuid::Uuid::new_v4()),
      identity: "http://session-a@gateway:8080".into(),
    };
    let probes = Arc::new(AtomicUsize::new(0));
    let make_probe = || {
      let probes = Arc::clone(&probes);
      let identity = key.identity.clone();
      async move {
        probes.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        Ok(Some(CachedExit {
          fetched_at: crate::proxy_manager::now_secs(),
          identity,
          timezone: Some("Europe/Berlin".into()),
          country_code: Some("DE".into()),
          ip: Some("192.0.2.1".into()),
        }))
      }
    };

    let (first, second) = tokio::join!(
      cached_or_probe_exit(&key, &make_probe),
      cached_or_probe_exit(&key, make_probe)
    );

    assert!(first.unwrap().is_some());
    assert!(second.unwrap().is_some());
    assert_eq!(probes.load(Ordering::SeqCst), 1);
    invalidate_exit_cache_key(&key);
  }

  #[tokio::test]
  async fn failed_exit_probe_is_shared_but_not_cached() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let key = ExitCacheKey {
      scope: format!("proxy:singleflight-failure-{}", uuid::Uuid::new_v4()),
      identity: "http://session-a@gateway:8080".into(),
    };
    let probes = Arc::new(AtomicUsize::new(0));
    let make_probe = || {
      let probes = Arc::clone(&probes);
      async move {
        probes.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        Err("probe failed".to_string())
      }
    };

    let (first, second) = tokio::join!(
      cached_or_probe_exit(&key, &make_probe),
      cached_or_probe_exit(&key, make_probe)
    );
    assert!(matches!(first, Err(ref error) if error == "probe failed"));
    assert!(matches!(second, Err(ref error) if error == "probe failed"));
    assert_eq!(probes.load(Ordering::SeqCst), 1);

    let retry = cached_or_probe_exit(&key, || {
      let probes = Arc::clone(&probes);
      async move {
        probes.fetch_add(1, Ordering::SeqCst);
        Err("retry failed".to_string())
      }
    })
    .await;
    assert!(matches!(retry, Err(ref error) if error == "retry failed"));
    assert_eq!(probes.load(Ordering::SeqCst), 2);
    invalidate_exit_cache_key(&key);
  }

  #[tokio::test]
  async fn invalidation_during_a_probe_discards_its_stale_result() {
    use std::sync::Arc;

    let key = ExitCacheKey {
      scope: format!("proxy:singleflight-invalidate-{}", uuid::Uuid::new_v4()),
      identity: "http://session-a@gateway:8080".into(),
    };
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let probe_key = key.clone();
    let probe = tokio::spawn({
      let started = Arc::clone(&started);
      let release = Arc::clone(&release);
      async move {
        let identity = probe_key.identity.clone();
        cached_or_probe_exit(&probe_key, || async move {
          started.notify_one();
          release.notified().await;
          Ok(Some(CachedExit {
            fetched_at: crate::proxy_manager::now_secs(),
            identity,
            timezone: Some("Europe/Berlin".into()),
            country_code: Some("DE".into()),
            ip: Some("192.0.2.1".into()),
          }))
        })
        .await
      }
    });

    started.notified().await;
    invalidate_exit_cache_key(&key);
    release.notify_one();
    assert!(probe.await.unwrap().unwrap().is_none());
    assert!(cached_exit(&key).is_none());
  }

  #[test]
  fn exit_cache_survives_a_poisoned_lock() {
    // A panic under this lock must degrade the check, not brick every
    // subsequent launch that consults it.
    let _ = std::thread::spawn(|| {
      let _guard = EXIT_CACHE.lock().unwrap();
      panic!("poison the cache");
    })
    .join();
    assert!(EXIT_CACHE.is_poisoned());
    exit_cache().generations.remove("nonexistent-scope");
  }
}
