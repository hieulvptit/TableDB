//! Internal-browser mode of the VNPAY SSO login: a dedicated webview window (label `genai-login`) loads
//! `<loginUrl>?connectid=<dummy port>`, so the traffic uses the app's own proxy setting. No listener is needed: the broker's
//! final redirect `http://localhost:<dummy port>/sso-callback?token=<JWT>` is intercepted in `on_navigation` and cancelled.
//!
//! Security: the window loads a REMOTE origin and must have no IPC access. Capabilities are matched by window label
//! and `capabilities/default.json` lists only `main` (asserted by a test in genai.rs); do not add this label there.
//! Only https navigations are allowed (plus the intercepted URL); popups and downloads are blocked.
//! The token and full URLs are never logged (host only).

use crate::error::AppError;
use crate::genai::{
    build_login_url, check_login_url, navigation_decision, webview_proxy, GenaiLoginParams, GenaiLoginResult, NavDecision,
    INTERNAL_CONNECT_PORT,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

pub const WINDOW_LABEL: &str = "genai-login";
type Outcome = Result<String, AppError>;
type Slot = Arc<Mutex<Option<oneshot::Sender<Outcome>>>>;

fn finish(slot: &Slot, o: Outcome) {
    if let Some(tx) = slot.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = tx.send(o);
    }
}

pub fn close_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.destroy();
    }
}

/// Fixed WKWebView data-store id (macOS >= 14): `data_directory` is not honoured by WKWebView, the store is keyed by identifier.
pub const MAC_STORE_ID: [u8; 16] = *b"vnpay-tabledb-01";
const PROFILE_DIR: &str = "genai-login-webview";

pub fn profile_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(PROFILE_DIR))
}

