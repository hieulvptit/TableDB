//! Tauri commands invoked by the SPA. Each needs an `allow-<name>` permission (see capabilities/default.json).

use crate::config::AppConfig;
use crate::error::AppError;
use crate::config::GenaiBrowser;
use crate::genai_internal;
use crate::genai::{self, GenaiLoginParams, GenaiLoginResult};
use crate::oidc::{self, OidcBeginParams, OidcResult};
use crate::secrets;
use crate::sidecar::{browser_url_for_event, EventSink, SidecarEvent, SidecarManager};
use crate::urlcheck::{csp_allows_origin, origin_string, validate_external_url};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    pub config: AppConfig,
    pub desktop_config: tokio::sync::Mutex<Option<crate::config::DesktopDeployment>>,
    pub api_transport: crate::api_transport::ApiTransport,
    pub agent_config: std::sync::RwLock<Option<crate::config::AgentConfig>>,
    pub config_error: Option<String>,
    pub sidecar: Arc<SidecarManager>,
    pub oidc_busy: AtomicBool,
    /// Cancel handle of the in-flight genai login (if any).
    pub genai_cancel: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// `<app_data_dir>/drivers-custom`: user-imported JDBC drivers + manifest.json (passed to the sidecar as --custom-drivers).
    pub custom_drivers_dir: std::path::PathBuf,
    /// Serializes manifest read/modify/write.
    pub driver_lock: tokio::sync::Mutex<()>,
    /// `<app_data_dir>/ssh-keys`: imported SSH private keys + manifest.json (passed to the sidecar as --ssh-keys).
    pub ssh_keys_dir: std::path::PathBuf,
    pub ssh_key_lock: tokio::sync::Mutex<()>,
    /// All secrets in one credential-store item, read once per process (one keychain prompt, not one per secret).
    pub vault: Arc<secrets::Vault>,
    /// Encrypted editor workspace (tabs, history, snippets) in app data.
    pub workspace: Arc<crate::workspace_store::WorkspaceStore>,
    /// In-flight saves of approved office → jump downloads (see file_save).
    pub saves: crate::file_save::Saves,
    /// HTTP bridge of the local Agent (LLM gateway / OpenMetadata MCP).
    pub agent_http: crate::agent_http::AgentHttp,
}

/// Forwards sidecar events to the SPA and opens SSO URLs in the system browser.
pub struct TauriSink(pub AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, ev: &SidecarEvent) {
        let _ = self.0.emit("sidecar:event", ev);
        match ev.event.as_str() {
            "ready" => {
                let _ = self.0.emit("sidecar:ready", &ev.data);
            }
            "auth.openUrl" => {
                let _ = self.0.emit("sidecar:auth-open-url", &ev.data);
                if let Some(u) = browser_url_for_event(ev) {
                    if let Err(e) = self.0.opener().open_url(u.as_str(), None::<&str>) {
                        log::warn!("could not open system browser for SSO: {e}");
                    } else {
                        log::info!("opened system browser for trino-sso (host {})", u.host_str().unwrap_or("?"));
                    }
                }
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn sidecar_request(state: State<'_, AppState>, method: String, params: Option<Value>) -> Result<Value, AppError> {
    state.deployment().await?;
    log::debug!("sidecar_request {method}"); // method only, never params
    state.sidecar.request(&method, params.unwrap_or(Value::Null)).await
}

#[tauri::command]
pub async fn sidecar_cancel(state: State<'_, AppState>, query_id: String) -> Result<Value, AppError> {
    if query_id.is_empty() || query_id.len() > 128 {
        return Err(AppError::bad_request("invalid queryId"));
    }
    state.sidecar.request("query.cancel", json!({ "queryId": query_id })).await
}

async fn vault_op<T: Send + 'static>(
    state: &AppState,
    op: impl FnOnce(&secrets::Vault) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || op(&vault))
        .await
        .map_err(|_| AppError::new("E_INTERNAL", "task failed"))?
}

/// Keys the Rust core keeps for itself (e.g. the workspace key): never readable or writable from the WebView.
pub fn webview_secret_key(key: &str) -> Result<(), AppError> {
    if key.starts_with("internal:") {
        return Err(AppError::new("E_SECRET_KEY", "reserved secret key"));
    }
    Ok(())
}

/// Agent tokens and SSO proxy credentials are write-only from the WebView.
pub fn webview_secret_readable(key: &str) -> Result<(), AppError> {
    if key.starts_with("agent:token:") || key == crate::login_proxy::CREDENTIAL_KEY {
        return Err(AppError::new("E_SECRET_KEY", "write-only secret key"));
    }
    Ok(())
}

#[tauri::command]
pub async fn secret_set(state: State<'_, AppState>, key: String, value: String) -> Result<(), AppError> {
    webview_secret_key(&key)?;
    if key == crate::login_proxy::CREDENTIAL_KEY {
        crate::login_proxy::SavedProxy::parse(&value)?;
    }
    vault_op(&state, move |v| v.set(&key, &value)).await
}

#[tauri::command]
pub async fn secret_get(state: State<'_, AppState>, key: String) -> Result<Option<String>, AppError> {
    webview_secret_key(&key)?;
    webview_secret_readable(&key)?;
    vault_op(&state, move |v| v.get(&key)).await
}

#[tauri::command]
pub async fn secret_delete(state: State<'_, AppState>, key: String) -> Result<(), AppError> {
    webview_secret_key(&key)?;
    vault_op(&state, move |v| v.delete(&key)).await
}

async fn workspace_op<T: Send + 'static>(
    state: &AppState,
    op: impl FnOnce(&crate::workspace_store::WorkspaceStore) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let ws = state.workspace.clone();
    tauri::async_runtime::spawn_blocking(move || op(&ws))
        .await
        .map_err(|_| AppError::new("E_INTERNAL", "task failed"))?
}

