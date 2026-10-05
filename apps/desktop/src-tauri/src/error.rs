//! Structured error returned to the SPA from every command.
//! Codes follow docs/SIDECAR-PROTOCOL.md (E_*) plus a few shell-local ones (E_SIDECAR_*, E_SECRET_*, E_OIDC_*).

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor_code: Option<i64>,
    pub retryable: bool,
    /// structured, non-secret data from the sidecar (e.g. the SSH host key fingerprint to confirm)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), sql_state: None, vendor_code: None, retryable: false, details: None }
    }
    pub fn retryable(mut self, r: bool) -> Self {
        self.retryable = r;
        self
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new("E_BAD_REQUEST", message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}
