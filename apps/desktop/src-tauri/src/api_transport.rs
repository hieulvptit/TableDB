//! Transport for encrypted API envelopes only. URLs stay pinned in Rust; reads
//! are pulled by the renderer so large downloads retain backpressure.
use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Notify;

fn network_error() -> AppError {
    AppError::new("E_API_NETWORK", "API connection failed")
}

pub fn effective_proxy<'a>(base: &str, proxy: Option<&'a str>) -> Option<&'a str> {
    let local = url::Url::parse(base).ok().is_some_and(|u| match u.host() {
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    });
    if local {
        None
    } else {
        proxy.filter(|v| !v.trim().is_empty())
    }
}

pub fn client(base: &str, proxy: Option<&str>) -> Result<reqwest::Client, AppError> {
    static TLS: std::sync::Once = std::sync::Once::new();
    TLS.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    // Explicit configuration only: never inherit HTTP_PROXY or OS proxy settings.
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15));
    if let Some(proxy) = effective_proxy(base, proxy) {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy).map_err(|_| AppError::bad_request("invalid API proxy"))?,
        );
    }
    builder.build().map_err(|_| network_error())
}

struct Job {
    response: tokio::sync::Mutex<Option<reqwest::Response>>,
    cancel: Notify,
    touched: Mutex<Instant>,
}
#[derive(Default)]
pub struct ApiTransport {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    status: u16,
    content_type: String,
}

fn envelope(
    endpoint: &str,
    headers: &HashMap<String, String>,
    body: &str,
) -> Result<Vec<u8>, AppError> {
    if !matches!(endpoint, "handshake" | "request")
        || body.len() > 90 * 1024 * 1024
        || headers.len() > 3
    {
        return Err(AppError::bad_request("invalid API envelope"));
    }
    for (name, value) in headers {
        if !matches!(
            name.as_str(),
            "content-type" | "x-tabledb-session" | "x-tabledb-sequence"
        ) || value.len() > 128
            || value.chars().any(char::is_control)
        {
            return Err(AppError::bad_request("invalid API envelope header"));
        }
    }
    let bytes = B64
        .decode(body)
        .map_err(|_| AppError::bad_request("invalid API envelope body"))?;
    if bytes.len() > 64 * 1024 * 1024 + 64 * 1024 {
        return Err(AppError::bad_request("API envelope too large"));
    }
    let content_type = headers.get("content-type").map(String::as_str);
    if endpoint == "handshake" {
        if bytes.len() > 16 * 1024 || headers.len() != 1 || content_type != Some("application/json")
        {
            return Err(AppError::bad_request("invalid API handshake"));
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| AppError::bad_request("invalid API handshake"))?;
        if value.get("clientKind").and_then(|v| v.as_str()) != Some("desktop") {
            return Err(AppError::bad_request("invalid API client kind"));
        }
    } else if content_type != Some("application/vnd.tabledb.aesgcm") || headers.len() != 3 {
        return Err(AppError::bad_request("invalid encrypted API request"));
    }
    Ok(bytes)
}