/// Decrypted workspace JSON (null when nothing was saved). Contents are never logged.
#[tauri::command]
pub async fn workspace_load(state: State<'_, AppState>) -> Result<Option<String>, AppError> {
    workspace_op(&state, |w| w.load()).await
}

#[tauri::command]
pub async fn workspace_save(state: State<'_, AppState>, data: String) -> Result<(), AppError> {
    workspace_op(&state, move |w| w.save(&data)).await
}

/// Deletes the workspace file and its key.
#[tauri::command]
pub async fn workspace_clear(state: State<'_, AppState>) -> Result<(), AppError> {
    workspace_op(&state, |w| w.clear()).await?;
    log::info!("editor workspace cleared");
    Ok(())
}

fn open_in_browser(app: &AppHandle, url: &str) -> Result<(), AppError> {
    let u = validate_external_url(url)?;
    app.opener().open_url(u.as_str(), None::<&str>).map_err(|_| AppError::new("E_OPEN_URL", "cannot open browser"))
}

#[tauri::command]
pub async fn oidc_begin(app: AppHandle, state: State<'_, AppState>, params: OidcBeginParams) -> Result<OidcResult, AppError> {
    if state.oidc_busy.swap(true, Ordering::SeqCst) {
        return Err(AppError::new("E_OIDC_BUSY", "a sign-in is already in progress"));
    }
    struct Reset<'a>(&'a AtomicBool);
    impl Drop for Reset<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _reset = Reset(&state.oidc_busy);
    log::info!("oidc_begin (endpoint host {})", url::Url::parse(&params.authorize_endpoint).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default());
    oidc::run_flow(params, |u| open_in_browser(&app, u)).await
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn saved_sso_proxy(state: &AppState) -> Result<Option<crate::login_proxy::SavedProxy>, AppError> {
    let raw = vault_op(state, |v| v.get(crate::login_proxy::CREDENTIAL_KEY)).await?;
    raw.as_deref().map(crate::login_proxy::SavedProxy::parse).transpose()
}

/// Probe the saved user proxy or the server default.
#[tauri::command]
pub async fn genai_proxy_check(state: State<'_, AppState>) -> Result<Value, AppError> {
    let deployment = state.deployment().await?;
    let saved = saved_sso_proxy(&state).await?;
    let url = saved.as_ref().map(|s| s.effective_url(deployment.config.genai_proxy_url.as_deref()))
        .unwrap_or_else(|| deployment.config.genai_proxy_url.clone());
    let check = crate::login_proxy::check_connectivity(url.as_deref()).await?;
    let username = saved.as_ref().map(|s| s.username.as_str()).unwrap_or(crate::login_proxy::DEFAULT_PROXY_USERNAME);
    Ok(json!({"proxyUrl": check.proxy_url, "username": username, "reachable": check.reachable, "latencyMs": check.latency_ms}))
}

