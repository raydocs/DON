//! Working out what the user pointed at, and where its files have to land.
//!
//! Two layout facts drive everything here:
//!
//! 1. Donut launches with `--user-data-dir` and explicitly selects its managed
//!    `Default` profile, so Chromium reads `<user-data-dir>/Default/`. A source
//!    *profile* directory therefore has to be copied one level down, not onto
//!    the root.
//! 2. Network state (`Cookies`, `TransportSecurity`, …) lives in
//!    `Default/Network/` on Windows and in `Default/` everywhere else. That
//!    split is not cosmetic: `kTriggerNetworkDataMigration` is enabled by
//!    default only on Windows, and on the other platforms Chromium actively
//!    redirects reads back to `Default/`. A profile exported from Windows is
//!    invisible on macOS until its files are moved up, and vice versa.

use std::path::{Path, PathBuf};

/// Files Chromium keeps under `Default/Network/` on Windows and directly under
/// `Default/` on macOS and Linux.
pub const NETWORK_DATA_FILES: &[&str] = &[
  "Cookies",
  "Cookies-journal",
  "Network Persistent State",
  "Reporting and NEL",
  "SCT Auditing Pending Reports",
  "Trust Tokens",
  "Trust Tokens-journal",
  "TransportSecurity",
  "Device Bound Sessions",
  "Device Bound Sessions-journal",
];

/// What the user handed us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceKind {
  /// A profile directory (holds `Preferences`): `.../Chrome/Default`.
  ProfileDir,
  /// A user-data directory whose profile lives at its root — Opera's layout.
  RootProfileUserDataDir,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceShape {
  pub kind: SourceKind,
  /// The directory holding `Preferences` — the content that becomes `Default/`.
  pub profile_dir: PathBuf,
  /// The directory holding `Local State`, when there is one. Windows keeps the
  /// DPAPI-wrapped os_crypt key there, so losing it loses every secret.
  pub user_data_dir: Option<PathBuf>,
}

/// Why a directory cannot be imported.
#[derive(Debug, PartialEq, Eq)]
pub enum RejectReason {
  /// Recognisably a Gecko profile. Worth naming explicitly: silently returning
  /// "nothing found" for a Firefox folder is what made import feel broken.
  Firefox,
  /// Not a browser profile we recognise at all.
  NotChromium,
}

/// Markers that identify a real Chromium profile directory. `Preferences` is
/// the usual one, but a profile whose prefs were wiped still has data worth
/// carrying, so any of these counts.
const CHROMIUM_PROFILE_MARKERS: &[&str] = &[
  "Preferences",
  "Secure Preferences",
  "History",
  "Cookies",
  "Bookmarks",
  "Web Data",
  "Login Data",
];

fn looks_like_chromium_profile(dir: &Path) -> bool {
  CHROMIUM_PROFILE_MARKERS
    .iter()
    .any(|marker| dir.join(marker).exists())
    // Windows-layout profiles keep Cookies one level down.
    || dir.join("Network").join("Cookies").exists()
}

fn looks_like_firefox_profile(dir: &Path) -> bool {
  // Any one of these alone can appear elsewhere; together they are conclusive.
  let markers = ["prefs.js", "places.sqlite", "cookies.sqlite", "key4.db"];
  markers.iter().filter(|m| dir.join(m).exists()).count() >= 2
}

