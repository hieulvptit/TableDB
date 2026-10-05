//! HTTP bridge for the local Agent (LLM gateway + OpenMetadata MCP). The webview never gets a CSP hole and never reads a stored
//! credential: it names a *target* (an LLM endpoint id from config.json, or the OpenMetadata MCP URL); this module resolves the base
//! URL from the validated local config, attaches the credential from the OS credential store (or the one being verified before it is
//! saved) and returns status + body. Redirects are never followed, bodies are capped, requests are cancellable.

use crate::config::AgentConfig;
use crate::error::AppError;
use crate::secrets::Vault;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

pub const TOKEN_KEY_LLM: &str = "agent:token:llm";
pub const TOKEN_KEY_OM: &str = "agent:token:om";
const MAX_BODY_IN: usize = 4 * 1024 * 1024;
const MAX_BODY_OUT: usize = 16 * 1024 * 1024;
const MAX_PATH: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Target {
    Llm {
        #[serde(rename = "endpointId")]
        endpoint_id: String,
    },
    Om,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpReq {
    pub target: Target,
    pub method: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_sec: Option<u64>,
    /// credential to use instead of the stored one (verifying a token before it is saved)
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpRes {
    pub status: u16,
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub body: String,
}

fn err(code: &str, msg: &str) -> AppError {
    AppError::new(code, msg)
}

/// `path` is appended to the configured base URL: it must be empty or start with a single `/`, with no query/fragment/dot-segments.
pub fn validate_path(p: &str) -> Result<(), AppError> {
    if p.is_empty() {
        return Ok(());
    }
    let bad = !p.starts_with('/')
        || p.starts_with("//")
        || p.len() > MAX_PATH
        || p.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '?' | '#' | '\\'))
        || p.split('/').any(|s| s == ".." || s == ".");
    if bad {
        return Err(AppError::bad_request("invalid agent request path"));
    }
    Ok(())
}

/// Headers the webview may set. Authorization/Host/Cookie/... are never accepted; the credential is attached here.
pub fn allowed_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(n.as_str(), "content-type" | "accept" | "mcp-protocol-version" | "mcp-session-id") || n.starts_with("x-")
}

fn valid_header_value(v: &str) -> bool {
    v.len() <= 512 && !v.chars().any(|c| c.is_control())
}

pub struct AgentHttp {
    client: reqwest::Client,
    inflight: Mutex<HashMap<String, Arc<Notify>>>,
}

struct Guard<'a>(&'a AgentHttp, String);
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if let Ok(mut m) = self.0.inflight.lock() {
            m.remove(&self.1);
        }
    }
}

