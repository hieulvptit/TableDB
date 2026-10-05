//! VNPAY SSO broker login (`https://genai.vnpay.vn/create-jwt-token?connectid=<CONNECTID>`).
//!
//! DEFAULT protocol (as the antisw reference apps): CONNECTID = `<port>`, callback `GET /sso-callback?token=<JWT>`.
//! OPT-IN hardening (`genaiSecretPath`, enable only after genai validates connectid with a regex that allows this form):
//! CONNECTID = `<port>/cb/<S>`, callback `GET /cb/<S>/sso-callback?token=…`.
//!
//! The broker redirects the browser to `"http://localhost:" + CONNECTID + "/sso-callback?token=<JWT>"` (plain string
//! concatenation, host `localhost`). Because the broker has no `state` support we get login-CSRF protection by putting a
//! 256-bit secret path segment into CONNECTID (opt-in mode). The loopback listener (bound to 127.0.0.1 AND ::1 on the
//! same port, since `localhost` may resolve to either) only accepts the callback path of the active mode and only ONCE.
//! The JWT is NOT verified here (HS256, verified by the API). The token and S are never logged.

use crate::error::AppError;
use crate::urlcheck::{origin_string, validate_external_url};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use url::Url;

pub const DEFAULT_ORIGIN: &str = "https://genai.vnpay.vn";
const MAX_HEAD: usize = 8192;
const MAX_TOKEN: usize = 4096;
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_TIMEOUT_SEC: u64 = 300; // password + OTP + phone approval on Google/Keycloak needs more than 3 minutes

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenaiLoginParams {
    /// From the API's /auth/config `desktopLoginUrl` (e.g. https://genai.vnpay.vn/create-jwt-token).
    pub login_url: String,
    #[serde(default)]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GenaiLoginResult {
    pub token: String,
}

// ---------- helpers ----------

/// 32 random bytes -> 43 chars of [A-Za-z0-9_-].
pub fn generate_secret() -> String {
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Looks like a JWT: `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$`, at most 4 KiB.
pub fn looks_like_jwt(t: &str) -> bool {
    if t.is_empty() || t.len() > MAX_TOKEN {
        return false;
    }
    let ok = |s: &str| s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-');
    let parts: Vec<&str> = t.split('.').collect();
    parts.len() == 3 && !parts[0].is_empty() && !parts[1].is_empty() && parts.iter().all(|p| ok(p))
}

/// https + origin in the allow-list (already normalised origins). Returns the parsed URL.
pub fn check_login_url(raw: &str, allowed: &[String]) -> Result<Url, AppError> {
    let u = validate_external_url(raw)?;
    if u.scheme() != "https" {
        return Err(AppError::new("E_GENAI_ORIGIN", "login url must be https"));
    }
    let origin = origin_string(&u);
    if !allowed.iter().any(|a| a.eq_ignore_ascii_case(&origin)) {
        return Err(AppError::new("E_GENAI_ORIGIN", "login url origin is not allowed"));
    }
    Ok(u)
}

/// Normalise + validate a configured allow-list entry (must be an https origin).
pub fn normalize_origin(raw: &str) -> Result<String, AppError> {
    let u = validate_external_url(raw.trim())?;
    if u.scheme() != "https" || u.path() != "/" || u.query().is_some() || u.fragment().is_some() {
        return Err(AppError::bad_request("genaiLoginOrigins entries must be https origins (no path)"));
    }
    Ok(origin_string(&u))
}

pub fn build_login_url(base: &Url, connect_id: &str) -> Url {
    let mut u = base.clone();
    let keep: Vec<(String, String)> =
        base.query_pairs().filter(|(k, _)| !k.eq_ignore_ascii_case("connectid")).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    u.set_query(None);
    {
        let mut q = u.query_pairs_mut();
        for (k, v) in keep {
            q.append_pair(&k, &v);
        }
        q.append_pair("connectid", connect_id);
    }
    u
}

// ---------- request evaluation ----------

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Not our callback (wrong method/path/secret/host): 404, listener untouched.
    NotFound,
    /// Correct secret path + host but unusable token: failure page, flow ends with this error.
    Bad(&'static str),
    Token(String),
}

fn host_ok(head: &str, port: u16) -> bool {
    let mut hosts = head.split("\r\n").skip(1).take_while(|l| !l.is_empty()).filter_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("host").then(|| v.trim().to_string())
    });
    match (hosts.next(), hosts.next()) {
        (Some(h), None) => [format!("localhost:{port}"), format!("127.0.0.1:{port}"), format!("[::1]:{port}")].iter().any(|a| a.eq_ignore_ascii_case(&h)),
        _ => false,
    }
}

