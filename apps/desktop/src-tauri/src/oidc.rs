//! RFC 8252 loopback OIDC flow (system browser, PKCE). The Rust core owns verifier/state; the SPA/API do the
//! code exchange (POST /auth/desktop/exchange). Endpoint + client_id come from the API's /auth/desktop/config.
//! Never embeds a WebView login.

use crate::error::AppError;
use crate::urlcheck::validate_endpoint;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{timeout, timeout_at, Instant};
use url::Url;

pub const CALLBACK_PATH: &str = "/cb";
const MAX_HEAD: usize = 8192;
const DEFAULT_TIMEOUT_SEC: u64 = 300;
const RESERVED: &[&str] =
    &["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OidcBeginParams {
    /// Authorization endpoint from /auth/desktop/config.
    pub authorize_endpoint: String,
    pub client_id: String,
    #[serde(default)]
    pub scope: Option<String>,
    /// e.g. prompt, max_age, login_hint, audience. Reserved names are rejected.
    #[serde(default)]
    pub extra_params: BTreeMap<String, String>,
    #[serde(default)]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OidcResult {
    pub code: String,
    pub redirect_uri: String,
    pub code_verifier: String,
}

#[derive(Debug, PartialEq)]
pub enum CallbackError {
    NotCallback,
    Malformed,
    Provider { error: String, description: Option<String> },
    StateMismatch,
    MissingCode,
}

// ---------- crypto helpers ----------

fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

/// 32 random bytes -> 43 char base64url verifier (RFC 7636 s4.1).
pub fn generate_verifier() -> String {
    random_b64(32)
}
pub fn generate_state() -> String {
    random_b64(24)
}
/// S256 challenge.
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------- URL building ----------

pub fn build_authorize_url(p: &OidcBeginParams, redirect_uri: &str, state: &str, challenge: &str) -> Result<Url, AppError> {
    let mut u = validate_endpoint(&p.authorize_endpoint)?;
    if p.client_id.is_empty() || p.client_id.len() > 256 || p.client_id.chars().any(|c| c.is_control()) {
        return Err(AppError::bad_request("invalid clientId"));
    }
    for (k, v) in &p.extra_params {
        if RESERVED.contains(&k.to_ascii_lowercase().as_str())
            || k.is_empty()
            || k.len() > 64
            || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            || v.len() > 512
            || v.chars().any(|c| c.is_control())
        {
            return Err(AppError::bad_request(format!("extra param not allowed: {k}")));
        }
    }
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", &p.client_id);
        q.append_pair("redirect_uri", redirect_uri);
        q.append_pair("scope", p.scope.as_deref().unwrap_or("openid profile email"));
        q.append_pair("state", state);
        q.append_pair("code_challenge", challenge);
        q.append_pair("code_challenge_method", "S256");
        for (k, v) in &p.extra_params {
            q.append_pair(k, v);
        }
    }
    Ok(u)
}

// ---------- callback parsing ----------

/// Parse the HTTP request line (`GET /cb?code=..&state=.. HTTP/1.1`) of a loopback callback.
pub fn parse_callback(request_line: &str, expected_state: &str) -> Result<String, CallbackError> {
    let mut it = request_line.split_whitespace();
    let (method, target) = (it.next().ok_or(CallbackError::Malformed)?, it.next().ok_or(CallbackError::Malformed)?);
    if method != "GET" {
        return Err(CallbackError::NotCallback);
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| CallbackError::Malformed)?;
    if url.path() != CALLBACK_PATH {
        return Err(CallbackError::NotCallback);
    }
    let q: BTreeMap<String, String> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    if let Some(s) = q.get("state") {
        if !ct_eq(s, expected_state) {
            return Err(CallbackError::StateMismatch);
        }
    }
    if let Some(err) = q.get("error") {
        return Err(CallbackError::Provider {
            error: err.chars().take(64).collect(),
            description: q.get("error_description").map(|d| d.chars().take(200).collect()),
        });
    }
    if q.get("state").is_none() {
        return Err(CallbackError::StateMismatch);
    }
    match q.get("code") {
        Some(c) if !c.is_empty() && c.len() <= 4096 => Ok(c.clone()),
        _ => Err(CallbackError::MissingCode),
    }
}

/// DNS-rebinding guard: Host header must be the loopback literal/localhost with our port.
pub fn host_header_ok(head: &str, port: u16) -> bool {
    head.lines().skip(1).any(|l| {
        l.split_once(':').is_some_and(|(k, v)| {
            k.eq_ignore_ascii_case("host") && {
                let v = v.trim();
                v == format!("127.0.0.1:{port}") || v == format!("localhost:{port}")
            }
        })
    })
}

// ---------- HTTP responses ----------