impl ApiTransport {
    pub async fn start(
        &self,
        id: String,
        base: &str,
        proxy: Option<&str>,
        endpoint: &str,
        headers: HashMap<String, String>,
        body: String,
    ) -> Result<Head, AppError> {
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|v| v.is_ascii_alphanumeric() || v == b'-')
        {
            return Err(AppError::bad_request("invalid API request id"));
        }
        let bytes = envelope(endpoint, &headers, &body)?;
        let client = client(base, proxy)?;
        let job = Arc::new(Job {
            response: tokio::sync::Mutex::new(None),
            cancel: Notify::new(),
            touched: Mutex::new(Instant::now()),
        });
        {
            let mut jobs = self.jobs.lock().map_err(|_| network_error())?;
            jobs.retain(|_, v| {
                let active = v
                    .touched
                    .lock()
                    .map(|t| t.elapsed() < Duration::from_secs(120))
                    .unwrap_or(false);
                if !active {
                    v.cancel.notify_one();
                }
                active
            });
            if jobs.len() >= 16 || jobs.contains_key(&id) {
                return Err(AppError::bad_request("API request limit reached"));
            }
            jobs.insert(id.clone(), job.clone());
        }
        let base = base.trim_end_matches('/');
        let base = if base.ends_with("/api/v1") {
            base.to_string()
        } else {
            format!("{base}/api/v1")
        };
        let mut request = client.post(format!("{base}/secure/{endpoint}")).body(bytes);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let result = tokio::select! { biased;
            _ = job.cancel.notified() => Err(network_error()),
            result = tokio::time::timeout(Duration::from_secs(60), request.send()) => result.map_err(|_| network_error()).and_then(|v| v.map_err(|_| network_error())),
        };
        match result {
            Ok(response) => {
                let head = Head {
                    status: response.status().as_u16(),
                    content_type: response
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .into(),
                };
                *job.response.lock().await = Some(response);
                Ok(head)
            }
            Err(e) => {
                self.close(&id);
                Err(e)
            }
        }
    }
    pub async fn read(&self, id: &str) -> Result<Option<String>, AppError> {
        let job = self
            .jobs
            .lock()
            .map_err(|_| network_error())?
            .get(id)
            .cloned()
            .ok_or_else(network_error)?;
        if let Ok(mut t) = job.touched.lock() {
            *t = Instant::now();
        }
        let mut response = job.response.lock().await;
        let response = response.as_mut().ok_or_else(network_error)?;
        let chunk = tokio::select! { biased;
            _ = job.cancel.notified() => Err(network_error()),
            result = tokio::time::timeout(Duration::from_secs(60), response.chunk()) => result.map_err(|_| network_error()).and_then(|v| v.map_err(|_| network_error())),
        };
        match chunk {
            Ok(Some(bytes)) => Ok(Some(B64.encode(bytes))),
            Ok(None) => {
                self.close(id);
                Ok(None)
            }
            Err(e) => {
                self.close(id);
                Err(e)
            }
        }
    }
    pub fn close(&self, id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.remove(id) {
                job.cancel.notify_one();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_api_always_bypasses_proxy() {
        for base in [
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://127.1.2.3:8080",
            "http://[::1]:8080",
        ] {
            assert_eq!(effective_proxy(base, Some("http://proxy:3359")), None);
        }
        assert_eq!(effective_proxy("https://api.example", None), None);
        assert_eq!(
            effective_proxy("https://api.example", Some("http://proxy:3359")),
            Some("http://proxy:3359")
        );
    }
    #[test]
    fn accepts_only_desktop_envelopes() {
        let headers = HashMap::from([("content-type".into(), "application/json".into())]);
        assert!(envelope(
            "handshake",
            &headers,
            &B64.encode(br#"{"clientKind":"desktop"}"#)
        )
        .is_ok());
        assert!(envelope(
            "handshake",
            &headers,
            &B64.encode(br#"{"clientKind":"web"}"#)
        )
        .is_err());
        assert!(envelope("../auth/config", &headers, "").is_err());
        let mut bad = headers.clone();
        bad.insert("authorization".into(), "Bearer secret".into());
        assert!(envelope("handshake", &bad, "").is_err());
    }

    #[tokio::test]
    async fn local_http_streams_directly_even_with_an_unreachable_proxy() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let n = socket.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..n])
                .starts_with("POST /api/v1/secure/handshake "));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello").await.unwrap();
        });
        let transport = ApiTransport::default();
        let head = transport
            .start(
                "test-1".into(),
                &base,
                Some("http://127.0.0.1:9"),
                "handshake",
                HashMap::from([("content-type".into(), "application/json".into())]),
                B64.encode(br#"{"clientKind":"desktop"}"#),
            )
            .await
            .unwrap();
        assert_eq!(head.status, 200);
        let mut body = Vec::new();
        while let Some(chunk) = transport.read("test-1").await.unwrap() {
            body.extend(B64.decode(chunk).unwrap());
        }
        assert_eq!(body, b"hello");
        assert!(transport.jobs.lock().unwrap().is_empty());
        server.await.unwrap();
    }
}
