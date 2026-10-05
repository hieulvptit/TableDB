// Every app command needs an explicit permission (allow-<command>) in a capability file.
// This keeps the invoke surface least-privilege: adding a command without granting it is a no-op.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "sidecar_request",
            "sidecar_cancel",
            "secret_set",
            "secret_get",
            "secret_delete",
            "agent_config",
            "agent_http",
            "agent_http_cancel",
            "oidc_begin",
            "genai_login_begin",
            "genai_login_cancel",
            "genai_login_forget",
            "open_external",
            "app_info",
            "driver_import",
            "driver_list",
            "driver_remove",
            "ssh_key_import",
            "ssh_key_list",
            "ssh_key_remove",
            "workspace_load",
            "workspace_save",
            "workspace_clear",
            "transfer_save_begin",
            "transfer_save_chunk",
            "transfer_save_finish",
            "transfer_save_abort",
        ])),
    )
    .expect("tauri-build failed");
}