/// `secret`: None = default mode (`/sso-callback`), Some(S) = secret-path mode (`/cb/<S>/sso-callback`).
pub fn evaluate(head: &str, port: u16, secret: Option<&str>) -> Verdict {
    if !host_ok(head, port) {
        return Verdict::NotFound;
    }
    let first = head.split("\r\n").next().unwrap_or("");
    let mut it = first.split(' ');
    let (Some(method), Some(target), Some(ver), None) = (it.next(), it.next(), it.next(), it.next()) else {
        return Verdict::NotFound;
    };
    if method != "GET" || !ver.starts_with("HTTP/1.") {
        return Verdict::NotFound;
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    match secret {
        None => {
            if path != "/sso-callback" {
                return Verdict::NotFound;
            }
        }
        Some(secret) => {
            let Some(rest) = path.strip_prefix("/cb/") else { return Verdict::NotFound };
            let Some((seg, tail)) = rest.split_once('/') else { return Verdict::NotFound };
            // compare the secret first (constant time); the tail is public
            if !ct_eq(seg, secret) || tail != "sso-callback" {
                return Verdict::NotFound;
            }
        }
    }
    let token = url::form_urlencoded::parse(query.as_bytes()).find(|(k, _)| k == "token").map(|(_, v)| v.into_owned());
    match token {
        None => Verdict::Bad("E_GENAI_NO_TOKEN"),
        Some(t) if t.is_empty() => Verdict::Bad("E_GENAI_NO_TOKEN"),
        Some(t) if !looks_like_jwt(&t) => Verdict::Bad("E_GENAI_BAD_TOKEN"),
        Some(t) => Verdict::Token(t),
    }
}

// ---------- internal-browser mode (pure decision logic; the window itself lives in genai_internal.rs) ----------

/// Dummy `connectid` used in internal mode: no listener exists, the redirect is intercepted in the webview.
/// Dummy port for the internal-browser mode: no listener exists; the redirect is intercepted in on_navigation.
/// MUST NOT be on the browsers' blocked-ports list (WebKit/Chromium refuse `localhost:1` etc. BEFORE asking the app,
/// which silently stalled the login on "đang chuyển hướng…").
pub const INTERNAL_CONNECT_PORT: u16 = 47613;

/// Ports that WebKit/Chromium refuse to navigate to (ERR_UNSAFE_PORT).
pub const BROWSER_BLOCKED_PORTS: &[u16] = &[1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080];

#[derive(Debug, PartialEq)]
pub enum NavDecision {
    /// The broker's final redirect: capture (Ok(token)) or fail (Err(code)); the navigation itself is cancelled.
    Intercept(Result<String, &'static str>),
    Allow,
    Deny,
}

/// Decide what the login webview may navigate to. Only https, plus the single intercepted callback URL
/// `http://localhost|127.0.0.1|[::1]:<connect port>/sso-callback?token=<JWT>`.
pub fn navigation_decision(u: &Url, connect_port: u16) -> NavDecision {
    let loopback = matches!(u.host_str(), Some(h) if h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "[::1]");
    if u.scheme() == "http" && loopback && u.port() == Some(connect_port) && u.path() == "/sso-callback" {
        let token = u.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.into_owned());
        return NavDecision::Intercept(match token {
            None => Err("E_GENAI_NO_TOKEN"),
            Some(t) if t.is_empty() => Err("E_GENAI_NO_TOKEN"),
            Some(t) if !looks_like_jwt(&t) => Err("E_GENAI_BAD_TOKEN"),
            Some(t) => Ok(t),
        });
    }
    if u.scheme() == "https" && u.host_str().is_some() && u.username().is_empty() && u.password().is_none() {
        return NavDecision::Allow;
    }
    // Google's sign-in embeds a BotGuard frame that navigates to about:blank; harmless, and blocking it can break the sign-in
    if u.scheme() == "about" && u.path() == "blank" && u.query().is_none() {
        return NavDecision::Allow;
    }
    NavDecision::Deny
}

/// Proxy for the login webview: Tauri accepts only http:// or socks5:// URLs.
pub fn webview_proxy(proxy: Option<&str>) -> Result<Option<Url>, AppError> {
    let Some(p) = proxy.filter(|p| !p.is_empty()) else { return Ok(None) };
    let u = Url::parse(p).map_err(|_| AppError::new("E_PROXY_UNSUPPORTED", "proxy url malformed"))?;
    if !matches!(u.scheme(), "http" | "socks5") || cfg!(any(target_os = "android", target_os = "ios")) {
        return Err(AppError::new("E_PROXY_UNSUPPORTED", "the login browser supports only http:// or socks5:// proxies"));
    }
    Ok(Some(u))
}

// ---------- HTTP ----------

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
    page("200 OK", "Đăng nhập thành công", "<p>Bạn có thể đóng tab này và quay lại ứng dụng TableDB.</p>")
}
pub fn failure_page() -> String {
    page("400 Bad Request", "Đăng nhập không thành công", "<p>Vui lòng quay lại ứng dụng TableDB và thử lại.</p>")
}
fn not_found() -> &'static str {
    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n"
}