/// VNPAY SSO broker login (loopback listener + secret callback path). Shares the busy flag with `oidc_begin`.
#[tauri::command]
pub async fn genai_login_begin(app: AppHandle, state: State<'_, AppState>, mut params: GenaiLoginParams) -> Result<GenaiLoginResult, AppError> {
    let deployment = state.deployment().await?;
    let config = &deployment.config;
    params.timeout_sec = Some(deployment.genai_timeout_sec);
    if state.oidc_busy.swap(true, Ordering::SeqCst) {
        return Err(AppError::new("E_GENAI_BUSY", "a sign-in is already in progress"));
    }
    let _reset = BusyGuard(&state.oidc_busy);
    let (tx, rx) = tokio::sync::oneshot::channel();
    *state.genai_cancel.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    log::info!("genai_login_begin (host {})", url::Url::parse(&params.login_url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default());
    // Keep proxy setup inside the result future so the cancellation sender is cleared on every error.
    let res = async {
        let saved = saved_sso_proxy(&state).await?;
        let proxy_url = saved.as_ref().map(|s| s.effective_url(config.genai_proxy_url.as_deref()))
            .unwrap_or_else(|| config.genai_proxy_url.clone());
        let upstream = crate::login_proxy::reachable_login_proxy(proxy_url.as_deref()).await?;
        let proxy_bridge = if let Some(upstream) = upstream {
            let credentials = crate::login_proxy::login_credentials(saved.as_ref(), upstream, crate::login_proxy::default_proxy_password())?;
            Some(crate::login_proxy::LoginProxy::start(
                crate::login_proxy::validate_proxy(upstream)?, Some(credentials), &config.genai_login_origins,
            ).await?)
        } else { None };
        // A configured but unreachable SSO proxy must fall back to direct access,
        // rather than accidentally reusing the general API proxy.
        let browser_proxy = if proxy_url.is_some() || saved.is_some() {
            proxy_bridge.as_ref().map(|p| p.url.as_str())
        } else {
            config.proxy.url.as_deref()
        };
        let mut browser = None;
        let res = match config.genai_login_browser {
            GenaiBrowser::Internal => {
                genai_internal::run(app.clone(), params, &config.genai_login_origins, browser_proxy, config.genai_persist_sso, deployment.genai_internal_connect_port, rx).await
            }
            GenaiBrowser::System => {
                genai::run_flow(params, &config.genai_login_origins, config.genai_secret_path, rx, |u| {
                    if let Some(proxy) = proxy_bridge.as_ref() {
                        let profile = app.path().app_local_data_dir()
                            .map_err(|_| AppError::new("E_OPEN_URL", "cannot locate SSO profile"))?.join("genai-browser-profile");
                        browser = Some(crate::login_proxy::open_browser(u, &proxy.url, &profile, config.genai_persist_sso)?);
                        Ok(())
                    } else {
                        open_in_browser(&app, u)
                    }
                }).await
            }
        };
        drop(browser);
        res
    }.await;
    *state.genai_cancel.lock().unwrap_or_else(|e| e.into_inner()) = None;
    res
}

/// Forget the persisted SSO profile of the internal login window (next login asks for credentials again).
#[tauri::command]
pub async fn genai_login_forget(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    if state.oidc_busy.swap(true, Ordering::SeqCst) {
        return Err(AppError::new("E_GENAI_BUSY", "a sign-in is in progress"));
    }
    let _reset = BusyGuard(&state.oidc_busy);
    genai_internal::forget(&app).await
}

#[tauri::command]
pub fn genai_login_cancel(state: State<'_, AppState>) {
    if let Some(tx) = state.genai_cancel.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = tx.send(());
    }
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), AppError> {
    open_in_browser(&app, &url)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    server_signing_public_key: String,
    version: String,
    log_dir: Option<String>,
    env: String,
    api_base_url: String,
    proxy_url: Option<String>,
    genai_proxy_url: Option<String>,
    config_error: Option<String>,
    csp_allows_api: bool,
    sidecar: Option<Value>,
    platform: &'static str,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    let csp = app.config().app.security.csp.as_ref().map(|c| c.to_string()).unwrap_or_default();
    let csp_allows_api = url::Url::parse(&state.config.api_base_url)
        .map(|u| csp_allows_origin(&csp, &origin_string(&u)))
        .unwrap_or(false);
    AppInfo {
        server_signing_public_key: state.config.server_signing_public_key.clone(),
        version: app.package_info().version.to_string(),
        log_dir: app.path().app_log_dir().ok().map(|p| p.display().to_string()),
        env: state.config.env.clone(),
        api_base_url: state.config.api_base_url.clone(),
        proxy_url: state.config.proxy.url.clone(),
        genai_proxy_url: state.config.genai_proxy_url.clone(),
        config_error: state.config_error.clone(),
        csp_allows_api,
        sidecar: state.sidecar.ready_info(),
        platform: std::env::consts::OS,
    }
}


