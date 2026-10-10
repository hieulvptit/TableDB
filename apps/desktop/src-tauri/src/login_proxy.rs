//! Session-scoped CONNECT bridge: proxy credentials never enter browser arguments or remote requests.

use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::Path,
    process::{Child, Command},
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};
use url::Url;

pub const CREDENTIAL_KEY: &str = "proxy.sso.credentials";
pub const DEFAULT_PROXY_URL: &str = "http://10.23.5.189:3359";
pub const DEFAULT_PROXY_USERNAME: &str = "de_team";

/// Match a DNS suffix on a label boundary, including an optional trailing DNS dot.
pub fn direct_api_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "vnpayapi.vn" || host.ends_with(".vnpayapi.vn")
}

/// Password is supplied by the build environment, never by the WebView or public API.
pub fn default_proxy_password() -> &'static str {
    option_env!("TABLEDB_SSO_PROXY_PASSWORD").unwrap_or("")
}

/// Resolve the built-in DB proxy inside the native core; never expose its password to the WebView.
pub fn database_proxy_params(method: &str, mut params: serde_json::Value, password: &str) -> Result<serde_json::Value, AppError> {
    if matches!(method, "session.open" | "session.test") {
        if let Some(proxy) = params.pointer_mut("/profile/options/proxy") {
            if proxy.get("useDefault").and_then(serde_json::Value::as_bool) == Some(true) {
                if password.is_empty() {
                    return Err(AppError::new("E_PROXY_AUTH_REQUIRED", "Default database proxy password is missing from this desktop build"));
                }
                *proxy = serde_json::json!({"type":"http","host":"10.23.5.189","port":3359,"username":DEFAULT_PROXY_USERNAME,"password":password});
            } else if let Some(object) = proxy.as_object_mut() {
                object.remove("useDefault");
            }
        }
    }
    Ok(params)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedProxy {
    /// Missing preserves legacy credentials; an empty URL explicitly selects direct SSO.
    pub proxy_url: Option<String>,
    pub username: String,
    pub password: String,
}

impl SavedProxy {
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        let saved: Self = serde_json::from_str(raw)
            .map_err(|_| AppError::bad_request("invalid SSO proxy settings"))?;
        if let Some(url) = saved.proxy_url.as_deref() {
            if url.is_empty() { return Ok(saved); }
            validate_proxy(url)?;
            if url == DEFAULT_PROXY_URL && saved.username == DEFAULT_PROXY_USERNAME && saved.password.is_empty() {
                return Ok(saved);
            }
        }
        Credentials::parse(&serde_json::json!({"username": saved.username, "password": saved.password}).to_string())?;
        Ok(saved)
    }

    pub fn effective_url(&self, configured: Option<&str>) -> Option<String> {
        match self.proxy_url.as_deref() {
            Some("") => None,
            Some(url) => Some(url.to_string()),
            None => configured.map(str::to_string),
        }
    }
}

