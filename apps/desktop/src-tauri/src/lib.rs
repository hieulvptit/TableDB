pub mod agent_http;
pub mod commands;
pub mod config;
pub mod custom_drivers;
pub mod file_save;
pub mod ssh_keys;
pub mod error;
pub mod genai;
pub mod genai_internal;
pub mod login_proxy;
pub mod oidc;
pub mod redact;
pub mod secrets;
pub mod sidecar;
pub mod urlcheck;
pub mod workspace_store;

use commands::{AppState, TauriSink};
use config::{AppConfig, OsEnv};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

fn navigation_allowed(u: &url::Url) -> bool {
    match u.scheme() {
        "tauri" => true,
        "http" | "https" => match u.host_str() {
            Some("tauri.localhost") => true,
            Some("localhost") | Some("127.0.0.1") => cfg!(debug_assertions),
            _ => false,
        },
        "about" => u.as_str() == "about:blank",
        _ => false,
    }
}

pub fn run() {
    let log_plugin = tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::LogDir { file_name: Some("tabledb".into()) }),
            #[cfg(debug_assertions)]
            Target::new(TargetKind::Stdout),
        ])
        .level(if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info })
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .timezone_strategy(TimezoneStrategy::UseUtc)
        .format(|out, message, record| {
            out.finish(format_args!(
                "{} [{}] {}: {}",
                TimezoneStrategy::UseUtc.get_now(),
                record.level(),
                record.target(),
                redact::redact(&message.to_string())
            ))
        })
        .build();

    let app = tauri::Builder::default()
        .plugin(log_plugin)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Isolated renderer for Agent visuals (HTML/SVG/JS). The page is served here, not by the app asset protocol, so it can carry its
        // own CSP (inline script, no network) while the main window keeps `script-src 'self'`. It is only ever framed with sandbox="allow-scripts".
        .register_uri_scheme_protocol("agent-sandbox", |_ctx, _req| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:")
                .header("X-Content-Type-Options", "nosniff")
                .header("Referrer-Policy", "no-referrer")
                .body(include_bytes!("../../../web/public/agent-sandbox.html").to_vec())
                .unwrap()
        })
        .setup(|app| {
            // ---- config ----
            let dir = app.path().app_config_dir()?;
            let cfg_path = dir.join("config.json");
            let _ = std::fs::create_dir_all(&dir);
            let sample = dir.join("config.sample.json");
            if !sample.exists() {
                let _ = std::fs::write(&sample, config::SAMPLE);
            }
            // First launch uses the deployment settings embedded by CI. Existing configs are preserved.
            if let Ok(mut file) = std::fs::OpenOptions::new().write(true).create_new(true).open(&cfg_path) {
                use std::io::Write;
                file.write_all(config::SAMPLE.as_bytes())?;
            }
            let file = std::fs::read_to_string(&cfg_path).ok();
            let (cfg, cfg_err) = match AppConfig::resolve(file.as_deref(), &OsEnv) {
                Ok(c) => (c, None),
                Err(e) => {
                    log::error!("config error: {}", e.message);
                    (AppConfig::default(), Some(e.message))
                }
            };
            log::info!("TableDB desktop {} starting (env {})", app.package_info().version, cfg.env);

            // ---- sidecar (lazy) ----
            let resource_dir = app.path().resource_dir()?;
            #[cfg(debug_assertions)]
            let dev = match (std::env::var("TABLEDB_DEV_JAVA"), std::env::var("TABLEDB_DEV_JAR")) {
                (Ok(j), Ok(a)) => Some(sidecar::resolve_launch_dev(j.as_ref(), a.as_ref(), cfg.sidecar.max_heap_mb)),
                _ => None,
            };
            #[cfg(not(debug_assertions))]
            let dev: Option<Result<sidecar::LaunchSpec, error::AppError>> = None;
            let custom_drivers_dir = app.path().app_data_dir()?.join("drivers-custom");
            let _ = std::fs::create_dir_all(&custom_drivers_dir);
            let ssh_keys_dir = app.path().app_data_dir()?.join("ssh-keys");
            let _ = std::fs::create_dir_all(&ssh_keys_dir);
            let spec = dev
                .unwrap_or_else(|| sidecar::resolve_launch(&resource_dir, cfg.sidecar.max_heap_mb))
                .map(|s| s.with_custom_drivers(&custom_drivers_dir).with_ssh_keys(&ssh_keys_dir));
            if let Err(e) = &spec {
                log::warn!("sidecar not available: {}", e.message);
            }
            let mgr = sidecar::SidecarManager::new(spec, Arc::new(TauriSink(app.handle().clone())));

            let vault = Arc::new(secrets::Vault::new(secrets::service_name(&cfg.env)));
            let workspace = Arc::new(workspace_store::WorkspaceStore::new(
                app.path().app_data_dir()?.join("workspace.bin"),
                Box::new(workspace_store::VaultKey(vault.clone())),
            ));
            let cfg_proxy = cfg.proxy.url.clone();
            app.manage(AppState {
                vault,
                workspace,
                config: cfg,
                config_error: cfg_err,
                config_path: cfg_path.display().to_string(),
                sidecar: mgr,
                oidc_busy: AtomicBool::new(false),
                genai_cancel: std::sync::Mutex::new(None),
                custom_drivers_dir,
                driver_lock: tokio::sync::Mutex::new(()),
                ssh_keys_dir,
                ssh_key_lock: tokio::sync::Mutex::new(()),
                saves: file_save::Saves::default(),
                agent_http: agent_http::AgentHttp::new(cfg_proxy.as_deref()),
            });

            // ---- main window, created in code so we can pin navigation to the app origin ----
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("VNPAY TableDB")
                .inner_size(1360.0, 860.0)
                .min_inner_size(1024.0, 640.0)
                .on_navigation(navigation_allowed)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sidecar_request,
            commands::sidecar_cancel,
            commands::secret_set,
            commands::secret_get,
            commands::secret_delete,
            commands::agent_config,
            commands::agent_http,
            commands::agent_http_cancel,
            commands::oidc_begin,
            commands::genai_login_begin,
            commands::genai_proxy_check,
            commands::genai_login_cancel,
            commands::genai_login_forget,
            commands::open_external,
            commands::app_info,
            commands::driver_import,
            commands::driver_list,
            commands::driver_remove,
            commands::ssh_key_import,
            commands::ssh_key_list,
            commands::ssh_key_remove,
            commands::workspace_load,
            commands::workspace_save,
            commands::workspace_clear,
            commands::transfer_save_begin,
            commands::transfer_save_chunk,
            commands::transfer_save_finish,
            commands::transfer_save_abort,
        ])
        .build(tauri::generate_context!())
        .expect("error while building TableDB desktop");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(st) = handle.try_state::<AppState>() {
                let mgr = st.sidecar.clone();
                tauri::async_runtime::block_on(async move { mgr.shutdown().await });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_pinned_to_app_origin() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(navigation_allowed(&u("http://tauri.localhost/index.html")));
        assert!(navigation_allowed(&u("tauri://localhost/")));
        assert!(!navigation_allowed(&u("https://evil.com/")));
        assert!(!navigation_allowed(&u("file:///c:/x")));
        assert!(!navigation_allowed(&u("javascript:alert(1)")));
    }
}