#[tauri::command]
pub async fn driver_import(app: AppHandle, state: State<'_, AppState>, params: crate::custom_drivers::ImportParams) -> Result<Value, AppError> {
    let spec = crate::custom_drivers::validate_import(&params)?;
    // the native dialog is opened here so file paths never come from the WebView
    let picked = {
        use tauri_plugin_dialog::DialogExt;
        let app2 = app.clone();
        tokio::task::spawn_blocking(move || app2.dialog().file().set_title("Chọn file JAR của JDBC driver").add_filter("JDBC driver (*.jar)", &["jar"]).blocking_pick_files())
            .await
            .map_err(|_| AppError::new("E_INTERNAL", "file dialog failed"))?
    };
    let Some(files) = picked else { return Err(AppError::new("E_CANCELLED", "no file selected")) };
    let paths = files.into_iter().map(|f| f.into_path().map_err(|_| AppError::bad_request("unsupported file location"))).collect::<Result<Vec<_>, _>>()?;
    let _g = state.driver_lock.lock().await;
    let dir = state.custom_drivers_dir.clone();
    let entry = tokio::task::spawn_blocking(move || crate::custom_drivers::import_files(&dir, &spec, &paths))
        .await
        .map_err(|_| AppError::new("E_INTERNAL", "import failed"))??;
    let loaded = reload(&state).await;
    Ok(crate::custom_drivers::import_result(&entry, loaded))
}

#[tauri::command]
pub async fn driver_list(state: State<'_, AppState>) -> Result<Value, AppError> {
    let hello = state.sidecar.request_internal("hello", json!({})).await?;
    Ok(json!({ "drivers": crate::custom_drivers::custom_entries(&hello) }))
}

#[tauri::command]
pub async fn driver_remove(state: State<'_, AppState>, id: String) -> Result<Value, AppError> {
    let _g = state.driver_lock.lock().await;
    let dir = state.custom_drivers_dir.clone();
    tokio::task::spawn_blocking(move || crate::custom_drivers::remove_entry(&dir, &id))
        .await
        .map_err(|_| AppError::new("E_INTERNAL", "remove failed"))??;
    let _ = reload(&state).await;
    Ok(json!({}))
}

/// Native file picker (in Rust: the path never comes from the WebView) → copy into the app-data key store.
#[tauri::command]
pub async fn ssh_key_import(app: AppHandle, state: State<'_, AppState>, name: Option<String>) -> Result<crate::ssh_keys::KeyEntry, AppError> {
    let picked = {
        use tauri_plugin_dialog::DialogExt;
        use tauri::Manager;
        let app2 = app.clone();
        // ~/.ssh is a hidden folder the native picker does not show: open it directly when it exists
        let ssh_dir = app.path().home_dir().ok().map(|h| h.join(".ssh")).filter(|d| d.is_dir());
        tokio::task::spawn_blocking(move || {
            let mut dlg = app2.dialog().file().set_title("Chọn file khóa riêng SSH (id_ed25519, id_rsa, .pem, .ppk)");
            if let Some(d) = ssh_dir { dlg = dlg.set_directory(d); }
            dlg.blocking_pick_file()
        })
            .await
            .map_err(|_| AppError::new("E_INTERNAL", "file dialog failed"))?
    };
    let Some(file) = picked else { return Err(AppError::new("E_CANCELLED", "no file selected")) };
    let path = file.into_path().map_err(|_| AppError::bad_request("unsupported file location"))?;
    let _g = state.ssh_key_lock.lock().await;
    let dir = state.ssh_keys_dir.clone();
    let entry = tokio::task::spawn_blocking(move || crate::ssh_keys::import_file(&dir, &path, name.as_deref()))
        .await
        .map_err(|_| AppError::new("E_INTERNAL", "import failed"))??;
    log::info!("ssh key imported ({} {})", entry.format, if entry.encrypted { "encrypted" } else { "unencrypted" });
    Ok(entry)
}