pub fn login_credentials(saved: Option<&SavedProxy>, upstream: &str, default_password: &str) -> Result<Credentials, AppError> {
    let (username, password) = match saved {
        Some(s) if !s.password.is_empty() => (s.username.as_str(), s.password.as_str()),
        _ if upstream == DEFAULT_PROXY_URL => (DEFAULT_PROXY_USERNAME, default_password),
        _ => return Err(AppError::new("E_PROXY_AUTH_REQUIRED", "save SSO proxy username and password first")),
    };
    Credentials::parse(&serde_json::json!({"username": username, "password": password}).to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyCheck {
    pub proxy_url: Option<String>,
    pub reachable: bool,
    pub latency_ms: Option<u64>,
}

/// TCP-only probe, equivalent to opening the proxy port with telnet. No credentials are read or sent.
pub async fn check_connectivity(raw: Option<&str>) -> Result<ProxyCheck, AppError> {
    let Some(raw) = raw else {
        return Ok(ProxyCheck {
            proxy_url: None,
            reachable: true,
            latency_ms: None,
        });
    };
    let proxy = validate_proxy(raw)?;
    let started = std::time::Instant::now();
    let reachable = matches!(
        tokio::time::timeout(
            Duration::from_secs(3),
            TcpStream::connect((
                proxy.host_str().unwrap(),
                proxy.port_or_known_default().unwrap(),
            ))
        )
        .await,
        Ok(Ok(_))
    );
    Ok(ProxyCheck {
        proxy_url: Some(raw.to_string()),
        reachable,
        latency_ms: reachable.then(|| started.elapsed().as_millis() as u64),
    })
}

/// Choose the SSO route before reading credentials or starting a bridge.
/// A configured proxy is required: never silently bypass it with a direct connection.
pub async fn reachable_login_proxy(raw: Option<&str>) -> Result<Option<&str>, AppError> {
    let check = check_connectivity(raw).await?;
    if check.reachable {
        Ok(raw)
    } else {
        Err(AppError::new("E_PROXY_UNREACHABLE", "cannot reach the configured SSO proxy").retryable(true))
    }
}

/// Verify that the proxy accepts the saved credentials and a tunnel to the SSO broker.
/// Only the CONNECT request carries credentials; no SSO token or page is requested.
pub async fn check_authentication(raw: &str, credentials: &Credentials) -> Result<u64, AppError> {
    let proxy = validate_proxy(raw)?;
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut stream = TcpStream::connect((proxy.host_str().unwrap(), proxy.port_or_known_default().unwrap()))
            .await.map_err(|_| AppError::new("E_PROXY_UNREACHABLE", "cannot reach SSO proxy"))?;
        let auth = STANDARD.encode(format!("{}:{}", credentials.username, credentials.password));
        stream.write_all(format!("CONNECT genai.vnpay.vn:443 HTTP/1.1\r\nHost: genai.vnpay.vn:443\r\nProxy-Authorization: Basic {auth}\r\n\r\n").as_bytes())
            .await.map_err(|_| AppError::new("E_PROXY_UNREACHABLE", "cannot send proxy check"))?;
        let response = read_header(&mut stream).await
            .map_err(|_| AppError::new("E_PROXY_TARGET", "invalid proxy response"))?;
        let mut status = std::str::from_utf8(&response).ok().and_then(|s| s.lines().next()).unwrap_or("").split_whitespace();
        if !matches!(status.next(), Some("HTTP/1.0" | "HTTP/1.1")) {
            return Err(AppError::new("E_PROXY_TARGET", "invalid proxy response"));
        }
        match status.next() {
            Some("200") => Ok(()),
            Some("407") => Err(AppError::new("E_PROXY_AUTH_FAILED", "proxy rejected credentials")),
            _ => Err(AppError::new("E_PROXY_TARGET", "proxy refused tunnel to SSO broker")),
        }
    }).await.map_err(|_| AppError::new("E_PROXY_UNREACHABLE", "proxy check timed out").retryable(true))?;
    result?;
    Ok(started.elapsed().as_millis() as u64)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

impl Credentials {
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        let c: Self = serde_json::from_str(raw).map_err(|_| {
            AppError::new("E_PROXY_AUTH_REQUIRED", "save SSO proxy credentials first")
        })?;
        if c.username.is_empty()
            || c.password.is_empty()
            || c.username.contains(':')
            || c.username.chars().any(char::is_control)
            || c.password.chars().any(char::is_control)
            || c.username.len() + c.password.len() > 800
        {
            return Err(AppError::new(
                "E_PROXY_AUTH_REQUIRED",
                "invalid SSO proxy credentials",
            ));
        }
        Ok(c)
    }
}

pub fn validate_proxy(raw: &str) -> Result<Url, AppError> {
    let u = Url::parse(raw).map_err(|_| AppError::bad_request("invalid SSO proxy URL"))?;
    if u.scheme() != "http"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
        || raw.chars().any(char::is_whitespace)
    {
        return Err(AppError::bad_request("SSO proxy must be http://host:port without credentials; save credentials in the login screen"));
    }
    Ok(u)
}

/// Any public DNS name on :443 is tunnelled; the upstream Squid enforces the real domain allowlist
/// (Google redirects across ccTLDs such as google.com.vn). IP literals and bare/local names stay blocked
/// so the bridge cannot be pointed at loopback or internal addresses.
fn allowed_host(host: &str, _broker_hosts: &[String]) -> bool {
    host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
        && host != "localhost"
        && !host.ends_with(".localhost")
        && host
            .rsplit('.')
            .next()
            .is_some_and(|tld| tld.bytes().any(|c| c.is_ascii_alphabetic()))
}