impl AgentHttp {
    pub fn new(proxy_url: Option<&str>) -> Self {
        // reqwest is built with `rustls-no-provider`: install the `ring` provider (already in the dependency tree) once per process
        static TLS: std::sync::Once = std::sync::Once::new();
        TLS.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
        let mut b = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(15)).user_agent("vnpay-tabledb");
        if let Some(p) = proxy_url.filter(|p| p.starts_with("http://") || p.starts_with("https://")) {
            match reqwest::Proxy::all(p) {
                Ok(px) => b = b.proxy(px),
                Err(_) => log::warn!("agent: proxy.url ignored (invalid)"),
            }
        }
        Self { client: b.build().unwrap_or_default(), inflight: Mutex::new(HashMap::new()) }
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some(n) = self.inflight.lock().ok().and_then(|m| m.get(request_id).cloned()) {
            n.notify_one();
        }
    }

    /// Resolve target -> (base url, credential key, auth header name, scheme).
    fn resolve<'a>(cfg: &'a AgentConfig, t: &Target) -> Result<(&'a str, &'static str), AppError> {
        match t {
            Target::Llm { endpoint_id } => {
                let ep = cfg.endpoints.iter().find(|e| &e.id == endpoint_id).ok_or_else(|| err("E_AGENT_ENDPOINT", "unknown LLM endpoint"))?;
                Ok((ep.base_url.as_str(), TOKEN_KEY_LLM))
            }
            Target::Om => {
                let u = cfg.open_metadata_url.as_deref().ok_or_else(|| err("E_AGENT_ENDPOINT", "OpenMetadata is not configured"))?;
                Ok((u, TOKEN_KEY_OM))
            }
        }
    }

    pub async fn request(&self, request_id: &str, cfg: &AgentConfig, vault: Arc<Vault>, req: HttpReq) -> Result<HttpRes, AppError> {
        let (base, key) = Self::resolve(cfg, &req.target)?;
        let path = req.path.as_deref().unwrap_or("");
        validate_path(path)?;
        let method = match req.method.to_ascii_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            _ => return Err(AppError::bad_request("method must be GET or POST")),
        };
        if req.body.as_ref().map_or(0, |b| b.len()) > MAX_BODY_IN {
            return Err(AppError::bad_request("request body too large"));
        }
        let url = format!("{}{}", base.trim_end_matches('/'), path);
        let token = match req.token.filter(|t| !t.is_empty()) {
            Some(t) => t,
            None => {
                let v = vault.clone();
                tauri::async_runtime::spawn_blocking(move || v.get(key))
                    .await
                    .map_err(|_| err("E_INTERNAL", "task failed"))??
                    .ok_or_else(|| err("E_AGENT_NO_TOKEN", "no token configured"))?
            }
        };
        let auth = match cfg.auth_scheme.as_str() {
            "" => token,
            s => format!("{s} {token}"),
        };
        if !valid_header_value(&auth) {
            return Err(AppError::bad_request("invalid credential"));
        }
        let mut rb = self.client.request(method, &url).header(cfg.auth_header.as_str(), auth);
        for (k, v) in req.headers.unwrap_or_default() {
            if !allowed_header(&k) || !valid_header_value(&v) {
                return Err(AppError::bad_request("header not allowed"));
            }
            rb = rb.header(k, v);
        }
        if let Some(b) = req.body {
            rb = rb.body(b);
        }
        let timeout = Duration::from_secs(req.timeout_sec.unwrap_or(120).clamp(1, 300));

        let notify = Arc::new(Notify::new());
        if let Ok(mut m) = self.inflight.lock() {
            m.insert(request_id.to_string(), notify.clone());
        }
        let _guard = Guard(self, request_id.to_string());
        let work = async {
            let mut resp = rb.send().await.map_err(|e| {
                log::debug!("agent http send failed: timeout={} connect={}", e.is_timeout(), e.is_connect());
                AppError::new("E_AGENT_NETWORK", if e.is_timeout() { "request timed out" } else { "endpoint unreachable" }).retryable(true)
            })?;
            let status = resp.status().as_u16();
            let hv = |n: &str| resp.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
            let content_type = hv("content-type").unwrap_or_default();
            let session_id = hv("mcp-session-id");
            let mut buf: Vec<u8> = Vec::new();
            while let Some(chunk) = resp.chunk().await.map_err(|_| AppError::new("E_AGENT_NETWORK", "response interrupted").retryable(true))? {
                if buf.len() + chunk.len() > MAX_BODY_OUT {
                    return Err(err("E_AGENT_TOO_LARGE", "response too large"));
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(HttpRes { status, content_type, session_id, body: String::from_utf8_lossy(&buf).into_owned() })
        };
        tokio::select! {
            r = tokio::time::timeout(timeout, work) => r.unwrap_or_else(|_| Err(AppError::new("E_AGENT_NETWORK", "request timed out").retryable(true))),
            _ = notify.notified() => Err(err("E_CANCELLED", "cancelled")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        for ok in ["", "/", "/chat/completions", "/v1/models"] {
            assert!(validate_path(ok).is_ok(), "{ok}");
        }
        for bad in ["chat", "//evil.com", "/a/../b", "/a?x=1", "/a#f", "/a b", "/a\\b", "/./a", "/a\n"] {
            assert!(validate_path(bad).is_err(), "{bad}");
        }
        assert!(validate_path(&format!("/{}", "a".repeat(300))).is_err());
    }

    #[test]
    fn headers() {
        for ok in ["Content-Type", "accept", "Mcp-Session-Id", "MCP-Protocol-Version", "X-Trace"] {
            assert!(allowed_header(ok), "{ok}");
        }
        for bad in ["Authorization", "Host", "Cookie", "Proxy-Authorization", "Content-Length", "Transfer-Encoding"] {
            assert!(!allowed_header(bad), "{bad}");
        }
    }

    fn cfg() -> AgentConfig {
        let mut c = AgentConfig::default();
        c.endpoints = vec![crate::config::AgentEndpoint { id: "gw".into(), label: "GW".into(), base_url: "https://genai.example.vn/aigateway/x/v1".into(), models: vec!["m".into()], description: None }];
        c.open_metadata_url = Some("https://om.example.vn/mcp".into());
        c
    }

    #[test]
    fn targets_resolve_only_from_config() {
        let c = cfg();
        let (u, k) = AgentHttp::resolve(&c, &Target::Llm { endpoint_id: "gw".into() }).unwrap();
        assert_eq!((u, k), ("https://genai.example.vn/aigateway/x/v1", TOKEN_KEY_LLM));
        assert!(AgentHttp::resolve(&c, &Target::Llm { endpoint_id: "evil".into() }).is_err());
        assert_eq!(AgentHttp::resolve(&c, &Target::Om).unwrap(), ("https://om.example.vn/mcp", TOKEN_KEY_OM));
        assert!(AgentHttp::resolve(&AgentConfig::default(), &Target::Om).is_err());
    }

    #[test]
    fn client_builds_with_the_compiled_tls_provider() {
        // reqwest panics at build time if rustls has no default crypto provider
        let _ = AgentHttp::new(None);
        let _ = AgentHttp::new(Some("http://proxy.local:8080"));
    }

    #[tokio::test]
    async fn cancel_wakes_a_pending_request() {
        // loopback listener that accepts but never answers
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move { let _held = l.accept().await; tokio::time::sleep(Duration::from_secs(30)).await; });
        let mut cfg = AgentConfig::default();
        cfg.endpoints = vec![crate::config::AgentEndpoint { id: "lo".into(), label: "lo".into(), base_url: format!("http://127.0.0.1:{port}"), models: vec!["m".into()], description: None }];
        let http = Arc::new(AgentHttp::new(None));
        let vault = Arc::new(Vault::new("vn.vnpay.tabledb.test-agent-http".into()));
        let req: HttpReq = serde_json::from_str(r#"{"target":{"kind":"llm","endpointId":"lo"},"method":"POST","path":"/x","body":"{}","token":"tok-12345678"}"#).unwrap();
        let h2 = http.clone();
        let task = tokio::spawn(async move { h2.request("rid-1", &cfg, vault, req).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        http.cancel("rid-1");
        let r = tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
        assert_eq!(r.unwrap_err().code, "E_CANCELLED");
    }

    #[test]
    fn request_json_shape() {
        let r: HttpReq = serde_json::from_str(r#"{"target":{"kind":"llm","endpointId":"gw"},"method":"POST","path":"/chat/completions","timeoutSec":5}"#).unwrap();
        assert!(matches!(r.target, Target::Llm { ref endpoint_id } if endpoint_id == "gw"));
        assert_eq!(r.timeout_sec, Some(5));
        let r: HttpReq = serde_json::from_str(r#"{"target":{"kind":"om"},"method":"GET"}"#).unwrap();
        assert!(matches!(r.target, Target::Om));
    }
}