#[tauri::command]
pub async fn ssh_key_list(state: State<'_, AppState>) -> Result<Value, AppError> {
    let dir = state.ssh_keys_dir.clone();
    let keys = tokio::task::spawn_blocking(move || crate::ssh_keys::read_manifest(&dir))
        .await
        .map_err(|_| AppError::new("E_INTERNAL", "list failed"))??;
    Ok(json!({ "keys": keys }))
}

#[tauri::command]
pub async fn ssh_key_remove(state: State<'_, AppState>, id: String) -> Result<Value, AppError> {
    let _g = state.ssh_key_lock.lock().await;
    let dir = state.ssh_keys_dir.clone();
    tokio::task::spawn_blocking(move || crate::ssh_keys::remove_key(&dir, &id))
        .await
        .map_err(|_| AppError::new("E_INTERNAL", "remove failed"))??;
    Ok(json!({}))
}

/// Ask the sidecar to re-read the manifest. Ok(list) = the sidecar's view; Err = sidecar unavailable (files stay on disk and load on next start).
async fn reload(state: &AppState) -> Result<Value, AppError> {
    state.sidecar.request_internal("drivers.reload", json!({})).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn webview_cannot_touch_internal_secrets() {
        assert!(super::webview_secret_key("db.profile.x.password").is_ok());
        assert_eq!(super::webview_secret_key(crate::workspace_store::KEY_NAME).unwrap_err().code, "E_SECRET_KEY");
        assert!(super::webview_secret_key("internal:anything").is_err());
        assert!(super::webview_secret_key(crate::login_proxy::CREDENTIAL_KEY).is_ok());
        assert!(super::webview_secret_readable(crate::login_proxy::CREDENTIAL_KEY).is_err());
    }
}

// ---- saving approved office → jump transfers (see file_save.rs) ----

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBeginParams {
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
}

/// Opens the native save dialog (the path never comes from the WebView) and starts a `.part` file. Returns an opaque handle.
/// Called before the download token is requested, so cancelling the dialog does not use up a download.
#[tauri::command]
pub async fn transfer_save_begin(app: AppHandle, state: State<'_, AppState>, params: SaveBeginParams) -> Result<String, AppError> {
    crate::file_save::validate(params.size, &params.sha256)?;
    let name = crate::file_save::sanitize_file_name(&params.file_name);
    let picked = {
        use tauri_plugin_dialog::DialogExt;
        let app2 = app.clone();
        tokio::task::spawn_blocking(move || app2.dialog().file().set_title("Lưu file đã được duyệt").set_file_name(&name).blocking_save_file())
            .await
            .map_err(|_| AppError::new("E_INTERNAL", "file dialog failed"))?
    };
    let Some(file) = picked else { return Err(AppError::new("E_CANCELLED", "no file selected")) };
    let path = file.into_path().map_err(|_| AppError::bad_request("unsupported file location"))?;
    let job = tokio::task::spawn_blocking(move || crate::file_save::SaveJob::create(path, params.size, &params.sha256))
        .await
        .map_err(|_| AppError::new("E_INTERNAL", "save failed"))??;
    Ok(state.saves.insert(job))
}

/// Raw body = next chunk of the file; header `x-save-handle` = handle from transfer_save_begin.
#[tauri::command]
pub async fn transfer_save_chunk(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<(), AppError> {
    let id = request.headers().get("x-save-handle").and_then(|v| v.to_str().ok()).ok_or_else(|| AppError::bad_request("missing x-save-handle"))?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err(AppError::bad_request("raw body expected")) };
    let bytes = bytes.clone();
    let slot = state.saves.get(id)?;
    tokio::task::spawn_blocking(move || match slot.lock().unwrap().as_mut() {
        Some(job) => job.write(&bytes),
        None => Err(AppError::new("E_NOT_FOUND", "unknown save handle")),
    })
    .await
    .map_err(|_| AppError::new("E_INTERNAL", "write failed"))?
}

