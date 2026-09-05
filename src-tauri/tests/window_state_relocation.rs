//! Regression coverage for the window-state relocation's absolute-path
//! contract, exercised through the **production env-var branch** of
//! `data_dir()`.
//!
//! The in-crate unit tests in `app_dirs::tests` drive the override via the
//! `TEST_DATA_DIR` thread-local seam (env vars are process-global and would
//! race under `cargo test`'s parallel threads). That seam short-circuits
//! `data_dir()` *before* the env-var branch, so it never feeds a value to
//! `std::env::var("DONUTBROWSER_DATA_DIR")` / `DONUTBROWSER_DATA_ROOT`. This
//! binary compiles the library without `cfg(test)`, so the thread-local is
//! gone and the real env-var path runs — closing the gap the bug report names
//! ("the relative env-var case is covered nowhere").

use serial_test::serial;

/// RAII guard that restores an env var to its previous state (or removes it)
/// on drop. Mirrors `EnvironmentRestore` in `donut_proxy_integration.rs`, the
/// codebase's established pattern for env-var mutation inside `#[serial]`
/// integration tests.
struct EnvRestore {
  name: &'static str,
  previous: Option<std::ffi::OsString>,
}

impl EnvRestore {
  fn set(name: &'static str, value: &str) -> Self {
    let previous = std::env::var_os(name);
    std::env::set_var(name, value);
    Self { name, previous }
  }
}

impl Drop for EnvRestore {
  fn drop(&mut self) {
    if let Some(previous) = &self.previous {
      std::env::set_var(self.name, previous);
    } else {
      std::env::remove_var(self.name);
    }
  }
}

/// A relative `DONUTBROWSER_DATA_DIR` must NOT be handed to the window-state
/// plugin. The relocation works only with an ABSOLUTE "filename"
/// (`app_config_dir().join(absolute)` discards the base); a relative value
/// makes the plugin's write target an uncreated nested dir, `std::fs::write`
/// fails `ENOENT`, the error is swallowed, and geometry resets every launch.
/// `window_state_path_override()` must therefore return `None` so both probe
/// and plugin fall back to the platform default `app_config_dir/.window-state.json`.
#[test]
#[serial]
fn relative_data_dir_env_yields_no_window_state_override() {
  let _restore = EnvRestore::set("DONUTBROWSER_DATA_DIR", "data");
  // Sanity: the production env-var branch returns the relative value verbatim.
  assert!(
    donutbrowser_lib::app_dirs::data_dir()
      .as_path()
      .to_string_lossy()
      .starts_with("data"),
    "data_dir() should be the relative env value"
  );
  assert!(
    !donutbrowser_lib::app_dirs::data_dir().is_absolute(),
    "data_dir() should be relative under a relative override"
  );
  // The fix: a relative override is not an absolute path, so the override is
  // suppressed. Before the fix this returned Some("data/.window-state.json").
  assert_eq!(
    donutbrowser_lib::app_dirs::window_state_path_override(),
    None,
    "a relative override must not be handed to the plugin"
  );
}

/// The second trigger: a relative `DONUTBROWSER_DATA_ROOT` yields
/// `data_dir() == "<root>/data"` (relative when `<root>` is relative), which
/// must likewise produce no override.
#[test]
#[serial]
fn relative_data_root_env_yields_no_window_state_override() {
  let _restore = EnvRestore::set("DONUTBROWSER_DATA_ROOT", "data");
  let data_dir = donutbrowser_lib::app_dirs::data_dir();
  assert!(
    data_dir.ends_with("data"),
    "data_dir() should end with the data segment under DATA_ROOT"
  );
  assert!(
    !data_dir.is_absolute(),
    "data_dir() should be relative under a relative DATA_ROOT"
  );
  assert_eq!(
    donutbrowser_lib::app_dirs::window_state_path_override(),
    None,
    "a relative DATA_ROOT-derived data_dir must not be handed to the plugin"
  );
}

/// Regression guard: an ABSOLUTE `DONUTBROWSER_DATA_DIR` still relocates
/// (the supported, documented case must keep working).
#[test]
#[serial]
fn absolute_data_dir_env_relocates_window_state() {
  let abs = std::env::temp_dir()
    .join(format!(
      "donutbrowser-window-state-test-{}",
      std::process::id()
    ))
    .to_string_lossy()
    .into_owned();
  let _restore = EnvRestore::set("DONUTBROWSER_DATA_DIR", &abs);
  let expected =
    std::path::PathBuf::from(&abs).join(donutbrowser_lib::app_dirs::WINDOW_STATE_FILENAME);
  assert!(donutbrowser_lib::app_dirs::data_dir().is_absolute());
  assert_eq!(
    donutbrowser_lib::app_dirs::window_state_path_override(),
    Some(expected)
  );
}
