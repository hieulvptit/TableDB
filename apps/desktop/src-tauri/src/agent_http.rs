//! HTTP bridge for the local Agent (LLM gateway + OpenMetadata MCP). The webview never gets a CSP hole and never reads a stored
//! credential: it names a *target* (an LLM endpoint id from server configuration, or the OpenMetadata MCP URL); this module resolves the base
//! URL from the validated server config, attaches the credential from the OS credential store (or the one being verified before it is
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
const MAX_PATH: usize = 4096;

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
    /// Emit SSE response chunks to the requesting webview.
    #[serde(default)]
    pub stream: bool,
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
    clients: Mutex<HashMap<(Option<String>, u64), reqwest::Client>>,
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
        Self { clients: Mutex::new(HashMap::from([((proxy_url.map(str::to_string), 15), b.build().unwrap_or_default())])), inflight: Mutex::new(HashMap::new()) }
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
        self.request_with_progress(request_id, cfg, vault, req, None).await
    }

    pub async fn request_with_progress(&self, request_id: &str, cfg: &AgentConfig, vault: Arc<Vault>, req: HttpReq, on_chunk: Option<Arc<dyn Fn(&[u8]) + Send + Sync>>) -> Result<HttpRes, AppError> {
        let stream = req.stream && matches!(&req.target, Target::Llm { .. });
        let notify = Arc::new(Notify::new());
        if let Ok(mut m) = self.inflight.lock() {
            m.insert(request_id.to_string(), notify.clone());
        }
        let _guard = Guard(self, request_id.to_string());
        let (base, key) = Self::resolve(cfg, &req.target)?;
        let path = req.path.as_deref().unwrap_or("");
        validate_path(path)?;
        if path.len() > cfg.runtime.http.max_path_chars { return Err(AppError::bad_request("agent path too long")); }
        let method = match req.method.to_ascii_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            _ => return Err(AppError::bad_request("method must be GET or POST")),
        };
        if req.body.as_ref().map_or(0, |b| b.len()) > cfg.runtime.http.max_request_bytes {
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
        let client = {
            let key = (cfg.proxy_url.clone(), cfg.runtime.http.connect_timeout_sec);
            let mut clients = self.clients.lock().map_err(|_| err("E_INTERNAL", "HTTP client lock failed"))?;
            if let Some(client) = clients.get(&key) { client.clone() } else {
                let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(key.1)).user_agent("vnpay-tabledb");
                if let Some(proxy) = &key.0 { builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| AppError::bad_request("invalid proxy"))?); }
                let client = builder.build().map_err(|_| err("E_AGENT_NETWORK", "could not create HTTP client"))?;
                clients.clear();
                clients.insert(key, client.clone());
                client
            }
        };
        let mut rb = client.request(method, &url).header(cfg.auth_header.as_str(), auth);
        for (k, v) in req.headers.unwrap_or_default() {
            if !allowed_header(&k) || !valid_header_value(&v) {
                return Err(AppError::bad_request("header not allowed"));
            }
            rb = rb.header(k, v);
        }
        if let Some(b) = req.body {
            rb = rb.body(b);
        }
        let timeout = Duration::from_secs(req.timeout_sec.unwrap_or(cfg.runtime.http.default_timeout_sec).clamp(1, cfg.runtime.http.max_timeout_sec));

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
                if buf.len() + chunk.len() > cfg.runtime.http.max_response_bytes {
                    return Err(err("E_AGENT_TOO_LARGE", "response too large"));
                }
                if stream && (200..300).contains(&status) && content_type.contains("text/event-stream") {
                    if let Some(callback) = &on_chunk { callback(&chunk); }
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(HttpRes { status, content_type, session_id, body: String::from_utf8_lossy(&buf).into_owned() })
        };
        tokio::select! {
            biased;
            _ = notify.notified() => Err(err("E_CANCELLED", "cancelled")),
            r = tokio::time::timeout(timeout, work) => r.unwrap_or_else(|_| Err(AppError::new("E_AGENT_NETWORK", "request timed out").retryable(true))),
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
        assert!(validate_path(&format!("/{}", "a".repeat(MAX_PATH))).is_err());
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
        assert!(!r.stream);
        let r: HttpReq = serde_json::from_str(r#"{"target":{"kind":"om"},"method":"GET"}"#).unwrap();
        assert!(matches!(r.target, Target::Om));
    }

    #[tokio::test]
    async fn emits_sse_chunks_before_the_response_finishes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let first = b"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n";
        let last = b"data: [DONE]\n\n";
        let received = Arc::new(Notify::new());
        let server_received = received.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            let _ = socket.read(&mut request).await.unwrap();
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", first.len() + last.len());
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(first).await.unwrap();
            // The server sends the final event only after the consumer sees a chunk.
            tokio::time::timeout(Duration::from_secs(2), server_received.notified()).await.unwrap();
            socket.write_all(last).await.unwrap();
        });
        let mut config = AgentConfig::default();
        config.endpoints = vec![crate::config::AgentEndpoint { id: "gw".into(), label: "GW".into(), base_url: format!("http://{address}"), models: vec!["m".into()], description: None }];
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let output = chunks.clone();
        let progress: Arc<dyn Fn(&[u8]) + Send + Sync> = Arc::new(move |bytes| {
            output.lock().unwrap().extend_from_slice(bytes);
            received.notify_one();
        });
        let http = AgentHttp::new(None);
        let req: HttpReq = serde_json::from_str(r#"{"target":{"kind":"llm","endpointId":"gw"},"method":"POST","stream":true,"body":"{}","token":"test-token","timeoutSec":5}"#).unwrap();
        let response = http.request_with_progress("stream-test", &config, Arc::new(Vault::new("test-stream".into())), req, Some(progress)).await.unwrap();
        server.await.unwrap();
        assert_eq!(response.body.as_bytes(), [first.as_slice(), last.as_slice()].concat());
        assert_eq!(chunks.lock().unwrap().as_slice(), response.body.as_bytes());
    }
    #[tokio::test]
    async fn applies_server_response_byte_limit() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            let _ = socket.read(&mut request).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n1234567890").await.unwrap();
        });
        let mut config = AgentConfig::default();
        config.endpoints = vec![crate::config::AgentEndpoint { id: "gw".into(), label: "GW".into(), base_url: format!("http://{address}"), models: vec!["m".into()], description: None }];
        config.runtime.http.max_response_bytes = 4;
        let http = AgentHttp::new(None);
        let vault = Arc::new(Vault::new("test-response-limit".into()));
        let req = HttpReq { target: Target::Llm { endpoint_id: "gw".into() }, method: "GET".into(), path: None, headers: None, body: None, timeout_sec: None, stream: false, token: Some("test-token".into()) };
        assert_eq!(http.request("limit", &config, vault, req).await.unwrap_err().code, "E_AGENT_TOO_LARGE");
        server.await.unwrap();
    }

}