/// Classify an import source, or explain why it cannot be one.
pub fn classify(source: &Path) -> Result<SourceShape, RejectReason> {
  if looks_like_firefox_profile(source) {
    return Err(RejectReason::Firefox);
  }
  if !looks_like_chromium_profile(source) {
    return Err(RejectReason::NotChromium);
  }

  // A directory that holds both profile markers and `Local State` is Opera's
  // root-profile layout: the user-data dir and the profile are the same place.
  let kind = if source.join("Local State").exists() {
    SourceKind::RootProfileUserDataDir
  } else {
    SourceKind::ProfileDir
  };

  let user_data_dir = match kind {
    SourceKind::RootProfileUserDataDir => Some(source.to_path_buf()),
    // For `.../Chrome/Default`, `Local State` is in `.../Chrome`. Only accept
    // the parent if it really holds one, so a profile copied to a random
    // folder does not make us read a stranger's `Local State`.
    SourceKind::ProfileDir => source.parent().and_then(|parent| {
      if parent.join("Local State").exists() {
        return Some(parent.to_path_buf());
      }
      // Opera keeps its extra profiles at `<user-data-dir>/_side_profiles/<id>`
      // but still launches them against the same user-data dir, so the
      // DPAPI-wrapped os_crypt key sits one further level up. Without this,
      // every Opera side profile imports on Windows with no secrets at all.
      if parent.file_name() == Some(std::ffi::OsStr::new("_side_profiles")) {
        return parent
          .parent()
          .filter(|root| root.join("Local State").exists())
          .map(Path::to_path_buf);
      }
      None
    }),
  };

  Ok(SourceShape {
    kind,
    profile_dir: source.to_path_buf(),
    user_data_dir,
  })
}

/// Move network data into the position the *host* Chromium build reads from.
///
/// Host, not source: the files were written by whatever browser produced them,
/// but they will be read by Wayfern running here. Getting this backwards is a
/// silent, total cookie loss on any cross-platform import.
pub fn normalize_network_dir(default_dir: &Path) -> std::io::Result<()> {
  let network_dir = default_dir.join("Network");

  let (from, to) = if cfg!(target_os = "windows") {
    (default_dir.to_path_buf(), network_dir.clone())
  } else {
    (network_dir.clone(), default_dir.to_path_buf())
  };

  if !from.exists() {
    return Ok(());
  }

  for name in NETWORK_DATA_FILES {
    let src = from.join(name);
    if !src.is_file() {
      continue;
    }
    std::fs::create_dir_all(&to)?;
    let dest = to.join(name);
    if dest.exists() {
      // Both positions hold the file. Exactly one of them is the stale
      // duplicate Chromium's migration left behind ("overwrite the new file
      // with the old file even if it exists already", network_sandbox.cc), and
      // which one depends on the host — the `from`/`to` pair above is swapped
      // by `cfg!`, so the source position is only the stale one on Windows.
      // Deleting the wrong copy is the silent, total loss the header warns
      // about, so the guard must match the swap.
      if cfg!(target_os = "windows") {
        // Windows: `from` is `Default/`, so `src` is the stale pre-migration
        // file. Drop it and keep the live `Network/` copy already at `dest`.
        std::fs::remove_file(&src)?;
        continue;
      } else {
        // non-Windows: `from` is `Network/`, so `src` is the live
        // post-migration file and `dest` (`Default/`) is the stale one. Drop
        // the stale `dest` and let the live `src` move into place below.
        std::fs::remove_file(&dest)?;
      }
    }
    std::fs::rename(&src, &dest).or_else(|_| {
      // Rename across devices can fail even within one tree on some setups.
      std::fs::copy(&src, &dest).and_then(|_| std::fs::remove_file(&src))?;
      Ok::<(), std::io::Error>(())
    })?;
  }

  if !cfg!(target_os = "windows") {
    // Chromium's migration checkpoint, and the reason an otherwise-correct
    // move is not enough. `network_sandbox.cc:478` treats the presence of
    // `NetworkDataMigrated` as proof the migration already ran, keeps the (now
    // empty) `Network/` as the data directory, and then `CleanUpOldData` at
    // `:536-540` DELETES the files we just moved up into `Default/`. A profile
    // exported from Windows would lose every cookie on first launch.
    let _ = std::fs::remove_file(network_dir.join("NetworkDataMigrated"));

    // Leave no empty `Network/` behind: harmless, but it makes a profile look
    // like it still holds network state.
    if network_dir.is_dir() && std::fs::read_dir(&network_dir)?.next().is_none() {
      let _ = std::fs::remove_dir(&network_dir);
    }
  }

  Ok(())
}