fn connect_target(header: &[u8], broker_hosts: &[String]) -> Option<String> {
    let text = std::str::from_utf8(header).ok()?;
    let mut parts = text.lines().next()?.split_whitespace();
    if parts.next()? != "CONNECT" {
        return None;
    }
    let authority = parts.next()?;
    if !matches!(parts.next()?, "HTTP/1.0" | "HTTP/1.1") || parts.next().is_some() {
        return None;
    }
    let host = authority.strip_suffix(":443")?.to_ascii_lowercase();
    if host.is_empty()
        || host.len() > 253
        || !host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
        || !allowed_host(&host, broker_hosts)
    {
        return None;
    }
    Some(format!("{host}:443"))
}

async fn read_header(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut bytes = Vec::new();
        while bytes.len() < 8192 {
            bytes.push(stream.read_u8().await?);
            if bytes.ends_with(b"\r\n\r\n") {
                return Ok(bytes);
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "proxy header too large",
        ))
    })
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "proxy header timeout"))?
}

async fn tunnel(
    mut client: TcpStream,
    upstream: &Url,
    auth: Option<&str>,
    hosts: &[String],
    extra_targets: &RwLock<HashSet<String>>,
) -> std::io::Result<()> {
    let header = read_header(&mut client).await?;
    let target = connect_target(&header, hosts).or_else(|| {
        let text = std::str::from_utf8(&header).ok()?;
        let mut parts = text.lines().next()?.split_whitespace();
        if parts.next()? != "CONNECT" { return None; }
        let authority = parts.next()?.to_ascii_lowercase();
        if !matches!(parts.next()?, "HTTP/1.0" | "HTTP/1.1") || parts.next().is_some() { return None; }
        extra_targets.read().ok()?.contains(&authority).then_some(authority)
    });
    let Some(target) = target else {
        log::warn!("network.connect rejected source=local_bridge status=403 request_line={:?}", crate::redact::redact(&String::from_utf8_lossy(&header).lines().next().unwrap_or("").chars().take(512).collect::<String>()));
        client
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    };
    let host = target.rsplit_once(':').map(|(h, _)| h).unwrap_or("");
    let direct = direct_api_host(host);
    // Only the validated destination is logged; credentials never go to direct targets.
    log::info!("network.connect request method=CONNECT url=https://{target}/ route={} proxy={}:{}", if direct { "direct" } else { "proxy" }, upstream.host_str().unwrap_or(""), upstream.port_or_known_default().unwrap_or(0));
    let started = std::time::Instant::now();
    let mut remote = match connect_remote(&target, direct, upstream, auth).await {
        Ok(remote) => remote,
        Err(error) => {
            log::warn!("network.connect failed url=https://{target}/ route={} elapsed_ms={} error_kind={:?} error={:?}", if direct { "direct" } else { "proxy" }, started.elapsed().as_millis(), error.kind(), error.to_string());
            client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
            return Err(error);
        }
    };
    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?;
    log::info!("network.connect established url=https://{target}/ route={} peer={:?} elapsed_ms={}", if direct { "direct" } else { "proxy" }, remote.peer_addr().ok(), started.elapsed().as_millis());
    let database_route = !extra_targets.read().unwrap().is_empty();
    if database_route {
        // JDBC may reuse a keep-alive socket for many queries. Its owning session closes the bridge.
        let _ = tokio::io::copy_bidirectional(&mut client, &mut remote).await;
    } else {
        let _ = tokio::time::timeout(Duration::from_secs(600), tokio::io::copy_bidirectional(&mut client, &mut remote)).await;
    }
    Ok(())
}

async fn connect_remote(target: &str, direct: bool, upstream: &Url, auth: Option<&str>) -> std::io::Result<TcpStream> {
    if direct {
        return tokio::time::timeout(Duration::from_secs(15), TcpStream::connect(target)).await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "stage=destination_tcp direct destination timeout"))?;
    }
    let mut remote = tokio::time::timeout(
        Duration::from_secs(15),
        TcpStream::connect((
            upstream.host_str().unwrap(),
            upstream.port_or_known_default().unwrap(),
        )),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "stage=proxy_tcp upstream proxy timeout"))??;
    let auth_header = auth
        .map(|a| format!("Proxy-Authorization: Basic {a}\r\n"))
        .unwrap_or_default();
    remote
        .write_all(
            format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n{auth_header}\r\n").as_bytes(),
        )
        .await?;
    let response = read_header(&mut remote).await?;
    let status = std::str::from_utf8(&response)
        .ok()
        .and_then(|s| s.lines().next())
        .and_then(|s| s.split_whitespace().nth(1))
        .unwrap_or("");
    let response_text = String::from_utf8_lossy(&response);
    let safe_headers: Vec<&str> = response_text.lines().skip(1).filter(|line| {
        let name = line.split(':').next().unwrap_or("");
        ["server", "via", "x-squid-error", "content-type", "content-length"].iter().any(|allowed| name.eq_ignore_ascii_case(allowed))
    }).collect();
    log::info!("network.connect response source=upstream_proxy url=https://{target}/ proxy={}:{} status={} headers={:?}",
        upstream.host_str().unwrap_or(""), upstream.port_or_known_default().unwrap_or(0), status, safe_headers);
    if status != "200" {
        log::warn!(
            "SSO proxy refused CONNECT to {target} (status {})",
            status.parse::<u16>().unwrap_or(0)
        );
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, format!("stage=proxy_connect upstream CONNECT status {status} destination={target}")));
    }
    Ok(remote)
}