async fn read_head(s: &mut TcpStream) -> Option<String> {
    let read = async {
        let mut buf = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        loop {
            let n = s.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                return Some(buf);
            }
            if buf.len() > MAX_HEAD {
                return None;
            }
        }
    };
    let buf = timeout(HEAD_READ_TIMEOUT, read).await.ok()??;
    if buf.len() > MAX_HEAD + 1024 {
        return None;
    }
    String::from_utf8(buf).ok()
}

type Outcome = Result<String, AppError>;

async fn handle(mut stream: TcpStream, port: u16, secret: Option<Arc<str>>, consumed: Arc<AtomicBool>, tx: mpsc::UnboundedSender<Outcome>) {
    let Some(head) = read_head(&mut stream).await else {
        log::debug!("genai: dropped unreadable/oversized request");
        return;
    };
    let verdict = evaluate(&head, port, secret.as_deref());
    if verdict == Verdict::NotFound {
        log::debug!("genai: rejected probe (404)");
        let _ = stream.write_all(not_found().as_bytes()).await;
        let _ = stream.shutdown().await;
        return;
    }
    // exactly one valid callback wins
    if consumed.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        let _ = stream.write_all(not_found().as_bytes()).await;
        let _ = stream.shutdown().await;
        return;
    }
    let outcome = match verdict {
        Verdict::Token(t) => {
            let _ = stream.write_all(success_page().as_bytes()).await;
            Ok(t)
        }
        Verdict::Bad(code) => {
            let _ = stream.write_all(failure_page().as_bytes()).await;
            Err(AppError::new(code, if code == "E_GENAI_NO_TOKEN" { "callback had no token" } else { "callback token malformed" }))
        }
        Verdict::NotFound => unreachable!(),
    };
    let _ = stream.shutdown().await;
    let _ = tx.send(outcome);
}

async fn accept_loop(l: TcpListener, port: u16, secret: Option<Arc<str>>, consumed: Arc<AtomicBool>, tx: mpsc::UnboundedSender<Outcome>) {
    loop {
        let Ok((stream, peer)) = l.accept().await else { continue };
        if !peer.ip().is_loopback() {
            continue;
        }
        tokio::spawn(handle(stream, port, secret.clone(), consumed.clone(), tx.clone()));
    }
}

/// Bind 127.0.0.1:0 and [::1] on the same port (best effort for v6 if the host has no IPv6).
async fn bind_dual() -> Result<(u16, TcpListener, Option<TcpListener>), AppError> {
    let mut last_v6_err = None;
    for _ in 0..16 {
        let l4 = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|_| AppError::new("E_GENAI_LISTEN", "cannot bind loopback listener"))?;
        let port = l4.local_addr().map_err(|_| AppError::new("E_GENAI_LISTEN", "no local addr"))?.port();
        match TcpListener::bind(("::1", port)).await {
            Ok(l6) => return Ok((port, l4, Some(l6))),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                last_v6_err = Some(e);
                continue; // port taken on v6 only: try another one
            }
            Err(_) => return Ok((port, l4, None)), // no IPv6 on this host
        }
    }
    let _ = last_v6_err;
    Err(AppError::new("E_GENAI_LISTEN", "cannot bind loopback listener on a common port"))
}

// ---------- the flow ----------