fn page(status: &str, title: &str, body: &str) -> String {
    let html = format!(
        "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>{title}</title>\
<style>body{{font-family:Segoe UI,system-ui,sans-serif;background:#f4f6f8;color:#1b2733;display:flex;\
align-items:center;justify-content:center;height:100vh;margin:0}}.c{{background:#fff;padding:32px 40px;\
border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);max-width:420px;text-align:center}}h1{{font-size:20px;margin:0 0 12px}}\
p{{margin:6px 0;color:#455566}}</style></head><body><div class=\"c\"><h1>{title}</h1>{body}</div></body></html>"
    );
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
Referrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{html}",
        html.len()
    )
}
pub fn success_page() -> String {
    page(
        "200 OK",
        "Đăng nhập thành công / Signed in",
        "<p>Bạn có thể đóng tab này và quay lại ứng dụng TableDB.</p><p>You can close this tab and return to TableDB.</p>",
    )
}
pub fn failure_page() -> String {
    page(
        "400 Bad Request",
        "Đăng nhập không thành công / Sign-in failed",
        "<p>Vui lòng quay lại ứng dụng TableDB và thử lại.</p><p>Please return to TableDB and try again.</p>",
    )
}
fn not_found() -> String {
    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
}

async fn read_head(s: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = timeout(Duration::from_secs(5), s.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

// ---------- the flow ----------

/// `open` receives the authorize URL and must launch the system browser.
/// The listener lives only for this call (single use): it is dropped on every exit path.
pub async fn run_flow<F>(params: OidcBeginParams, open: F) -> Result<OidcResult, AppError>
where
    F: FnOnce(&str) -> Result<(), AppError>,
{
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| AppError::new("E_OIDC_LISTEN", "cannot bind loopback listener"))?;
    let port = listener.local_addr().map_err(|_| AppError::new("E_OIDC_LISTEN", "no local addr"))?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let verifier = generate_verifier();
    let state = generate_state();
    let url = build_authorize_url(&params, &redirect_uri, &state, &challenge_for(&verifier))?;
    let secs = params.timeout_sec.unwrap_or(DEFAULT_TIMEOUT_SEC).clamp(30, 600);
    let deadline = Instant::now() + Duration::from_secs(secs);

    open(url.as_str())?;

    loop {
        let (mut stream, peer) = match timeout_at(deadline, listener.accept()).await {
            Err(_) => return Err(AppError::new("E_OIDC_TIMEOUT", "sign-in timed out").retryable(true)),
            Ok(Err(_)) => continue,
            Ok(Ok(x)) => x,
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let Some(head) = read_head(&mut stream).await else { continue };
        if !host_header_ok(&head, port) {
            let _ = stream.write_all(not_found().as_bytes()).await;
            continue;
        }
        let first = head.lines().next().unwrap_or("");
        match parse_callback(first, &state) {
            Ok(code) => {
                let _ = stream.write_all(success_page().as_bytes()).await;
                let _ = stream.shutdown().await;
                return Ok(OidcResult { code, redirect_uri, code_verifier: verifier });
            }
            Err(CallbackError::NotCallback) | Err(CallbackError::Malformed) => {
                let _ = stream.write_all(not_found().as_bytes()).await;
            }
            Err(e) => {
                let _ = stream.write_all(failure_page().as_bytes()).await;
                let _ = stream.shutdown().await;
                return Err(match e {
                    CallbackError::StateMismatch => AppError::new("E_OIDC_STATE", "state mismatch, sign-in aborted"),
                    CallbackError::MissingCode => AppError::new("E_OIDC_NO_CODE", "callback had no authorization code"),
                    CallbackError::Provider { error, description } => AppError::new(
                        "E_OIDC_PROVIDER",
                        match description {
                            Some(d) => format!("{error}: {d}"),
                            None => error,
                        },
                    ),
                    _ => unreachable!(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> OidcBeginParams {
        OidcBeginParams {
            authorize_endpoint: "https://s2o.vnpay.vn/oauth2/authorize".into(),
            client_id: "tabledb-desktop".into(),
            scope: None,
            extra_params: BTreeMap::new(),
            timeout_sec: Some(30),
        }
    }

    #[test]
    fn pkce_rfc7636_vector() {
        // RFC 7636 Appendix B
        assert_eq!(challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn verifier_and_state_are_random_and_well_formed() {
        let (a, b) = (generate_verifier(), generate_verifier());
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(generate_state(), generate_state());
        assert!(generate_state().len() >= 32);
    }

    #[test]
    fn authorize_url_contains_pkce_and_rejects_reserved_extras() {
        let u = build_authorize_url(&params(), "http://127.0.0.1:1234/cb", "st", "ch").unwrap();
        let q: BTreeMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:1234/cb");
        assert_eq!(q["state"], "st");
        let mut p = params();
        p.extra_params.insert("redirect_uri".into(), "http://evil".into());
        assert!(build_authorize_url(&p, "r", "s", "c").is_err());
        let mut p = params();
        p.authorize_endpoint = "http://evil.com/authorize".into();
        assert!(build_authorize_url(&p, "r", "s", "c").is_err());
        let mut p = params();
        p.extra_params.insert("prompt".into(), "login".into());
        p.extra_params.insert("max_age".into(), "0".into());
        assert!(build_authorize_url(&p, "r", "s", "c").is_ok());
    }

    #[test]
    fn callback_ok() {
        assert_eq!(parse_callback("GET /cb?code=abc%20d&state=S1 HTTP/1.1", "S1"), Ok("abc d".into()));
    }

    #[test]
    fn callback_state_mismatch_or_missing() {
        assert_eq!(parse_callback("GET /cb?code=abc&state=BAD HTTP/1.1", "S1"), Err(CallbackError::StateMismatch));
        assert_eq!(parse_callback("GET /cb?code=abc HTTP/1.1", "S1"), Err(CallbackError::StateMismatch));
        // error response with wrong state must not be trusted as a provider error
        assert_eq!(parse_callback("GET /cb?error=access_denied&state=BAD HTTP/1.1", "S1"), Err(CallbackError::StateMismatch));
    }

    #[test]
    fn callback_error_param() {
        assert_eq!(
            parse_callback("GET /cb?error=access_denied&error_description=User+said+no&state=S1 HTTP/1.1", "S1"),
            Err(CallbackError::Provider { error: "access_denied".into(), description: Some("User said no".into()) })
        );
    }

    #[test]
    fn callback_other_paths_and_methods() {
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1", "S1"), Err(CallbackError::NotCallback));
        assert_eq!(parse_callback("POST /cb?code=a&state=S1 HTTP/1.1", "S1"), Err(CallbackError::NotCallback));
        assert_eq!(parse_callback("GET /cb?state=S1 HTTP/1.1", "S1"), Err(CallbackError::MissingCode));
        assert_eq!(parse_callback("", "S1"), Err(CallbackError::Malformed));
    }

    #[test]
    fn host_header_guard() {
        let ok = "GET /cb HTTP/1.1\r\nHost: 127.0.0.1:5555\r\n\r\n";
        assert!(host_header_ok(ok, 5555));
        assert!(!host_header_ok(ok, 5556));
        assert!(!host_header_ok("GET /cb HTTP/1.1\r\nHost: evil.com:5555\r\n\r\n", 5555));
        assert!(!host_header_ok("GET /cb HTTP/1.1\r\n\r\n", 5555));
    }

    async fn http_get(port: u16, path: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    /// opener that simulates the browser: hits the loopback with a chosen query built from the authorize URL.
    fn browser(make_query: fn(&str) -> String) -> impl FnOnce(&str) -> Result<(), AppError> {
        move |url: &str| {
            let u = Url::parse(url).unwrap();
            let q: BTreeMap<_, _> = u.query_pairs().into_owned().collect();
            let ru = Url::parse(&q["redirect_uri"]).unwrap();
            let port = ru.port().unwrap();
            let path = format!("{}?{}", ru.path(), make_query(&q["state"]));
            tokio::spawn(async move {
                let body = http_get(port, "/favicon.ico").await; // stray request must not end the flow
                assert!(body.starts_with("HTTP/1.1 404"));
                let body = http_get(port, &path).await;
                assert!(body.contains("text/html"));
            });
            Ok(())
        }
    }

    #[tokio::test]
    async fn full_flow_success() {
        let r = run_flow(params(), browser(|s| format!("code=THECODE&state={s}"))).await.unwrap();
        assert_eq!(r.code, "THECODE");
        assert!(r.redirect_uri.starts_with("http://127.0.0.1:") && r.redirect_uri.ends_with("/cb"));
        assert_eq!(r.code_verifier.len(), 43);
    }

    #[tokio::test]
    async fn full_flow_state_mismatch() {
        let e = run_flow(params(), browser(|_| "code=x&state=forged".into())).await.unwrap_err();
        assert_eq!(e.code, "E_OIDC_STATE");
    }

    #[tokio::test]
    async fn full_flow_provider_error() {
        let e = run_flow(params(), browser(|s| format!("error=access_denied&state={s}"))).await.unwrap_err();
        assert_eq!(e.code, "E_OIDC_PROVIDER");
    }

    #[tokio::test]
    async fn opener_failure_propagates_and_timeout_fires() {
        let e = run_flow(params(), |_| Err(AppError::new("E_OPEN", "no browser"))).await.unwrap_err();
        assert_eq!(e.code, "E_OPEN");
        tokio::time::pause();
        let h = tokio::spawn(run_flow(params(), |_| Ok(())));
        tokio::time::sleep(Duration::from_secs(31)).await;
        assert_eq!(h.await.unwrap().unwrap_err().code, "E_OIDC_TIMEOUT");
    }
}
