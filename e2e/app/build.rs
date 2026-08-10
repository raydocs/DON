//! The e2e harness app links Tauri code that calls `TaskDialogIndirect`, which
//! only exists in comctl32 v6. Without the v6 manifest the exe crashes at
//! startup with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) on Windows — the main
//! app gets its manifest from `src-tauri/build.rs`, this crate needs its own.

fn main() {
  #[cfg(target_os = "windows")]
  {
    use std::path::PathBuf;

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let manifest_path = PathBuf::from(&manifest_dir).join("../../src-tauri/app.manifest");
    if !manifest_path.exists() {
      println!("cargo:warning=app.manifest not found, skipping manifest embedding");
      return;
    }
    // Use the path directly (avoid canonicalize which adds \\?\ prefix that mt.exe rejects)
    let manifest_str = manifest_path.to_str().unwrap().replace('/', "\\");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{manifest_str}");
    println!("cargo:rerun-if-changed=../../src-tauri/app.manifest");
  }
}