pub struct LoginProxy {
    pub url: Url,
    task: JoinHandle<()>,
    extra_targets: Arc<RwLock<HashSet<String>>>,
}

impl LoginProxy {
    pub async fn start(
        upstream: Url,
        credentials: Option<Credentials>,
        origins: &[String],
    ) -> Result<Self, AppError> {
        let hosts: Vec<String> = origins
            .iter()
            .filter_map(|s| Url::parse(s).ok()?.host_str().map(str::to_string))
            .collect();
        let auth = credentials.map(|c| STANDARD.encode(format!("{}:{}", c.username, c.password)));
        let extra_targets = Arc::new(RwLock::new(HashSet::new()));
        let task_targets = extra_targets.clone();
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| AppError::new("E_PROXY_LISTEN", "cannot start SSO proxy bridge"))?;
        let url = Url::parse(&format!(
            "http://{}",
            listener
                .local_addr()
                .map_err(|_| AppError::new("E_PROXY_LISTEN", "no proxy address"))?
        ))
        .unwrap();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((client, _)) = accepted else { break; };
                        if connections.len() >= 64 { continue; }
                        let (upstream, auth, hosts, targets) = (upstream.clone(), auth.clone(), hosts.clone(), task_targets.clone());
                        connections.spawn(async move {
                            if let Err(error) = tunnel(client, &upstream, auth.as_deref(), &hosts, &targets).await {
                                log::warn!("SSO connection failed: {error}");
                            }
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Self { url, task, extra_targets })
    }

    /// Allow the explicitly configured Trino coordinator, including a non-default TLS port.
    pub fn allow_coordinator(&self, host: &str, port: u16) -> Result<(), AppError> {
        let url = Url::parse(&format!("https://{host}:{port}/")).map_err(|_| AppError::bad_request("invalid Trino coordinator"))?;
        if port == 0 || !url.username().is_empty() || url.password().is_some() || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
            return Err(AppError::bad_request("invalid Trino coordinator"));
        }
        self.extra_targets.write().unwrap().insert(format!("{}:{port}", host.to_ascii_lowercase()));
        Ok(())
    }
}

