//! Single-profile updates shared by the desktop, REST and MCP.
use serde::{Deserialize, Deserializer, Serialize};

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
  deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
  Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Serialize, Deserialize, utoipa::ToSchema)]
pub struct UpdateProfileRequest {
  pub name: Option<String>,
  pub version: Option<String>,
  pub release_type: Option<String>,
  /// Omission preserves the route; null or an empty string removes it.
  #[serde(default, deserialize_with = "present")]
  #[schema(value_type = Option<String>)]
  pub proxy_id: Option<Option<String>>,
  /// Omission preserves the VPN; null or an empty string removes it.
  /// Assigning a VPN replaces an existing proxy, unless both are specified.
  #[serde(default, deserialize_with = "present")]
  #[schema(value_type = Option<String>)]
  pub vpn_id: Option<Option<String>>,
  #[serde(default, deserialize_with = "present")]
  #[schema(value_type = Option<String>)]
  pub group_id: Option<Option<String>>,
  #[serde(default, deserialize_with = "present")]
  #[schema(value_type = Option<String>)]
  pub extension_group_id: Option<Option<String>>,
  #[serde(default, deserialize_with = "present")]
  #[schema(value_type = Option<String>)]
  pub launch_hook: Option<Option<String>>,
  #[serde(default, deserialize_with = "present")]
  #[schema(value_type = Option<String>)]
  pub note: Option<Option<String>>,
  #[serde(default, deserialize_with = "present")]
  #[schema(value_type = Option<String>)]
  pub status_id: Option<Option<String>>,
  /// Null or an empty string restores proxy DNS; omission preserves it.
  #[serde(default, deserialize_with = "present")]
  #[schema(value_type = Option<String>)]
  pub dns_server: Option<Option<String>>,
  #[serde(default, deserialize_with = "present")]
  #[schema(value_type = Option<String>)]
  pub dns_blocklist: Option<Option<String>>,
  pub tags: Option<Vec<String>>,
  pub proxy_bypass_rules: Option<Vec<String>>,
  pub start_urls: Option<Vec<String>>,
  pub clear_on_close: Option<bool>,
  /// Sync transitions have their own lifecycle. Send this field alone.
  pub sync_mode: Option<String>,
}

impl UpdateProfileRequest {
  pub(crate) fn fields(&self) -> Vec<&'static str> {
    [
      (self.name.is_some(), "name"),
      (self.version.is_some(), "version"),
      (self.release_type.is_some(), "release_type"),
      (self.proxy_id.is_some(), "proxy"),
      (self.vpn_id.is_some(), "vpn"),
      (self.group_id.is_some(), "group"),
      (self.extension_group_id.is_some(), "extension_group"),
      (self.launch_hook.is_some(), "launch_hook"),
      (self.note.is_some(), "note"),
      (self.status_id.is_some(), "status"),
      (self.dns_server.is_some(), "dns_server"),
      (self.dns_blocklist.is_some(), "dns_blocklist"),
      (self.tags.is_some(), "tags"),
      (self.proxy_bypass_rules.is_some(), "proxy_bypass_rules"),
      (self.start_urls.is_some(), "start_urls"),
      (self.clear_on_close.is_some(), "clear_on_close"),
    ]
    .into_iter()
    .filter_map(|(present, field)| present.then_some(field))
    .collect()
  }

  pub(crate) fn apply_to(
    &self,
    profile: &mut super::types::BrowserProfile,
    patch: &super::patch::ProfilePatch,
    binaries_dir: &std::path::Path,
  ) -> Result<(), String> {
    use crate::browser::{create_browser, BrowserType};
    if (self.version.is_some() || self.release_type.is_some() || self.group_id.is_some())
      && super::trash::is_running_locally(profile)
    {
      return Err(crate::backend_error("PROFILE_RUNNING"));
    }
    if self.clear_on_close == Some(true) && (profile.ephemeral || profile.password_protected) {
      return Err(crate::backend_error("CLEAR_ON_CLOSE_UNAVAILABLE"));
    }
    if self.release_type.as_deref().is_some_and(|v| v != "stable") {
      return Err(crate::backend_error("WAYFERN_VERSION_NOT_AVAILABLE"));
    }
    if let Some(version) = &self.version {
      if version.trim().is_empty()
        || version.contains(['/', '\\'])
        || version == "."
        || version == ".."
      {
        return Err(crate::backend_error("WAYFERN_VERSION_NOT_AVAILABLE"));
      }
      let browser_type = BrowserType::from_str(&profile.browser)
        .map_err(|_| crate::backend_error("INTERNAL_ERROR"))?;
      if !create_browser(browser_type).is_version_downloaded(version, binaries_dir) {
        return Err(crate::backend_error("WAYFERN_VERSION_NOT_AVAILABLE"));
      }
    }
    if let Some(Some(id)) = &patch.extension_group_id {
      crate::extension_manager::EXTENSION_MANAGER
        .lock()
        .map_err(|_| crate::backend_error("INTERNAL_ERROR"))?
        .validate_group_compatibility(id, &profile.browser)
        .map_err(|e| crate::wrap_backend_error(e, "Invalid extension group"))?;
    }
    let normalize = |id: &Option<Option<String>>| {
      id.as_ref().map(|id| {
        id.as_ref()
          .map(|id| id.trim().to_string())
          .filter(|id| !id.is_empty())
      })
    };
    let proxy = normalize(&self.proxy_id);
    let vpn = normalize(&self.vpn_id);
    let (proxy, vpn) = final_routes(profile, proxy, vpn)?;
    if self.proxy_id.is_some() {
      if let Some(id) = &proxy {
        if crate::proxy_manager::PROXY_MANAGER
          .get_proxy_settings_by_id(id)
          .is_none()
        {
          return Err(crate::backend_error("PROXY_NOT_FOUND"));
        }
      }
    }
    if self.vpn_id.is_some() {
      if let Some(id) = &vpn {
        crate::vpn::VPN_STORAGE
          .lock()
          .map_err(|_| crate::backend_error("INTERNAL_ERROR"))?
          .load_config(id)
          .map_err(|_| crate::backend_error("VPN_NOT_FOUND"))?;
      }
    }
    patch.apply_to(profile);
    profile.proxy_id = proxy;
    profile.vpn_id = vpn;
    if let Some(name) = &self.name {
      profile.name = name.trim().to_string();
    }
    if let Some(tags) = &self.tags {
      let mut normalized = Vec::new();
      for tag in tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
      {
        if !normalized.iter().any(|t| t == tag) {
          normalized.push(tag.to_string());
        }
      }
      profile.tags = normalized;
    }
    if let Some(version) = &self.version {
      profile.version = version.clone();
      profile.release_type = "stable".into();
      if !crate::wayfern_manager::supports_identity_api(version) {
        if let Some(config) = profile
          .wayfern_config
          .as_mut()
          .filter(|c| c.identity_id.is_some())
        {
          config.identity_id = None;
          config.identity_baseline = None;
          config.fingerprint = None;
          config.geo_proxy_signature = None;
        }
      }
    }
    if let Some(release) = &self.release_type {
      profile.release_type = release.clone();
    }
    Ok(())
  }

  pub fn has_metadata_changes(&self) -> bool {
    !self.fields().is_empty()
  }
}