/// Remove a profile directory; a missing directory is success. Best effort otherwise (returns the io error).
pub fn remove_profile_dir(dir: &std::path::Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// Delete the persisted SSO profile so the next login asks for credentials again. The caller guarantees no login window is open.
/// Windows/Linux: the profile is the data directory. macOS: WKWebView keys the store by identifier, so the store is cleared
/// through a short-lived hidden window using the same identifier (`clear_all_browsing_data`). A window is never created on
/// the default store (that would wipe the main webview's data).
pub async fn forget(app: &AppHandle) -> Result<(), AppError> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return Err(AppError::new("E_GENAI_BUSY", "login window is open"));
    }
    #[cfg(target_os = "macos")]
    {
        let w = WebviewWindowBuilder::new(app, "genai-login-forget", WebviewUrl::External("about:blank".parse().unwrap()))
            .visible(false)
            .data_store_identifier(MAC_STORE_ID)
            .build()
            .map_err(|_| AppError::new("E_GENAI_FORGET", "cannot open the login profile"))?;
        let r = w.clear_all_browsing_data();
        tokio::time::sleep(Duration::from_millis(300)).await; // clearing is asynchronous
        let _ = w.destroy();
        r.map_err(|_| AppError::new("E_GENAI_FORGET", "cannot clear the login profile"))?;
    }
    if let Some(dir) = profile_dir(app) {
        // WebView2 may still hold files right after the window closed: retry briefly, then give up quietly.
        for _ in 0..5 {
            if remove_profile_dir(&dir).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    Ok(())
}

pub async fn run(
    app: AppHandle,
    params: GenaiLoginParams,
    allowed_origins: &[String],
    proxy: Option<&str>,
    persist_sso: bool,
    cancel: oneshot::Receiver<()>,
) -> Result<GenaiLoginResult, AppError> {
    let base = check_login_url(&params.login_url, allowed_origins)?;
    let proxy = webview_proxy(proxy)?;
    let secs = params.timeout_sec.unwrap_or(300).clamp(5, 600);
    let url = build_login_url(&base, &INTERNAL_CONNECT_PORT.to_string());

    close_window(&app); // stale window from a previous run, if any
    let (tx, rx) = oneshot::channel::<Outcome>();
    let slot: Slot = Arc::new(Mutex::new(Some(tx)));

    let nav_slot = slot.clone();
    let mut b = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("Đăng nhập VNPAY SSO")
        .inner_size(480.0, 720.0)
        .resizable(true)
        .minimizable(false)
        .center()
        .visible(true)
        .focused(true)
        .incognito(!persist_sso)
        .on_page_load(|_w, p| {
            // diagnostics only: scheme/host/path, never the query
            let u = p.url();
            let ev = match p.event() { tauri::webview::PageLoadEvent::Started => "started", tauri::webview::PageLoadEvent::Finished => "finished" };
            log::info!("genai: page {ev} {}://{}{}", u.scheme(), u.host_str().unwrap_or("?"), u.path());
        })
        .on_navigation(move |u| match navigation_decision(u, INTERNAL_CONNECT_PORT) {
            NavDecision::Allow => {
                // diagnostics: scheme/host/path only — never the query string (it can carry tokens/codes)
                log::info!("genai: nav allow {}://{}{}", u.scheme(), u.host_str().unwrap_or("?"), u.path());
                true
            }
            NavDecision::Intercept(r) => {
                log::info!("genai: login redirect intercepted");
                finish(&nav_slot, r.map_err(|c| AppError::new(c, "callback token missing or malformed")));
                false
            }
            NavDecision::Deny => {
                log::warn!("genai: blocked navigation {}://{}{}", u.scheme(), u.host_str().unwrap_or("?"), u.path());
                false
            }
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);
    // Dedicated profile (proxy args must not clash with the main webview). When persisting, cookies live here.
    if let Some(dir) = profile_dir(&app) {
        b = b.data_directory(dir);
    }
    #[cfg(target_os = "macos")]
    if persist_sso {
        b = b.data_store_identifier(MAC_STORE_ID);
    }
    if let Some(p) = proxy {
        b = b.proxy_url(p);
    }
    // NOTE: deliberately NOT a child (`.parent()`) of the main window: on macOS a child window can end up behind/clipped.
    let win = b.build().map_err(|e| {
        log::warn!("genai: cannot create login window: {e}");
        AppError::new("E_GENAI_WINDOW", "cannot open the login window")
    })?;
    let close_slot = slot.clone();
    win.on_window_event(move |ev| {
        if matches!(ev, WindowEvent::Destroyed) {
            finish(&close_slot, Err(AppError::new("E_GENAI_CANCELLED", "login window closed")));
        }
    });
    log::info!("genai: internal login window opened (host {})", base.host_str().unwrap_or("?"));
    // A window that exists but is not on screen (behind the main window, minimized, off-screen) looks like "no popup".
    // Force it forward and log its real state so this can be diagnosed from the log.
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_always_on_top(true); // released again once the login is over (the window is closed)
    let _ = win.set_focus();
    let diag = win.clone();
    tauri::async_runtime::spawn(async move {
        for (i, delay) in [0u64, 500, 1500].into_iter().enumerate() {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            log::info!(
                "genai: window state #{i}: visible={:?} focused={:?} minimized={:?} pos={:?} size={:?} scale={:?} monitor={}",
                diag.is_visible(), diag.is_focused(), diag.is_minimized(), diag.outer_position(), diag.outer_size(), diag.scale_factor(),
                diag.current_monitor().ok().flatten().map(|m| format!("{:?} {:?}", m.position(), m.size())).unwrap_or_else(|| "none".into()),
            );
        }
    });

    let res = tokio::select! {
        r = rx => r.unwrap_or_else(|_| Err(AppError::new("E_GENAI_CANCELLED", "sign-in cancelled"))),
        _ = tokio::time::sleep(Duration::from_secs(secs)) => Err(AppError::new("E_GENAI_TIMEOUT", "sign-in timed out").retryable(true)),
        _ = cancel => Err(AppError::new("E_GENAI_CANCELLED", "sign-in cancelled")),
    };
    close_window(&app);
    res.map(|token| GenaiLoginResult { token })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_profile_dir_is_idempotent() {
        let d = std::env::temp_dir().join(format!("tabledb-genai-test-{}", std::process::id()));
        std::fs::create_dir_all(d.join("Default")).unwrap();
        std::fs::write(d.join("Default/Cookies"), b"x").unwrap();
        remove_profile_dir(&d).unwrap();
        assert!(!d.exists());
        remove_profile_dir(&d).unwrap(); // not found is fine
    }
}
