//! IP-based geolocation lookup using the MaxMind GeoLite2 database,
//! and locale generation based on country/territory information.

use crate::geoip_downloader::GeoIPDownloader;
use maxminddb::{geoip2, Reader};
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use rand::RngExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::OnceLock;

const TERRITORY_INFO_XML: &str = include_str!("territory_info.xml");

pub use crate::ip_utils::IpError;

#[derive(Debug, thiserror::Error)]
pub enum GeolocationError {
  #[error("GeoIP database not found. Please download it first.")]
  DatabaseNotFound,

  #[error("Failed to open GeoIP database: {0}")]
  DatabaseOpen(String),

  #[error("Invalid IP address: {0}")]
  InvalidIP(String),

  #[error("IP location not found: {0}")]
  LocationNotFound(String),

  #[error("Unknown territory: {0}")]
  UnknownTerritory(String),

  #[error("No language data for territory: {0}")]
  NoLanguageData(String),

  #[error("IO error: {0}")]
  Io(#[from] std::io::Error),

  #[error("IP error: {0}")]
  Ip(#[from] IpError),

  #[error("Network error: {0}")]
  Network(String),
}

/// The language part of a locale or language tag: `"en"` from `"en-US"`,
/// `"zh"` from `"zh_Hant"`.
pub fn primary_subtag(tag: &str) -> &str {
  tag.split(['-', '_']).next().unwrap_or(tag)
}

/// Shared selector over the bundled CLDR territory data. Parsing the XML costs
/// real time, and the data is immutable, so build it once.
pub fn locale_selector() -> Option<&'static LocaleSelector> {
  static SELECTOR: OnceLock<Option<LocaleSelector>> = OnceLock::new();
  SELECTOR
    .get_or_init(|| match LocaleSelector::new() {
      Ok(s) => Some(s),
      Err(e) => {
        log::warn!("Failed to build the CLDR locale selector: {e}");
        None
      }
    })
    .as_ref()
}

#[derive(Debug, Clone)]
pub struct Locale {
  pub language: String,
  pub region: Option<String>,
}

impl Locale {
  pub fn as_string(&self) -> String {
    if let Some(region) = &self.region {
      format!("{}-{}", self.language, region)
    } else {
      self.language.clone()
    }
  }
}

#[derive(Debug, Clone)]
pub struct Geolocation {
  pub locale: Locale,
  pub longitude: f64,
  pub latitude: f64,
  pub timezone: String,
}

struct LanguagePopulation {
  language: String,
  population_percent: f64,
}

pub struct LocaleSelector {
  territories: HashMap<String, Vec<LanguagePopulation>>,
}

impl LocaleSelector {
  pub fn new() -> Result<Self, GeolocationError> {
    let mut territories: HashMap<String, Vec<LanguagePopulation>> = HashMap::new();

    let mut reader = XmlReader::from_str(TERRITORY_INFO_XML);
    reader.config_mut().trim_text(true);

    let mut current_territory: Option<String> = None;
    let mut current_languages: Vec<LanguagePopulation> = Vec::new();

    let mut buf = Vec::new();

    loop {
      match reader.read_event_into(&mut buf) {
        Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
          let name = e.name();
          let name_str = name.as_ref();

          if name_str == "territory" {
            if let Some(code) = current_territory.take() {
              if !current_languages.is_empty() {
                territories.insert(code, std::mem::take(&mut current_languages));
              }
            }

            for attr in e.attributes().flatten() {
              if attr.key.as_ref() == "type" {
                current_territory = Some(attr.value.to_uppercase());
              }
            }
          } else if name_str == "languagePopulation" && current_territory.is_some() {
            let mut lang_type = None;
            let mut pop_percent = 0.0;

            for attr in e.attributes().flatten() {
              match attr.key.as_ref() {
                "type" => {
                  lang_type = Some(attr.value.to_string());
                }
                "populationPercent" => {
                  pop_percent = attr.value.parse().unwrap_or(0.0);
                }
                _ => {}
              }
            }

            if let Some(lang) = lang_type {
              current_languages.push(LanguagePopulation {
                language: lang.replace('_', "-"),
                population_percent: pop_percent,
              });
            }
          }
        }
        Ok(Event::End(ref e)) => {
          let name_ref = e.name();
          let name = name_ref.as_ref();
          if name == "territory" {
            if let Some(code) = current_territory.take() {
              if !current_languages.is_empty() {
                territories.insert(code, std::mem::take(&mut current_languages));
              }
            }
          }
        }
        Ok(Event::Eof) => break,
        Err(e) => {
          log::warn!("Error parsing territory XML: {}", e);
          break;
        }
        _ => {}
      }
      buf.clear();
    }

    Ok(Self { territories })
  }