/// Verifies size + SHA-256 and moves the file into place. Returns the saved file name (not the full path).
#[tauri::command]
pub async fn transfer_save_finish(state: State<'_, AppState>, handle: String) -> Result<String, AppError> {
    let job = state.saves.take(&handle)?;
    tokio::task::spawn_blocking(move || job.finish()).await.map_err(|_| AppError::new("E_INTERNAL", "save failed"))?
}

/// Drops the save and deletes the partial file. Unknown handles are ignored.
#[tauri::command]
pub async fn transfer_save_abort(state: State<'_, AppState>, handle: String) -> Result<(), AppError> {
    if let Ok(job) = state.saves.take(&handle) {
        let _ = tokio::task::spawn_blocking(move || drop(job)).await;
    }
    Ok(())
}

async fn fetch_deployment(state: &AppState, path: &str, access_token: Option<&str>, proxy: Option<&str>, timeout_sec: u64) -> Result<crate::agent_http::HttpRes, AppError> {
 if let Some(error) = &state.config_error {
  return Err(AppError::new("E_DESKTOP_BOOTSTRAP", crate::redact::redact(error)));
 }
 crate::urlcheck::validate_api_endpoint(&state.config.api_base_url)?;
 let base = state.config.api_base_url.trim_end_matches('/');
 let base = if base.ends_with("/api/v1") { base.to_string() } else { format!("{base}/api/v1") };
 let mode = if crate::api_transport::effective_proxy(&base, proxy).is_some() { "proxy" } else { "direct" };
 log::info!("desktop configuration fetch started: api={} route={} connection={} timeout_sec={}", crate::redact::redact(&base), path, mode, timeout_sec);
 let client = crate::api_transport::client(&base, proxy)?;
 let result = tokio::time::timeout(std::time::Duration::from_secs(timeout_sec), crate::secure_transport::get(&client, &base, &state.config.server_signing_public_key, path, access_token))
  .await.unwrap_or_else(|_| Err(AppError::new("E_CONFIG_NETWORK", format!("API configuration request timed out after {timeout_sec}s ({base})"))));
 match &result {
  Ok(response) => log::info!("desktop configuration fetch completed: api={} route={} status={}", crate::redact::redact(&base), path, response.status),
  Err(error) => log::error!("desktop configuration fetch failed: api={} route={} code={} error={}", crate::redact::redact(&base), path, error.code, crate::redact::redact(&error.message)),
 }
 result
}
impl AppState {
 async fn deployment(&self) -> Result<crate::config::DesktopDeployment, AppError> {
  let mut cache = self.desktop_config.lock().await;
  if let Some(c) = cache.as_ref() { return Ok(c.clone()); }
  // Bootstrap uses only the API origin and an optional network proxy. No login credentials are required.
  let response = fetch_deployment(self, "/desktop/config", None, self.config.proxy.url.as_deref(), 15).await?;
  if response.status != 200 { return Err(AppError::new("E_DESKTOP_CONFIG", "server desktop configuration unavailable")); }
  let mut deployment: crate::config::DesktopDeployment = serde_json::from_str(&response.body).map_err(|_| AppError::bad_request("invalid server desktop configuration"))?;
  deployment.validate(&self.config)?;
  self.sidecar.set_heap_mb(deployment.config.sidecar.max_heap_mb);
  *cache = Some(deployment.clone());
  Ok(deployment)
 }
}
#[tauri::command]
pub async fn desktop_config(state: State<'_, AppState>) -> Result<Value, AppError> {
 let d = state.deployment().await.map_err(|error| {
  log::error!("desktop_config failed: code={} error={}", error.code, crate::redact::redact(&error.message));
  error
 })?;
 let mode = if crate::api_transport::effective_proxy(&state.config.api_base_url, d.config.proxy.url.as_deref()).is_some() { "proxy" } else { "direct" };
 Ok(json!({ "genaiProxyUrl": d.config.genai_proxy_url, "proxyUrl": d.config.proxy.url, "apiConnectionMode": mode }))
}

