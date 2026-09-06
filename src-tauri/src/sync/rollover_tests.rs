//! Deterministic counterexamples for #111, NOT evidence of a rollover fix.
//! Exercise the production manifest/client/AEAD boundaries without a desktop,
//! credentials, password globals, retries, or timing-dependent sleeps.

use super::*;
use axum::{body::Bytes, extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use tokio::sync::Notify;

#[derive(Default)]
struct ObjectStore {
  objects: TokioMutex<HashMap<String, Vec<u8>>>,
  delayed_body: TokioMutex<Option<Vec<u8>>>,
  put_arrived: Notify,
  release_put: Notify,
}

struct TestServer {
  state: Arc<ObjectStore>,
  url: String,
  task: tokio::task::JoinHandle<()>,
}

impl TestServer {
  async fn start() -> Self {
    let state = Arc::new(ObjectStore::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let presign_url = url.clone();
    let app = Router::new()
      .route(
        "/v1/objects/stat",
        post(|State(s): State<Arc<ObjectStore>>, Json(v): Json<Value>| async move {
          Json(json!({"exists": s.objects.lock().await.contains_key(v["key"].as_str().unwrap())}))
        }),
      )
      .route(
        "/v1/objects/delete",
        post(|State(s): State<Arc<ObjectStore>>, Json(v): Json<Value>| async move {
          s.objects.lock().await.remove(v["key"].as_str().unwrap());
          Json(json!({"deleted": true, "tombstoneCreated": false}))
        }),
      )
      .route(
        "/v1/objects/{operation}",
        post(move |Json(v): Json<Value>| {
          let url = presign_url.clone();
          async move {
            Json(json!({"url": format!("{url}/data/{}", v["key"].as_str().unwrap()), "expiresAt": "unused"}))
          }
        }),
      )
      .route(
        "/data/{*key}",
        axum::routing::get(
          |State(s): State<Arc<ObjectStore>>, axum::extract::Path(key): axum::extract::Path<String>| async move {
            s.objects.lock().await.get(&key).cloned().unwrap()
          },
        )
        .put(
          |State(s): State<Arc<ObjectStore>>, axum::extract::Path(key): axum::extract::Path<String>, body: Bytes| async move {
            let delayed = s.delayed_body.lock().await.as_deref() == Some(body.as_ref());
            if delayed {
              s.put_arrived.notify_one();
              s.release_put.notified().await;
            }
            s.objects.lock().await.insert(key, body.to_vec());
          },
        ),
      )
      .with_state(state.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Self { state, url, task }
  }

  fn engine(&self) -> SyncEngine {
    SyncEngine::new(self.url.clone(), "isolated-rollover-test-token".into())
  }
}

impl Drop for TestServer {
  fn drop(&mut self) {
    self.task.abort();
  }
}

#[tokio::test]
async fn rollover_deleted_manifest_can_be_recreated_by_old_password_peer() {
  tokio::time::timeout(std::time::Duration::from_secs(10), async {
    let server = TestServer::start().await;
    let source = server.engine();
    let peer = server.engine();
    let salt = encryption::generate_salt();
    let old_key = encryption::derive_profile_key("old password", &salt).unwrap();
    let new_key = encryption::derive_profile_key("new password", &salt).unwrap();
    let manifest_key = "profiles/rollover/manifest.json";
    let local = tempfile::tempdir().unwrap();
    fs::create_dir(local.path().join("profile")).unwrap();
    fs::write(local.path().join("profile/Local State"), b"PRIVATE-MARKER").unwrap();
    let mut manifest =
      generate_manifest("rollover", local.path(), &mut HashCache::default()).unwrap();
    manifest.encrypted = true;
    peer
      .upload_manifest("rollover", &manifest, Some(&old_key), "")
      .await
      .unwrap();
    let deleted = Notify::new();
    let recreated = Notify::new();

    let rollover = async {
      // Exact delete -> ordinary manifest-read boundary in rollover. No mock
      // supplies a fabricated crypto error: download_manifest performs AEAD.
      source.client.delete(manifest_key, None).await.unwrap();
      deleted.notify_one();
      recreated.notified().await;
      source.download_manifest(manifest_key, Some(&new_key)).await
    };
    let old_peer = async {
      deleted.notified().await;
      let remote = peer
        .download_manifest(manifest_key, Some(&old_key))
        .await
        .unwrap();
      assert!(
        remote.is_none(),
        "old peer must observe the deletion window"
      );
      let diff = compute_diff_with_bias(&manifest, remote.as_ref(), DiffBias::Auto);
      assert_eq!(diff.files_to_upload.len(), 1);
      for file in diff.files_to_upload {
        let key = format!("profiles/rollover/files/{}", file.path);
        let url = peer.client.presign_upload(&key, None).await.unwrap().url;
        let bytes = fs::read(local.path().join(file.path)).unwrap();
        let ciphertext = encryption::encrypt_bytes(&old_key, &bytes).unwrap();
        peer
          .client
          .upload_bytes(&url, &ciphertext, None)
          .await
          .unwrap();
      }
      peer
        .upload_manifest("rollover", &manifest, Some(&old_key), "")
        .await
        .unwrap();
      recreated.notify_one();
    };
    let (result, ()) = tokio::join!(rollover, old_peer);
    let error = result.unwrap_err().to_string();
    assert!(error.contains("Failed to decrypt manifest: Decryption failed: aead::Error"));
    assert!(peer
      .download_manifest(manifest_key, Some(&old_key))
      .await
      .unwrap()
      .is_some());
  })
  .await
  .expect("barrier-controlled manifest race timed out");
}

#[tokio::test]
async fn rollover_force_upload_still_allows_a_delayed_old_key_file_put() {
  tokio::time::timeout(std::time::Duration::from_secs(10), async {
    let server = TestServer::start().await;
    let source = server.engine();
    let peer = server.engine();
    let salt = encryption::generate_salt();
    let old_key = encryption::derive_profile_key("old password", &salt).unwrap();
    let new_key = encryption::derive_profile_key("new password", &salt).unwrap();
    let fixtures = [
      ("profile/Local State", b"FIRST-PRIVATE-MARKER".as_slice()),
      (
        "profile/Default/Preferences",
        b"SECOND-PRIVATE-MARKER".as_slice(),
      ),
    ];
    let mut manifest = SyncManifest::new("rollover".into(), vec![]);
    manifest.encrypted = true;
    for (path, bytes) in fixtures {
      manifest
        .files
        .push(super::super::manifest::ManifestFileEntry {
          path: path.into(),
          size: bytes.len() as u64,
          mtime: 1,
          hash: blake3::hash(bytes).to_hex().to_string(),
        });
    }
    let file_key = format!("profiles/rollover/files/{}", fixtures[0].0);
    let delayed = encryption::encrypt_bytes(&old_key, fixtures[0].1).unwrap();
    *server.state.delayed_body.lock().await = Some(delayed.clone());
    let presign = peer.client.presign_upload(&file_key, None).await.unwrap();
    let old_put = peer.client.upload_bytes(&presign.url, &delayed, None);
    let rollover = async {
      // The HTTP server has received the old PUT, but has not committed it.
      server.state.put_arrived.notified().await;
      // Model the proposed force-upload fix: do not delete/read the old
      // manifest, rewrite ALL files, then publish the new manifest last.
      for (path, bytes) in fixtures {
        let key = format!("profiles/rollover/files/{path}");
        let url = source.client.presign_upload(&key, None).await.unwrap().url;
        let ciphertext = encryption::encrypt_bytes(&new_key, bytes).unwrap();
        source
          .client
          .upload_bytes(&url, &ciphertext, None)
          .await
          .unwrap();
      }
      source
        .upload_manifest("rollover", &manifest, Some(&new_key), "")
        .await
        .unwrap();
      server.state.release_put.notify_one();
    };
    let (old_result, ()) = tokio::join!(old_put, rollover);
    old_result.unwrap();
    let published = source
      .download_manifest("profiles/rollover/manifest.json", Some(&new_key))
      .await
      .unwrap()
      .unwrap();
    assert_eq!(published.files, manifest.files);
    let mut new_readable = 0;
    let mut old_readable = 0;
    for (file, (_, plaintext)) in published.files.iter().zip(fixtures) {
      let key = format!("profiles/rollover/files/{}", file.path);
      let url = source.client.presign_download(&key).await.unwrap().url;
      let ciphertext = source.client.download_bytes(&url).await.unwrap();
      assert!(!ciphertext.windows(plaintext.len()).any(|w| w == plaintext));
      for (key, count) in [(&new_key, &mut new_readable), (&old_key, &mut old_readable)] {
        if let Ok(bytes) = encryption::decrypt_bytes(key, &ciphertext) {
          assert_eq!(bytes, plaintext);
          assert_eq!(blake3::hash(&bytes).to_hex().to_string(), file.hash);
          *count += 1;
        }
      }
    }
    assert_eq!(new_readable, 1, "new manifest references mixed-key files");
    assert_eq!(
      old_readable, 1,
      "neither password reads the complete generation"
    );
  })
  .await
  .expect("barrier-controlled delayed file PUT timed out");
}