/// `open` receives the full login URL (with connectid) and must launch the system browser.
/// Listener(s) live only for this call and are dropped on every exit path.
pub async fn run_flow<F>(
    params: GenaiLoginParams,
    allowed_origins: &[String],
    secret_path: bool,
    cancel: oneshot::Receiver<()>,
    open: F,
) -> Result<GenaiLoginResult, AppError>
where
    F: FnOnce(&str) -> Result<(), AppError>,
{
    let base = check_login_url(&params.login_url, allowed_origins)?;
    let secs = params.timeout_sec.unwrap_or(DEFAULT_TIMEOUT_SEC).clamp(5, 600);
    let (port, l4, l6) = bind_dual().await?;
    let secret: Option<Arc<str>> = secret_path.then(|| generate_secret().into());
    let connect_id = match &secret {
        Some(s) => format!("{port}/cb/{s}"),
        None => port.to_string(),
    };
    let url = build_login_url(&base, &connect_id);

    let consumed = Arc::new(AtomicBool::new(false));
    let (tx, mut rx) = mpsc::unbounded_channel::<Outcome>();
    struct Abort(Vec<tokio::task::JoinHandle<()>>);
    impl Drop for Abort {
        fn drop(&mut self) {
            self.0.iter().for_each(|h| h.abort());
        }
    }
    let mut tasks = vec![tokio::spawn(accept_loop(l4, port, secret.clone(), consumed.clone(), tx.clone()))];
    if let Some(l6) = l6 {
        tasks.push(tokio::spawn(accept_loop(l6, port, secret.clone(), consumed.clone(), tx.clone())));
    }
    let _abort = Abort(tasks);
    drop(tx);
    log::debug!("genai: listening on loopback port {port}");

    open(url.as_str())?;

    tokio::select! {
        r = rx.recv() => match r {
            Some(Ok(token)) => Ok(GenaiLoginResult { token }),
            Some(Err(e)) => Err(e),
            None => Err(AppError::new("E_GENAI_LISTEN", "listener stopped")),
        },
        _ = tokio::time::sleep(Duration::from_secs(secs)) => Err(AppError::new("E_GENAI_TIMEOUT", "sign-in timed out").retryable(true)),
        _ = cancel => Err(AppError::new("E_GENAI_CANCELLED", "sign-in cancelled")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const JWT: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.c2lnbmF0dXJlLXZhbHVl";

    fn allowed() -> Vec<String> {
        vec![DEFAULT_ORIGIN.to_string()]
    }
    fn params(t: u64) -> GenaiLoginParams {
        GenaiLoginParams { login_url: "https://genai.vnpay.vn/create-jwt-token".into(), timeout_sec: Some(t) }
    }
    fn no_cancel() -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        std::mem::forget(tx);
        rx
    }

    struct Cap;
    static LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
    impl log::Log for Cap {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, r: &log::Record) {
            LOGS.lock().unwrap().push(format!("{}", r.args()));
        }
        fn flush(&self) {}
    }

    /// (port, callback prefix) from the login URL's connectid: "" (default) or "/cb/<S>".
    fn connect_parts(login: &str) -> (u16, String) {
        let u = Url::parse(login).unwrap();
        let cid = u.query_pairs().find(|(k, _)| k == "connectid").unwrap().1.into_owned();
        match cid.split_once('/') {
            Some((port, rest)) => (port.parse().unwrap(), format!("/{rest}")),
            None => (cid.parse().unwrap(), String::new()),
        }
    }

    async fn raw(addr: &str, port: u16, req: &str) -> String {
        let mut s = TcpStream::connect(format!("{addr}:{port}")).await.unwrap();
        let _ = s.write_all(req.as_bytes()).await;
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out).await;
        String::from_utf8_lossy(&out).into_owned()
    }
    fn get(host: &str, path: &str) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n")
    }
    fn ipv6_available() -> bool {
        std::net::TcpListener::bind("[::1]:0").is_ok()
    }

    /// Run the flow with a fake browser (spawned task). `script` gets (port, secret).
    async fn flow_mode<Fut>(secret_path: bool, script: impl FnOnce(u16, String) -> Fut + Send + 'static) -> Result<GenaiLoginResult, AppError>
    where
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        run_flow(params(30), &allowed(), secret_path, no_cancel(), move |u| {
            let (port, secret) = connect_parts(u);
            tokio::spawn(script(port, secret));
            Ok(())
        })
        .await
    }

    async fn flow_with<Fut>(script: impl FnOnce(u16, String) -> Fut + Send + 'static) -> Result<GenaiLoginResult, AppError>
    where
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        flow_mode(false, script).await
    }

    #[test]
    fn secret_is_high_entropy_and_unique() {
        let (a, b) = (generate_secret(), generate_secret());
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    }

    #[test]
    fn origin_allow_list() {
        let a = allowed();
        assert!(check_login_url("https://genai.vnpay.vn/create-jwt-token", &a).is_ok());
        assert!(check_login_url("https://genai.vnpay.vn:443/x", &a).is_ok());
        for bad in [
            "http://genai.vnpay.vn/x",
            "https://genai.vnpay.vn.evil.com/x",
            "https://evil.com/https://genai.vnpay.vn",
            "https://genai.vnpay.vn:8443/x",
            "https://user:pw@genai.vnpay.vn/x",
            "https://genai.vnpay.vn@evil.com/x",
            "ftp://genai.vnpay.vn/x",
            "javascript:alert(1)",
            "",
        ] {
            assert!(check_login_url(bad, &a).is_err(), "{bad}");
        }
        let custom = vec![normalize_origin("https://genai.test.vnpay.vn/").unwrap()];
        assert!(check_login_url("https://genai.test.vnpay.vn/create-jwt-token", &custom).is_ok());
        assert!(check_login_url("https://genai.vnpay.vn/create-jwt-token", &custom).is_err());
        assert!(normalize_origin("http://genai.vnpay.vn").is_err());
        assert!(normalize_origin("https://genai.vnpay.vn/path").is_err());
    }

    #[test]
    fn jwt_shape() {
        assert!(looks_like_jwt(JWT));
        assert!(looks_like_jwt("a.b."));
        for bad in ["", "a.b", "a..c", ".b.c", "a.b.c.d", "a b.c.d", "a.b.c%20", &format!("a.b.{}", "x".repeat(4100))] {
            assert!(!looks_like_jwt(bad), "{bad}");
        }
    }

    #[test]
    fn login_url_carries_connectid_and_replaces_existing() {
        let base = Url::parse("https://genai.vnpay.vn/create-jwt-token?a=1&connectid=evil").unwrap();
        let u = build_login_url(&base, "1234/cb/SEC");
        let q: Vec<_> = u.query_pairs().into_owned().collect();
        assert_eq!(q, vec![("a".into(), "1".into()), ("connectid".into(), "1234/cb/SEC".into())]);
    }

    #[test]
    fn navigation_table() {
        let d = |u: &str| navigation_decision(&Url::parse(u).unwrap(), 1);
        assert_eq!(d(&format!("http://localhost:1/sso-callback?token={JWT}")), NavDecision::Intercept(Ok(JWT.into())));
        assert_eq!(d(&format!("http://127.0.0.1:1/sso-callback?token={JWT}")), NavDecision::Intercept(Ok(JWT.into())));
        assert_eq!(d("http://localhost:1/sso-callback?token=a%2Eb%2Ec"), NavDecision::Intercept(Ok("a.b.c".into())));
        assert_eq!(d("http://localhost:1/sso-callback"), NavDecision::Intercept(Err("E_GENAI_NO_TOKEN")));
        assert_eq!(d("http://localhost:1/sso-callback?token="), NavDecision::Intercept(Err("E_GENAI_NO_TOKEN")));
        assert_eq!(d("http://localhost:1/sso-callback?token=junk"), NavDecision::Intercept(Err("E_GENAI_BAD_TOKEN")));
        // https is fine, everything else is not
        assert_eq!(d("https://genai.vnpay.vn/create-jwt-token?connectid=1"), NavDecision::Allow);
        assert_eq!(d("https://sso.vnpay.vn/login"), NavDecision::Allow);
        for bad in [
            "http://genai.vnpay.vn/x",
            "http://localhost:2/sso-callback?token=a.b.c",
            "http://localhost:1/other?token=a.b.c",
            "http://localhost:1/",
            "http://evil.com:1/sso-callback?token=a.b.c",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost/index.html",
            "ipc://localhost/x",
            "http://ipc.localhost/x",
            "data:text/html,hi",
            "about:srcdoc",
            "about:blank?x=1",
            "https://user:pw@genai.vnpay.vn/x",
        ] {
            assert_eq!(d(bad), NavDecision::Deny, "{bad}");
        }
    }

    #[test]
    fn internal_connect_port_is_not_browser_blocked() {
        assert!(!BROWSER_BLOCKED_PORTS.contains(&INTERNAL_CONNECT_PORT));
    }

    #[test]
    fn intercepts_the_real_internal_port() {
        let u = Url::parse(&format!("http://localhost:{INTERNAL_CONNECT_PORT}/sso-callback?token=a.b.c")).unwrap();
        assert_eq!(navigation_decision(&u, INTERNAL_CONNECT_PORT), NavDecision::Intercept(Ok("a.b.c".into())));
    }

    #[test]
    fn about_blank_is_allowed() {
        assert_eq!(navigation_decision(&Url::parse("about:blank").unwrap(), 1), NavDecision::Allow);
    }

    #[test]
    fn proxy_for_webview() {
        assert_eq!(webview_proxy(None).unwrap(), None);
        assert_eq!(webview_proxy(Some("")).unwrap(), None);
        assert!(webview_proxy(Some("http://proxy:8080")).unwrap().is_some());
        assert!(webview_proxy(Some("socks5://proxy:1080")).unwrap().is_some());
        assert_eq!(webview_proxy(Some("https://proxy:8080")).unwrap_err().code, "E_PROXY_UNSUPPORTED");
    }

    #[test]
    fn remote_login_window_has_no_ipc_capability() {
        // The genai-login window loads a remote origin; it must never appear in a capability.
        let cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
        assert!(cap.get("webviews").is_none() && cap.get("remote").is_none());
        for f in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities")).unwrap() {
            let f = f.unwrap().path();
            if f.extension().is_some_and(|e| e == "json") {
                assert!(!std::fs::read_to_string(&f).unwrap().contains("\"genai-login\""), "{f:?}");
            }
        }
    }

    #[test]
    fn evaluate_default_mode() {
        let ev = |host: &str, path: &str| evaluate(&get(host, path), 5555, None);
        let good = format!("/sso-callback?token={JWT}");
        for h in ["localhost:5555", "127.0.0.1:5555", "[::1]:5555"] {
            assert_eq!(ev(h, &good), Verdict::Token(JWT.into()));
        }
        assert_eq!(ev("evil.com:5555", &good), Verdict::NotFound);
        assert_eq!(ev("localhost:5556", &good), Verdict::NotFound);
        for other in ["/", "/favicon.ico", "/cb/SEC/sso-callback?token=a.b.c", "/sso-callback/x?token=a.b.c", "/Sso-Callback?token=a.b.c", "//sso-callback?token=a.b.c"] {
            assert_eq!(ev("localhost:5555", other), Verdict::NotFound, "{other}");
        }
        assert_eq!(evaluate(&format!("POST {good} HTTP/1.1\r\nHost: localhost:5555\r\n\r\n"), 5555, None), Verdict::NotFound);
        assert_eq!(ev("localhost:5555", "/sso-callback"), Verdict::Bad("E_GENAI_NO_TOKEN"));
        assert_eq!(ev("localhost:5555", "/sso-callback?token=notajwt"), Verdict::Bad("E_GENAI_BAD_TOKEN"));
        assert_eq!(ev("localhost:5555", "/sso-callback?token=a%2Eb%2Ec"), Verdict::Token("a.b.c".into()));
    }

    #[tokio::test]
    async fn default_mode_connectid_is_port_only_and_secret_mode_is_opt_in() {
        let (tx, rx) = std::sync::mpsc::channel();
        let t2 = tx.clone();
        let e = run_flow(params(5), &allowed(), false, no_cancel(), move |u| {
            t2.send(u.to_string()).unwrap();
            Err(AppError::new("E_STOP", "x"))
        })
        .await
        .unwrap_err();
        assert_eq!(e.code, "E_STOP");
        let u = Url::parse(&rx.recv().unwrap()).unwrap();
        let cid = u.query_pairs().find(|(k, _)| k == "connectid").unwrap().1.into_owned();
        assert!(cid.parse::<u16>().is_ok(), "{cid}");
        let _ = run_flow(params(5), &allowed(), true, no_cancel(), move |u| {
            tx.send(u.to_string()).unwrap();
            Err(AppError::new("E_STOP", "x"))
        })
        .await;
        let u = Url::parse(&rx.recv().unwrap()).unwrap();
        let cid = u.query_pairs().find(|(k, _)| k == "connectid").unwrap().1.into_owned();
        assert!(cid.contains("/cb/") && cid.len() > 40, "{cid}");
    }

    #[tokio::test]
    async fn secret_mode_flow_success_and_default_prefix_rejected() {
        let r = flow_mode(true, |port, prefix| async move {
            assert!(prefix.starts_with("/cb/"));
            // the default-mode path is not accepted in secret mode
            assert!(raw("127.0.0.1", port, &get(&format!("localhost:{port}"), &format!("/sso-callback?token={JWT}"))).await.starts_with("HTTP/1.1 404"));
            let resp = raw("127.0.0.1", port, &get(&format!("localhost:{port}"), &format!("{prefix}/sso-callback?token={JWT}"))).await;
            assert!(resp.starts_with("HTTP/1.1 200"));
        })
        .await
        .unwrap();
        assert_eq!(r.token, JWT);
    }

    #[test]
    fn evaluate_rules() {
        let ok = |host: &str, path: &str| evaluate(&get(host, path), 5555, Some("SEC"));
        let good = format!("/cb/SEC/sso-callback?token={JWT}");
        assert_eq!(ok("localhost:5555", &good), Verdict::Token(JWT.into()));
        assert_eq!(ok("127.0.0.1:5555", &good), Verdict::Token(JWT.into()));
        assert_eq!(ok("[::1]:5555", &good), Verdict::Token(JWT.into()));
        assert_eq!(ok("evil.com:5555", &good), Verdict::NotFound);
        assert_eq!(ok("localhost:5556", &good), Verdict::NotFound);
        assert_eq!(ok("localhost", &good), Verdict::NotFound);
        assert_eq!(evaluate("GET / HTTP/1.1\r\n\r\n", 5555, Some("SEC")), Verdict::NotFound);
        assert_eq!(evaluate(&format!("GET {good} HTTP/1.1\r\nHost: localhost:5555\r\nHost: evil.com\r\n\r\n"), 5555, Some("SEC")), Verdict::NotFound);
        assert_eq!(ok("localhost:5555", &format!("/cb/WRONG/sso-callback?token={JWT}")), Verdict::NotFound);
        assert_eq!(ok("localhost:5555", &format!("/sso-callback?token={JWT}")), Verdict::NotFound);
        assert_eq!(ok("localhost:5555", &format!("/cb/SEC?token={JWT}")), Verdict::NotFound);
        assert_eq!(ok("localhost:5555", &format!("/cb/SEC/sso-callback/x?token={JWT}")), Verdict::NotFound);
        assert_eq!(evaluate(&format!("POST {good} HTTP/1.1\r\nHost: localhost:5555\r\n\r\n"), 5555, Some("SEC")), Verdict::NotFound);
        assert_eq!(ok("localhost:5555", "/cb/SEC/sso-callback"), Verdict::Bad("E_GENAI_NO_TOKEN"));
        assert_eq!(ok("localhost:5555", "/cb/SEC/sso-callback?token="), Verdict::Bad("E_GENAI_NO_TOKEN"));
        assert_eq!(ok("localhost:5555", "/cb/SEC/sso-callback?token=notajwt"), Verdict::Bad("E_GENAI_BAD_TOKEN"));
        assert_eq!(ok("localhost:5555", &format!("/cb/SEC/sso-callback?token=a.b.{}", "x".repeat(5000))), Verdict::Bad("E_GENAI_BAD_TOKEN"));
        // URL-decoded
        assert_eq!(ok("localhost:5555", "/cb/SEC/sso-callback?token=a%2Eb%2Ec"), Verdict::Token("a.b.c".into()));
    }

    #[tokio::test]
    async fn success_via_ipv4_with_stray_probes_and_no_reuse() {
        let _ = log::set_logger(&Cap).map(|_| log::set_max_level(log::LevelFilter::Trace));
        let r = flow_with(|port, secret| async move {
            // probes: wrong secret, missing path, wrong host: 404 and listener stays alive
            assert!(raw("127.0.0.1", port, &get(&format!("localhost:{port}"), &format!("/cb/nope/sso-callback?token={JWT}"))).await.starts_with("HTTP/1.1 404"));
            assert!(raw("127.0.0.1", port, &get(&format!("localhost:{port}"), "/favicon.ico")).await.starts_with("HTTP/1.1 404"));
            assert!(raw("127.0.0.1", port, &get("evil.com", &format!("{secret}/sso-callback?token={JWT}"))).await.starts_with("HTTP/1.1 404"));
            let big = format!("GET /{} HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n", "a".repeat(20_000));
            let _ = raw("127.0.0.1", port, &big).await; // oversized: dropped, still alive
            let resp = raw("127.0.0.1", port, &get(&format!("localhost:{port}"), &format!("{secret}/sso-callback?token={JWT}"))).await;
            assert!(resp.starts_with("HTTP/1.1 200"));
            assert!(resp.contains("Cache-Control: no-store") && resp.contains("Referrer-Policy: no-referrer"));
            assert!(resp.contains("Đăng nhập thành công"));
            assert!(!resp.contains(JWT));
            // second callback after success is refused (listener gone or 404)
            tokio::time::sleep(Duration::from_millis(100)).await;
            let again = TcpStream::connect(("127.0.0.1", port)).await;
            if let Ok(mut s) = again {
                let _ = s.write_all(get(&format!("localhost:{port}"), &format!("{secret}/sso-callback?token={JWT}")).as_bytes()).await;
                let mut o = String::new();
                let _ = s.read_to_string(&mut o).await;
                assert!(!o.starts_with("HTTP/1.1 200"));
            }
        })
        .await
        .unwrap();
        assert_eq!(r.token, JWT);
        tokio::time::sleep(Duration::from_millis(300)).await;
        // token and secret never reach the log
        for l in LOGS.lock().unwrap().iter() {
            assert!(!l.contains(JWT) && !l.contains("eyJ") && !l.contains("/cb/"), "{l}");
        }
    }

    #[tokio::test]
    async fn success_via_ipv6() {
        if !ipv6_available() {
            eprintln!("skipping: no IPv6 loopback");
            return;
        }
        let r = flow_with(|port, secret| async move {
            let resp = raw("[::1]", port, &get(&format!("[::1]:{port}"), &format!("{secret}/sso-callback?token={JWT}"))).await;
            assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
        })
        .await
        .unwrap();
        assert_eq!(r.token, JWT);
    }

    #[tokio::test]
    async fn missing_and_malformed_token_end_flow_with_failure_page() {
        let e = flow_with(|port, secret| async move {
            let resp = raw("127.0.0.1", port, &get(&format!("localhost:{port}"), &format!("{secret}/sso-callback"))).await;
            assert!(resp.starts_with("HTTP/1.1 400") && resp.contains("không thành công"));
        })
        .await
        .unwrap_err();
        assert_eq!(e.code, "E_GENAI_NO_TOKEN");
        let e = flow_with(|port, secret| async move {
            let _ = raw("127.0.0.1", port, &get(&format!("localhost:{port}"), &format!("{secret}/sso-callback?token=x"))).await;
        })
        .await
        .unwrap_err();
        assert_eq!(e.code, "E_GENAI_BAD_TOKEN");
    }

    #[tokio::test]
    async fn only_one_of_two_concurrent_valid_callbacks_wins() {
        let r = flow_with(|port, secret| async move {
            let p = format!("{secret}/sso-callback?token={JWT}");
            let req = get(&format!("localhost:{port}"), &p);
            let (a, b) = tokio::join!(raw("127.0.0.1", port, &req), raw("127.0.0.1", port, &req));
            assert_eq!([&a, &b].iter().filter(|x| x.starts_with("HTTP/1.1 200")).count(), 1);
        })
        .await;
        assert!(r.is_ok());
    }

    #[tokio::test]
    async fn rejects_bad_origin_before_binding_or_opening() {
        let mut p = params(30);
        p.login_url = "https://evil.com/create-jwt-token".into();
        let e = run_flow(p, &allowed(), false, no_cancel(), |_| panic!("must not open")).await.unwrap_err();
        assert_eq!(e.code, "E_GENAI_ORIGIN");
    }

    #[tokio::test]
    async fn opener_failure_cancel_and_timeout() {
        let e = run_flow(params(30), &allowed(), false, no_cancel(), |_| Err(AppError::new("E_OPEN", "no browser"))).await.unwrap_err();
        assert_eq!(e.code, "E_OPEN");
        let (tx, rx) = oneshot::channel();
        let h = tokio::spawn(async move { run_flow(params(30), &allowed(), false, rx, |_| Ok(())).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        tx.send(()).unwrap();
        assert_eq!(h.await.unwrap().unwrap_err().code, "E_GENAI_CANCELLED");
        tokio::time::pause();
        let h = tokio::spawn(async { run_flow(params(5), &allowed(), false, no_cancel(), |_| Ok(())).await });
        tokio::time::sleep(Duration::from_secs(6)).await;
        assert_eq!(h.await.unwrap().unwrap_err().code, "E_GENAI_TIMEOUT");
    }
}