  /// Whether CLDR associates `language` with `region` at all.
  ///
  /// Returns `None` for a territory with no language data, so callers can skip
  /// rather than guess. The test is deliberately "is this language listed for
  /// this country", not "is this the country's main language": `from_region`
  /// samples the whole listed distribution weighted by speaker share, so every
  /// listed language is one this selector itself can emit. Anything stricter
  /// would flag fingerprints Donut generated on purpose — CLDR puts `es` at
  /// 9.6% in the US and `fr` at 30% in Canada, and those get picked.
  pub fn region_speaks(&self, region: &str, language: &str) -> Option<bool> {
    let languages = self.territories.get(&region.to_uppercase())?;
    if languages.is_empty() {
      return None;
    }
    let primary = primary_subtag(language);
    Some(
      languages
        .iter()
        .any(|l| primary_subtag(&l.language).eq_ignore_ascii_case(primary)),
    )
  }

  #[allow(clippy::wrong_self_convention)]
  pub fn from_region(&self, region: &str) -> Result<Locale, GeolocationError> {
    let region_upper = region.to_uppercase();

    let languages = self
      .territories
      .get(&region_upper)
      .ok_or_else(|| GeolocationError::UnknownTerritory(region.to_string()))?;

    if languages.is_empty() {
      return Err(GeolocationError::NoLanguageData(region.to_string()));
    }

    let total: f64 = languages.iter().map(|l| l.population_percent).sum();
    let mut rng = rand::rng();
    let target = rng.random::<f64>() * total;
    let mut cumulative = 0.0;

    for lang in languages {
      cumulative += lang.population_percent;
      if cumulative >= target {
        return Ok(normalize_locale(&format!(
          "{}-{}",
          lang.language, region_upper
        )));
      }
    }

    let first_lang = &languages[0].language;
    Ok(normalize_locale(&format!(
      "{}-{}",
      first_lang, region_upper
    )))
  }
}

impl Default for LocaleSelector {
  fn default() -> Self {
    Self::new().unwrap_or(Self {
      territories: HashMap::new(),
    })
  }
}

fn normalize_locale(locale: &str) -> Locale {
  let parts: Vec<&str> = locale.split('-').collect();

  let language = parts
    .first()
    .map(|s| s.to_lowercase())
    .unwrap_or_else(|| "en".to_string());

  let mut region = None;

  for part in parts.iter().skip(1) {
    if part.len() == 4 && part.chars().all(|c| c.is_ascii_alphabetic()) {
      // Script subtag (e.g. Hans/Hant) — ignored; Wayfern fingerprint uses language+region only.
      continue;
    }
    region = Some(part.to_uppercase());
  }

  Locale { language, region }
}

pub fn get_geolocation(ip: &str) -> Result<Geolocation, GeolocationError> {
  let mmdb_path =
    GeoIPDownloader::get_mmdb_file_path().map_err(|_| GeolocationError::DatabaseNotFound)?;

  if !mmdb_path.exists() {
    return Err(GeolocationError::DatabaseNotFound);
  }

  let reader =
    Reader::open_readfile(&mmdb_path).map_err(|e| GeolocationError::DatabaseOpen(e.to_string()))?;

  let ip_addr: IpAddr =
    IpAddr::from_str(ip).map_err(|_| GeolocationError::InvalidIP(ip.to_string()))?;

  let lookup_result = reader
    .lookup(ip_addr)
    .map_err(|e| GeolocationError::LocationNotFound(e.to_string()))?;
  let city: geoip2::City = lookup_result
    .decode()
    .map_err(|e| GeolocationError::LocationNotFound(e.to_string()))?
    .ok_or_else(|| GeolocationError::LocationNotFound(ip.to_string()))?;

  let location = &city.location;

  let longitude = location
    .longitude
    .ok_or_else(|| GeolocationError::LocationNotFound("No longitude".to_string()))?;
  let latitude = location
    .latitude
    .ok_or_else(|| GeolocationError::LocationNotFound("No latitude".to_string()))?;
  let timezone = location
    .time_zone
    .ok_or_else(|| GeolocationError::LocationNotFound("No timezone".to_string()))?
    .to_string();

  let country = &city.country;
  let iso_code = country
    .iso_code
    .ok_or_else(|| GeolocationError::LocationNotFound("No country code".to_string()))?
    .to_uppercase();

  let selector = LocaleSelector::new()?;
  let locale = selector.from_region(&iso_code)?;

  Ok(Geolocation {
    locale,
    longitude,
    latitude,
    timezone,
  })
}