fn final_routes(
  profile: &super::types::BrowserProfile,
  proxy: Option<Option<String>>,
  vpn: Option<Option<String>>,
) -> Result<(Option<String>, Option<String>), String> {
  let mut next_proxy = proxy.clone().unwrap_or_else(|| profile.proxy_id.clone());
  let mut next_vpn = vpn.clone().unwrap_or_else(|| profile.vpn_id.clone());
  if proxy.as_ref().is_some_and(Option::is_some) && vpn.is_none() {
    next_vpn = None;
  }
  if vpn.as_ref().is_some_and(Option::is_some) && proxy.is_none() {
    next_proxy = None;
  }
  if next_proxy.is_some() && next_vpn.is_some() {
    return Err(crate::backend_error("PROXY_AND_VPN_MUTUALLY_EXCLUSIVE"));
  }
  Ok((next_proxy, next_vpn))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::profile::{BrowserProfile, ProfileManager};
  use serde_json::json;

  #[test]
  fn single_profile_update_rejection_never_publishes_earlier_fields() {
    let temp = tempfile::TempDir::new().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(temp.path().to_path_buf());
    let manager = ProfileManager::instance();
    let profile = BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: "Original".into(),
      browser: "wayfern".into(),
      wayfern_config: Some(crate::wayfern_manager::WayfernConfig {
        os: Some(super::super::types::get_host_os()),
        ..Default::default()
      }),
      note: Some("keep".into()),
      ..Default::default()
    };
    let dir = manager.get_profiles_dir().join(profile.id.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("metadata.json");
    let original = serde_json::to_vec_pretty(&profile).unwrap();
    std::fs::write(&path, &original).unwrap();
    for invalid in [
      json!({"name":"Changed", "version":"not-installed"}),
      json!({"name":"Changed", "release_type":"unknown"}),
      json!({"name":"Changed", "dns_server":"https://"}),
      json!({"name":"Changed", "dns_blocklist":"unknown"}),
      json!({"name":"Changed", "launch_hook":"file:///tmp/hook"}),
      json!({"name":"Changed", "proxy_id":"missing"}),
      json!({"name":"Changed", "status_id":"missing"}),
      json!({"name":"Changed", "group_id":"missing"}),
      json!({"name":"Changed", "proxy_id":"p", "vpn_id":"v"}),
      json!({"name":" ", "note":null}),
    ] {
      let request = serde_json::from_value(invalid.clone()).unwrap();
      assert!(
        manager
          .update_profile(&profile.id.to_string(), request)
          .is_err(),
        "{invalid}"
      );
      assert_eq!(std::fs::read(&path).unwrap(), original, "{invalid}");
    }
    let updated = manager
      .update_profile(
        &profile.id.to_string(),
        serde_json::from_value(json!({"note":null, "tags":[" a ", "a"]})).unwrap(),
      )
      .unwrap();
    assert_eq!(updated.name, "Original");
    assert_eq!(updated.note, None);
    assert_eq!(updated.tags, ["a"]);
    assert!(updated.updated_at.is_some());
    let persisted: BrowserProfile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted.note, None);
    assert_eq!(persisted.tags, ["a"]);
  }

  #[test]
  fn single_profile_update_routes_use_the_final_state() {
    let profile = BrowserProfile {
      proxy_id: Some("old".into()),
      ..Default::default()
    };
    assert_eq!(
      final_routes(&profile, None, Some(Some("vpn".into()))).unwrap(),
      (None, Some("vpn".into()))
    );
    assert_eq!(
      final_routes(&profile, Some(None), None).unwrap(),
      (None, None)
    );
    assert_eq!(
      final_routes(&profile, None, None).unwrap(),
      (Some("old".into()), None)
    );
    assert!(final_routes(&profile, Some(Some("new".into())), Some(Some("vpn".into()))).is_err());
    let absent: UpdateProfileRequest = serde_json::from_value(json!({})).unwrap();
    let clear: UpdateProfileRequest = serde_json::from_value(json!({"proxy_id":null})).unwrap();
    assert_eq!(absent.proxy_id, None);
    assert_eq!(clear.proxy_id, Some(None));
    assert!(serde_json::from_value::<UpdateProfileRequest>(json!({"tags":[1]})).is_err());
  }
}