/// Where the cookie store ends up for the host platform.
pub fn host_cookie_path(default_dir: &Path) -> PathBuf {
  if cfg!(target_os = "windows") {
    default_dir.join("Network").join("Cookies")
  } else {
    default_dir.join("Cookies")
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  fn touch(path: &Path) {
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, b"x").unwrap();
  }

  #[test]
  fn plain_profile_dir_is_classified_without_a_user_data_dir() {
    let dir = TempDir::new().unwrap();
    let profile = dir.path().join("Default");
    touch(&profile.join("Preferences"));

    let shape = classify(&profile).expect("should classify");
    assert_eq!(shape.kind, SourceKind::ProfileDir);
    assert_eq!(shape.user_data_dir, None);
  }

  #[test]
  fn profile_dir_finds_local_state_in_its_parent() {
    let dir = TempDir::new().unwrap();
    let profile = dir.path().join("Default");
    touch(&profile.join("Preferences"));
    touch(&dir.path().join("Local State"));

    let shape = classify(&profile).expect("should classify");
    // Windows keeps the wrapped os_crypt key here; missing it means no secrets.
    assert_eq!(shape.user_data_dir.as_deref(), Some(dir.path()));
  }

  #[test]
  fn opera_root_layout_is_its_own_user_data_dir() {
    let dir = TempDir::new().unwrap();
    touch(&dir.path().join("Preferences"));
    touch(&dir.path().join("Local State"));

    let shape = classify(dir.path()).expect("should classify");
    assert_eq!(shape.kind, SourceKind::RootProfileUserDataDir);
    assert_eq!(shape.user_data_dir.as_deref(), Some(dir.path()));
  }

  #[test]
  fn firefox_profile_is_rejected_by_name() {
    let dir = TempDir::new().unwrap();
    touch(&dir.path().join("prefs.js"));
    touch(&dir.path().join("places.sqlite"));
    assert_eq!(classify(dir.path()), Err(RejectReason::Firefox));
  }

  #[test]
  fn empty_directory_is_rejected() {
    let dir = TempDir::new().unwrap();
    assert_eq!(classify(dir.path()), Err(RejectReason::NotChromium));
  }

  #[test]
  fn windows_layout_profile_is_recognised_without_root_markers() {
    // A profile whose only surviving data is Windows-layout cookies.
    let dir = TempDir::new().unwrap();
    touch(&dir.path().join("Network").join("Cookies"));
    assert!(classify(dir.path()).is_ok());
  }

  #[test]
  fn opera_side_profile_finds_local_state_two_levels_up() {
    let dir = TempDir::new().unwrap();
    let profile = dir.path().join("_side_profiles").join("gaming");
    touch(&profile.join("Preferences"));
    touch(&dir.path().join("Local State"));

    let shape = classify(&profile).expect("should classify");
    assert_eq!(
      shape.user_data_dir.as_deref(),
      Some(dir.path()),
      "Windows keeps the os_crypt key in the root Local State, not beside the profile"
    );
  }

  #[test]
  fn a_profile_in_an_unrelated_folder_does_not_adopt_a_strangers_local_state() {
    let dir = TempDir::new().unwrap();
    let profile = dir.path().join("_side_profiles").join("gaming");
    touch(&profile.join("Preferences"));
    // No Local State anywhere above it.
    let shape = classify(&profile).expect("should classify");
    assert_eq!(shape.user_data_dir, None);
  }

  #[test]
  fn migration_checkpoint_is_removed_so_chromium_does_not_delete_the_moved_files() {
    let dir = TempDir::new().unwrap();
    let default_dir = dir.path().join("Default");
    touch(&default_dir.join("Network").join("Cookies"));
    touch(&default_dir.join("Network").join("NetworkDataMigrated"));

    normalize_network_dir(&default_dir).unwrap();

    assert!(host_cookie_path(&default_dir).is_file());
    if !cfg!(target_os = "windows") {
      assert!(
        !default_dir
          .join("Network")
          .join("NetworkDataMigrated")
          .exists(),
        "the checkpoint makes Chromium delete the files we just moved up"
      );
      assert!(!default_dir.join("Network").exists());
    }
  }

  #[test]
  fn network_files_are_moved_into_the_host_position() {
    let dir = TempDir::new().unwrap();
    let default_dir = dir.path().join("Default");

    // Seed the file in the position the host does NOT read from.
    if cfg!(target_os = "windows") {
      touch(&default_dir.join("Cookies"));
    } else {
      touch(&default_dir.join("Network").join("Cookies"));
    }

    normalize_network_dir(&default_dir).unwrap();

    assert!(
      host_cookie_path(&default_dir).is_file(),
      "cookies must end up where this platform's Chromium reads them"
    );
  }

  #[test]
  fn stale_duplicate_in_the_source_position_is_removed() {
    let dir = TempDir::new().unwrap();
    let default_dir = dir.path().join("Default");
    touch(&default_dir.join("Cookies"));
    touch(&default_dir.join("Network").join("Cookies"));

    normalize_network_dir(&default_dir).unwrap();

    assert!(host_cookie_path(&default_dir).is_file());
    let stale = if cfg!(target_os = "windows") {
      default_dir.join("Cookies")
    } else {
      default_dir.join("Network").join("Cookies")
    };
    assert!(
      !stale.exists(),
      "the duplicate would be copied over the live file by Chromium's migration"
    );
  }

  #[test]
  fn normalize_is_idempotent() {
    let dir = TempDir::new().unwrap();
    let default_dir = dir.path().join("Default");
    touch(&default_dir.join("Network").join("Cookies"));

    normalize_network_dir(&default_dir).unwrap();
    normalize_network_dir(&default_dir).unwrap();

    assert!(host_cookie_path(&default_dir).is_file());
  }

  #[test]
  fn normalize_on_a_profile_with_no_network_data_is_a_no_op() {
    let dir = TempDir::new().unwrap();
    let default_dir = dir.path().join("Default");
    std::fs::create_dir_all(&default_dir).unwrap();
    normalize_network_dir(&default_dir).unwrap();
    assert!(!host_cookie_path(&default_dir).exists());
  }

  // Characterises the duplicate-removal branch with *distinct* contents. The
  // existing `stale_duplicate_in_the_source_position_is_removed` seeds both
  // copies with identical bytes, so it cannot tell which copy wins; this one
  // distinguishes the stale pre-migration (`Default/`) copy from the live
  // post-migration (`Network/`) copy.
  #[test]
  #[cfg(not(target_os = "windows"))]
  fn live_network_copy_survives_when_both_positions_hold_the_file() {
    let dir = TempDir::new().unwrap();
    let default_dir = dir.path().join("Default");
    std::fs::create_dir_all(&default_dir).unwrap();

    for name in ["Cookies", "TransportSecurity"] {
      std::fs::write(default_dir.join(name), b"OLD-stale").unwrap();
      std::fs::create_dir_all(default_dir.join("Network")).unwrap();
      std::fs::write(default_dir.join("Network").join(name), b"NEW-live").unwrap();
    }

    normalize_network_dir(&default_dir).unwrap();

    let kept_cookies = std::fs::read(default_dir.join("Cookies")).unwrap();
    let kept_ts = std::fs::read(default_dir.join("TransportSecurity")).unwrap();
    assert_eq!(
      kept_cookies, b"NEW-live",
      "the live post-migration Cookies must survive, not the stale pre-migration one"
    );
    assert_eq!(
      kept_ts, b"NEW-live",
      "the live post-migration TransportSecurity must survive, not the stale pre-migration one"
    );
    assert!(
      !default_dir.join("Network").exists(),
      "the live Network/ tree should have been emptied and removed"
    );
  }

  // End-to-end through the full import pipeline. A Windows-layout source in
  // the both-exist state (stale `Default/<file>` left by a migration whose cleanup
  // failed, plus the live `Network/<file>`) is imported onto a non-Windows
  // host. The live `Network/` content must survive at the host-read position —
  // not the stale `Default/` snapshot — for both a plain (non-SQLite, non-secret)
  // network file and a SQLite cookie store that goes through `VACUUM INTO` and
  // re-encryption.
  #[test]
  #[cfg(not(target_os = "windows"))]
  fn import_into_keeps_the_live_network_copy_when_both_positions_hold_the_file() {
    use rusqlite::Connection;

    let dir = TempDir::new().unwrap();
    let source = dir.path().join("Chrome").join("Default");
    let dest = dir.path().join("profile");
    let network_dir = source.join("Network");
    std::fs::create_dir_all(&network_dir).unwrap();
    std::fs::write(source.join("Preferences"), b"{}").unwrap();

    // A plain (non-SQLite, non-secret) network file. `copy_profile_tree` copies
    // it verbatim and `finalize_profile` never touches it, so the bytes that
    // survive are observable directly.
    std::fs::write(source.join("TransportSecurity"), b"OLD-stale").unwrap();
    std::fs::write(network_dir.join("TransportSecurity"), b"NEW-live").unwrap();

    // A real v24 cookie store in each position, so `copy_profile_tree`'s
    // `VACUUM INTO` snapshots both. The copies carry distinguishable plaintext
    // rows; after re-encryption the survivor is identified by its `host_key`.
    let make_cookie_db = |path: &Path, host_key: &str| {
      std::fs::create_dir_all(path.parent().unwrap()).unwrap();
      let conn = Connection::open(path).unwrap();
      conn
        .execute_batch(
          "CREATE TABLE cookies(
           creation_utc INTEGER NOT NULL,
           host_key TEXT NOT NULL,
           name TEXT NOT NULL,
           value TEXT NOT NULL DEFAULT '',
           encrypted_value BLOB NOT NULL DEFAULT '',
           path TEXT NOT NULL DEFAULT '/'
         );
         CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
         INSERT INTO meta VALUES('version','24');
         INSERT INTO meta VALUES('last_compatible_version','24');",
        )
        .unwrap();
      conn
        .execute(
          "INSERT INTO cookies(creation_utc, host_key, name, value, encrypted_value, path)
         VALUES(0, ?1, 'sid', ?2, X'', '/')",
          rusqlite::params![host_key, format!("{host_key}-value")],
        )
        .unwrap();
    };
    make_cookie_db(&source.join("Cookies"), "stale.example");
    make_cookie_db(&network_dir.join("Cookies"), "live.example");

    // The migration checkpoint: a Windows-migrated profile holds both
    // positions until Chromium's retry cleanup deletes the stale `Default/`
    // copy. Its presence is what makes the both-exist state a real Chromium
    // shape rather than a hand-assembled tree.
    std::fs::write(network_dir.join("NetworkDataMigrated"), b"").unwrap();

    let report = crate::profile_import::import_into(&source, &dest, "chromium", true)
      .expect("import should succeed");

    // (a) The plain network file: the live `Network/` bytes win, verbatim, and
    // the now-empty `Network/` tree is removed.
    assert_eq!(
      std::fs::read(dest.join("Default").join("TransportSecurity")).unwrap(),
      b"NEW-live",
      "the live post-migration TransportSecurity must survive the full pipeline"
    );
    assert!(
      !dest.join("Default").join("Network").exists(),
      "the live Network/ tree should have been emptied and removed"
    );

    // (b) The cookie store: the live row wins and is re-sealed for the host.
    assert_eq!(
      report.cookies_migrated, 1,
      "exactly the live row was carried"
    );
    let conn = Connection::open(dest.join("Default").join("Cookies")).unwrap();
    let host_key: String = conn
      .query_row("SELECT host_key FROM cookies", [], |r| r.get(0))
      .unwrap();
    assert_eq!(
      host_key, "live.example",
      "the live post-migration cookie row must survive, not the stale one"
    );
  }
}