impl Drop for LoginProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A dedicated browser process/profile avoids changing the user's normal browser proxy settings.
pub struct LoginBrowser(Child);
impl LoginBrowser {
    pub fn running(&mut self) -> bool { matches!(self.0.try_wait(), Ok(None)) }
}
impl Drop for LoginBrowser {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn browser_proxy_server(proxy: &Url) -> Result<String, AppError> {
    // Chromium expects a proxy authority, not a URL path. Url::as_str()
    // adds a trailing slash, which makes --proxy-server invalid.
    let proxy = validate_proxy(proxy.as_str())?;
    Ok(format!(
        "http://{}:{}",
        proxy.host_str().unwrap(),
        proxy.port_or_known_default().unwrap()
    ))
}

pub fn open_browser(
    url: &str,
    proxy: &Url,
    profile: &Path,
    persist: bool,
) -> Result<LoginBrowser, AppError> {
    let proxy_server = browser_proxy_server(proxy)?;
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    candidates.extend([
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".to_string(),
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".to_string(),
    ]);
    #[cfg(windows)]
    for root in ["PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(root) {
            for relative in [
                "Microsoft/Edge/Application/msedge.exe",
                "Google/Chrome/Application/chrome.exe",
            ] {
                candidates.push(
                    std::path::PathBuf::from(&root)
                        .join(relative)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    #[cfg(target_os = "linux")]
    candidates.extend(
        [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
        ]
        .map(str::to_string),
    );
    std::fs::create_dir_all(profile)
        .map_err(|_| AppError::new("E_OPEN_URL", "cannot create SSO browser profile"))?;
    for candidate in candidates {
        let mut command = Command::new(candidate);
        command
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg(format!("--proxy-server={proxy_server}"))
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-quic",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if !persist {
            command.arg("--incognito");
        }
        // App mode gives SSO its own popup without the normal browser tabs/toolbars.
        if let Ok(child) = command.arg(format!("--app={url}")).spawn() {
            return Ok(LoginBrowser(child));
        }
    }
    Err(AppError::new(
        "E_OPEN_URL",
        "install Chrome or Edge to use SSO through the app proxy",
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn vnpay_api_suffix_is_direct_only_on_dns_label_boundaries() {
        for host in ["vnpayapi.vn", "query-engine-staging.vnpayapi.vn", "GENAI.VNPAYAPI.VN."] { assert!(direct_api_host(host)); }
        for host in ["s2o.vnpay.vn", "accounts.google.com", "vnpayapi.vn.evil.com", "evilvnpayapi.vn"] { assert!(!direct_api_host(host)); }
    }

    #[tokio::test]
    async fn direct_connection_never_sends_connect_or_proxy_credentials() {
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = origin.local_addr().unwrap().to_string();
        let proxy_url = Url::parse(&format!("http://{}", proxy.local_addr().unwrap())).unwrap();
        let mut remote = connect_remote(&target, true, &proxy_url, Some("private-proxy-auth")).await.unwrap();
        let (mut received, _) = origin.accept().await.unwrap();
        remote.write_all(b"TLS_PAYLOAD").await.unwrap();
        let mut data = [0; 11];
        received.read_exact(&mut data).await.unwrap();
        assert_eq!(&data, b"TLS_PAYLOAD");
        assert!(tokio::time::timeout(Duration::from_millis(100), proxy.accept()).await.is_err());
    }
    #[tokio::test]
    async fn proxy_denial_identifies_stage_destination_and_status() {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", proxy.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = proxy.accept().await.unwrap();
            let request = read_header(&mut socket).await.unwrap();
            assert!(String::from_utf8_lossy(&request).starts_with("CONNECT accounts.google.com:443 "));
            socket.write_all(b"HTTP/1.1 403 Forbidden\r\nX-Squid-Error: ERR_ACCESS_DENIED 0\r\nContent-Length: 0\r\n\r\n").await.unwrap();
        });
        let error = connect_remote("accounts.google.com:443", false, &url, None).await.unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("stage=proxy_connect"));
        assert!(error.to_string().contains("403"));
        assert!(error.to_string().contains("accounts.google.com:443"));
        server.await.unwrap();
    }

    #[test]
    fn database_default_proxy_is_resolved_only_in_native_session_requests() {
        let params = serde_json::json!({"profile":{"options":{"proxy":{"useDefault":true,"host":"other-host","password":"webview-password"}}}});
        for method in ["session.open", "session.test"] {
            let resolved = database_proxy_params(method, params.clone(), "native-password").unwrap();
            assert_eq!(resolved.pointer("/profile/options/proxy/host").unwrap(), "10.23.5.189");
            assert_eq!(resolved.pointer("/profile/options/proxy/username").unwrap(), "de_team");
            assert_eq!(resolved.pointer("/profile/options/proxy/password").unwrap(), "native-password");
            assert!(resolved.pointer("/profile/options/proxy/useDefault").is_none());
            assert_eq!(database_proxy_params(method, params.clone(), "").unwrap_err().code, "E_PROXY_AUTH_REQUIRED");
        }
        assert_eq!(database_proxy_params("query.execute", params.clone(), "native-password").unwrap(), params);
    }
    use super::*;

    #[test]
    fn chromium_proxy_uses_authority_without_url_path() {
        for (raw, expected) in [
            ("http://127.0.0.1:49704", "http://127.0.0.1:49704"),
            ("http://127.0.0.1:49704/", "http://127.0.0.1:49704"),
            ("http://proxy.local", "http://proxy.local:80"),
            ("http://[::1]:3359/", "http://[::1]:3359"),
        ] {
            assert_eq!(
                browser_proxy_server(&Url::parse(raw).unwrap()).unwrap(),
                expected
            );
        }
        for raw in [
            "http://user:password@proxy:3359",
            "http://proxy:3359/path",
            "socks5://proxy:1080",
        ] {
            assert!(browser_proxy_server(&Url::parse(raw).unwrap()).is_err());
        }
    }

    #[tokio::test]
    async fn authenticated_check_distinguishes_success_auth_and_target_errors() {
        for (response, expected) in [
            ("HTTP/1.1 200 Connection Established\r\n\r\n", None),
            ("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n", Some("E_PROXY_AUTH_FAILED")),
            ("HTTP/1.1 403 Forbidden\r\n\r\n", Some("E_PROXY_TARGET")),
            ("HTTP/1.1 502 Bad Gateway\r\n\r\n", Some("E_PROXY_TARGET")),
            ("garbage 200 OK\r\n\r\n", Some("E_PROXY_TARGET")),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = String::from_utf8(read_header(&mut stream).await.unwrap()).unwrap();
                assert!(request.starts_with("CONNECT genai.vnpay.vn:443 HTTP/1.1\r\n"));
                assert!(request.contains(&format!("Proxy-Authorization: Basic {}\r\n", STANDARD.encode("check-user:check-password"))));
                stream.write_all(response.as_bytes()).await.unwrap();
                let mut byte = [0];
                assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
            });
            let credentials = Credentials::parse(r#"{"username":"check-user","password":"check-password"}"#).unwrap();
            let result = check_authentication(&url, &credentials).await;
            assert_eq!(result.err().map(|e| e.code), expected.map(str::to_string));
            server.await.unwrap();
            // A closed TCP port remains a network error, not an authentication error.
            assert_eq!(check_authentication(&url, &credentials).await.unwrap_err().code, "E_PROXY_UNREACHABLE");
        }
    }

    #[test]
    fn default_credentials_are_scoped_to_default_proxy() {
        let c = login_credentials(None, DEFAULT_PROXY_URL, "test-build-password").unwrap();
        assert_eq!(c.username, DEFAULT_PROXY_USERNAME);
        assert_eq!(c.password, "test-build-password");
        assert!(login_credentials(None, "http://other-proxy:3359", "test-build-password").is_err());
        assert!(login_credentials(None, DEFAULT_PROXY_URL, "").is_err());
    }

    #[test]
    fn custom_and_legacy_proxy_settings_override_defaults() {
        let custom = SavedProxy::parse(r#"{"proxyUrl":"http://custom:3128","username":"custom-user","password":"custom-password"}"#).unwrap();
        assert_eq!(custom.effective_url(Some(DEFAULT_PROXY_URL)).as_deref(), Some("http://custom:3128"));
        let c = login_credentials(Some(&custom), "http://custom:3128", "default-password").unwrap();
        assert_eq!(c.username, "custom-user");
        assert_eq!(c.password, "custom-password");
        let legacy = SavedProxy::parse(r#"{"username":"legacy-user","password":"legacy-password"}"#).unwrap();
        assert_eq!(legacy.effective_url(Some(DEFAULT_PROXY_URL)).as_deref(), Some(DEFAULT_PROXY_URL));
        assert_eq!(login_credentials(Some(&legacy), DEFAULT_PROXY_URL, "default-password").unwrap().username, "legacy-user");
        let direct = SavedProxy::parse(r#"{"proxyUrl":"","username":"","password":""}"#).unwrap();
        assert!(direct.effective_url(Some(DEFAULT_PROXY_URL)).is_none());
        for url in ["https://custom:3128", "http://user:password@custom:3128", "http://custom:3128/path"] {
            assert!(SavedProxy::parse(&serde_json::json!({"proxyUrl":url,"username":"u","password":"p"}).to_string()).is_err());
        }
        assert!(SavedProxy::parse(r#"{"proxyUrl":"http://custom:3128","username":"u","password":""}"#).is_err());
        let default = SavedProxy::parse(&serde_json::json!({"proxyUrl":DEFAULT_PROXY_URL,"username":DEFAULT_PROXY_USERNAME,"password":""}).to_string()).unwrap();
        assert_eq!(login_credentials(Some(&default), DEFAULT_PROXY_URL, "build-password").unwrap().password, "build-password");
    }

    #[tokio::test]
    async fn tcp_probe_reports_open_closed_and_unconfigured_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let check = check_connectivity(Some(&url)).await.unwrap();
        assert!(check.reachable);
        assert!(check.latency_ms.is_some());
        let (mut connection, _) = listener.accept().await.unwrap();
        let mut byte = [0];
        assert_eq!(connection.read(&mut byte).await.unwrap(), 0); // Probe sent no authentication or payload.
        drop(listener);
        let check = check_connectivity(Some(&url)).await.unwrap();
        assert!(!check.reachable);
        assert!(check.latency_ms.is_none());
        assert!(check_connectivity(None).await.unwrap().proxy_url.is_none());
    }

    #[tokio::test]
    async fn login_route_requires_configured_proxy_and_allows_explicit_direct() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        assert_eq!(reachable_login_proxy(Some(&url)).await.unwrap(), Some(url.as_str()));
        drop(listener);
        let error = reachable_login_proxy(Some(&url)).await.unwrap_err();
        assert_eq!(error.code, "E_PROXY_UNREACHABLE");
        assert!(error.retryable);
        assert_eq!(reachable_login_proxy(None).await.unwrap(), None);
    }

    #[test]
    fn allows_dns_redirects_and_blocks_local_targets_and_non_tls_ports() {
        let hosts = vec!["genai.vnpay.vn".to_string()];
        for target in [
            "sso.vnpay.vn:443",
            "s2o.vnpay.vn:443",
            "genai.vnpay.vn:443",
            "accounts.google.com:443",
            "ssl.gstatic.com:443",
            "www.google.com.vn:443",
            "example.com:443",
            "sub.s2o.vnpay.vn:443",
        ] {
            assert!(connect_target(
                format!("CONNECT {target} HTTP/1.1\r\n\r\n").as_bytes(),
                &hosts
            )
            .is_some());
        }
        for target in [
            "127.0.0.1:443",
            "10.23.5.40:8080",
            "10.23.5.40:443",
            "[::1]:443",
            "localhost:443",
            "app.localhost:443",
            "intranet:443",
            ".google.com:443",
            "google.com.:443",
            "google..com:443",
            "s2o.vnpay.vn:80",
            "accounts.google.com:80",
        ] {
            assert!(connect_target(
                format!("CONNECT {target} HTTP/1.1\r\n\r\n").as_bytes(),
                &hosts
            )
            .is_none());
        }
        assert!(validate_proxy("http://user:secret@proxy:3359").is_err());
    }

    #[tokio::test]
    async fn redirect_hosts_use_same_authenticated_proxy_session() {
        let targets = [
            "genai.vnpay.vn:443",
            "s2o.vnpay.vn:443",
            "accounts.google.com:443",
            "ssl.gstatic.com:443",
            "lh3.googleusercontent.com:443",
            "s2o.vnpay.vn:443",
            "genai.vnpay.vn:443",
            "trino.internal:8443",
        ];
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url =
            Url::parse(&format!("http://{}", upstream.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            for target in targets {
                let (mut stream, _) = upstream.accept().await.unwrap();
                let request = String::from_utf8(read_header(&mut stream).await.unwrap()).unwrap();
                assert!(request.starts_with(&format!("CONNECT {target} HTTP/1.1\r\n")));
                assert!(request.contains(&format!(
                    "Proxy-Authorization: Basic {}\r\n",
                    STANDARD.encode("test-user:test-pass")
                )));
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\n\r\nSERVER")
                    .await
                    .unwrap();
                let mut data = [0; 6];
                stream.read_exact(&mut data).await.unwrap();
                assert_eq!(&data, b"CLIENT");
            }
        });
        let bridge = LoginProxy::start(
            upstream_url,
            Some(Credentials::parse(r#"{"username":"test-user","password":"test-pass"}"#).unwrap()),
            &[],
        )
        .await
        .unwrap();
        bridge.allow_coordinator("trino.internal", 8443).unwrap();
        for target in targets {
            let mut client = TcpStream::connect(("127.0.0.1", bridge.url.port().unwrap()))
                .await
                .unwrap();
            client
                .write_all(format!("CONNECT {target} HTTP/1.1\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let response = read_header(&mut client).await.unwrap();
            assert!(response.starts_with(b"HTTP/1.1 200 Connection Established\r\n"));
            assert!(!String::from_utf8(response).unwrap().contains("Proxy-Authorization"));
            client.write_all(b"CLIENT").await.unwrap();
            let mut data = [0; 6];
            client.read_exact(&mut data).await.unwrap();
            assert_eq!(&data, b"SERVER");
        }
        server.await.unwrap();
        let port = bridge.url.port().unwrap();
        drop(bridge);
        tokio::task::yield_now().await;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }
}