/// Only opaque AES envelopes can leave the renderer through this pinned API transport.
#[tauri::command]
pub async fn api_http_start(state: State<'_, AppState>, request_id: String, endpoint: String, headers: std::collections::HashMap<String, String>, body: String) -> Result<crate::api_transport::Head, AppError> {
 let d = state.deployment().await?;
 state.api_transport.start(request_id, &state.config.api_base_url, d.config.proxy.url.as_deref(), &endpoint, headers, body).await
}
#[tauri::command]
pub async fn api_http_read(state: State<'_, AppState>, request_id: String) -> Result<Option<String>, AppError> {
 state.api_transport.read(&request_id).await
}
#[tauri::command]
pub fn api_http_close(state: State<'_, AppState>, request_id: String) { state.api_transport.close(&request_id); }
/// Renderer supplies only the session bearer; Rust fetches and validates the pinned configuration URL.
#[tauri::command]
pub async fn agent_config(state: State<'_, AppState>, access_token: String) -> Result<crate::agent_http::HttpRes, AppError> {
 let desktop = state.deployment().await?;
 let mut response = fetch_deployment(&state, "/agent/config", Some(&access_token), desktop.config.proxy.url.as_deref(), desktop.config_timeout_sec).await?;
 if response.status == 200 {
  let value: Value = serde_json::from_str(&response.body).map_err(|_| AppError::bad_request("invalid server Agent configuration"))?;
  if value.get("runtime").is_none() { return Err(AppError::bad_request("server Agent runtime configuration is missing")); }
  let mut cfg: crate::config::AgentConfig = serde_json::from_value(value).map_err(|_| AppError::bad_request("invalid server Agent configuration"))?;
  cfg.validate(&state.config.env)?;
  cfg.proxy_url = desktop.config.proxy.url;
  use sha2::{Digest, Sha256};
  let om_revision = format!("{:x}", Sha256::digest(serde_json::to_vec(&(&cfg.open_metadata_url, &cfg.proxy_url)).map_err(|_| AppError::bad_request("invalid OpenMetadata configuration"))?));
  response.body = json!({ "runtime": cfg.runtime, "endpoints": cfg.endpoints, "defaultEndpointId": cfg.default_endpoint_id,
   "defaultModel": cfg.default_model, "budgetChars": cfg.budget_chars, "openMetadataEnabled": cfg.open_metadata_url.is_some(), "openMetadataRevision": om_revision }).to_string();
  *state.agent_config.write().map_err(|_| AppError::new("E_INTERNAL", "configuration lock failed"))? = Some(cfg);
 } else {
  *state.agent_config.write().map_err(|_| AppError::new("E_INTERNAL", "configuration lock failed"))? = None;
 }
 Ok(response)
}

#[tauri::command]
pub async fn agent_http(webview: tauri::Webview, state: State<'_, AppState>, request_id: String, req: crate::agent_http::HttpReq, on_chunk: Option<tauri::ipc::JavaScriptChannelId>) -> Result<crate::agent_http::HttpRes, AppError> {
    if request_id.is_empty() || request_id.len() > 64 {
        return Err(AppError::bad_request("invalid requestId"));
    }
    // method + target kind only; never the body, headers or credential
    log::debug!("agent_http {} {:?}", req.method, std::mem::discriminant(&req.target));
    let cfg = state.agent_config.read().map_err(|_| AppError::new("E_INTERNAL", "configuration lock failed"))?
        .clone().ok_or_else(|| AppError::new("E_AGENT_CONFIG", "load Agent configuration from server first"))?;
    let progress = on_chunk.map(|id| {
        let channel: tauri::ipc::Channel<Vec<u8>> = id.channel_on(webview);
        let callback: Arc<dyn Fn(&[u8]) + Send + Sync> = Arc::new(move |bytes| {
            let _ = channel.send(bytes.to_vec());
        });
        callback
    });
    state.agent_http.request_with_progress(&request_id, &cfg, state.vault.clone(), req, progress).await
}

#[tauri::command]
pub fn agent_http_cancel(state: State<'_, AppState>, request_id: String) {
    state.agent_http.cancel(&request_id);
}