#[derive(Debug, Deserialize)]
struct IpApiResponse {
  status: String,
  #[serde(rename = "countryCode")]
  country_code: Option<String>,
  timezone: Option<String>,
  lat: Option<f64>,
  lon: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct IpInfoResponse {
  country: Option<String>,
  timezone: Option<String>,
  loc: Option<String>,
}

/// Fetch geolocation using online real-time APIs (ip-api.com, ipinfo.io)
/// falling back to local GeoLite2 MMDB if offline or unreachable.
pub async fn get_geolocation_async(
  ip: &str,
  proxy: Option<&str>,
) -> Result<Geolocation, GeolocationError> {
  if let Ok(geo) = fetch_online_geolocation(ip, proxy).await {
    return Ok(geo);
  }
  get_geolocation(ip)
}

async fn fetch_online_geolocation(
  ip: &str,
  proxy: Option<&str>,
) -> Result<Geolocation, GeolocationError> {
  let client_builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(4));
  let client = if let Some(proxy_url) = proxy {
    if let Ok(p) = reqwest::Proxy::all(proxy_url) {
      client_builder
        .no_proxy()
        .proxy(p)
        .build()
        .map_err(|e| GeolocationError::Network(e.to_string()))?
    } else {
      client_builder
        .build()
        .map_err(|e| GeolocationError::Network(e.to_string()))?
    }
  } else {
    client_builder
      .build()
      .map_err(|e| GeolocationError::Network(e.to_string()))?
  };

  // 1. Try ip-api.com
  let url = format!("http://ip-api.com/json/{}", ip);
  if let Ok(res) = client.get(&url).send().await {
    if res.status().is_success() {
      if let Ok(data) = res.json::<IpApiResponse>().await {
        if data.status == "success" {
          if let (Some(tz), Some(lat), Some(lon), Some(cc)) =
            (data.timezone, data.lat, data.lon, data.country_code)
          {
            let selector = LocaleSelector::new()?;
            let locale = selector.from_region(&cc.to_uppercase())?;
            log::info!(
              "Resolved online geolocation via ip-api: {} ({}, {}) -> {}",
              ip,
              lat,
              lon,
              tz
            );
            return Ok(Geolocation {
              locale,
              longitude: lon,
              latitude: lat,
              timezone: tz,
            });
          }
        }
      }
    }
  }

  // 2. Try ipinfo.io
  let url2 = format!("https://ipinfo.io/{}/json", ip);
  if let Ok(res) = client.get(&url2).send().await {
    if res.status().is_success() {
      if let Ok(data) = res.json::<IpInfoResponse>().await {
        if let (Some(tz), Some(loc), Some(cc)) = (data.timezone, data.loc, data.country) {
          let parts: Vec<&str> = loc.split(',').collect();
          if parts.len() == 2 {
            if let (Ok(lat), Ok(lon)) = (
              parts[0].trim().parse::<f64>(),
              parts[1].trim().parse::<f64>(),
            ) {
              let selector = LocaleSelector::new()?;
              let locale = selector.from_region(&cc.to_uppercase())?;
              log::info!(
                "Resolved online geolocation via ipinfo: {} ({}, {}) -> {}",
                ip,
                lat,
                lon,
                tz
              );
              return Ok(Geolocation {
                locale,
                longitude: lon,
                latitude: lat,
                timezone: tz,
              });
            }
          }
        }
      }
    }
  }

  Err(GeolocationError::LocationNotFound(format!(
    "Online lookup failed for {ip}"
  )))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_locale_selector_creation() {
    let selector = LocaleSelector::new();
    assert!(selector.is_ok());
  }

  #[test]
  fn test_locale_from_region() {
    let selector = LocaleSelector::new().unwrap();

    let us_locale = selector.from_region("US");
    assert!(us_locale.is_ok());
    let us = us_locale.unwrap();
    assert_eq!(us.region, Some("US".to_string()));

    let de_locale = selector.from_region("DE");
    assert!(de_locale.is_ok());
    let de = de_locale.unwrap();
    assert_eq!(de.region, Some("DE".to_string()));
  }

  #[test]
  fn test_locale_as_string() {
    let locale = Locale {
      language: "en".to_string(),
      region: Some("US".to_string()),
    };
    assert_eq!(locale.as_string(), "en-US");

    let locale_no_region = Locale {
      language: "en".to_string(),
      region: None,
    };
    assert_eq!(locale_no_region.as_string(), "en");
  }

  #[test]
  fn test_normalize_locale() {
    let locale = normalize_locale("en-US");
    assert_eq!(locale.language, "en");
    assert_eq!(locale.region, Some("US".to_string()));

    let zh_tw = normalize_locale("zh-TW");
    assert_eq!(zh_tw.language, "zh");
    assert_eq!(zh_tw.region, Some("TW".to_string()));

    let zh_hant_us = normalize_locale("zh-Hant-US");
    assert_eq!(zh_hant_us.language, "zh");
    assert_eq!(zh_hant_us.region, Some("US".to_string()));
  }

  #[tokio::test]
  async fn test_get_geolocation_async_palo_alto() {
    let geo = get_geolocation_async("204.252.119.24", None).await.unwrap();
    assert_eq!(geo.timezone, "America/Los_Angeles");
    assert_eq!(geo.locale.region, Some("US".to_string()));
  }
}
