//! Pinned, authenticated AES transport for native configuration requests.
use crate::{agent_http::HttpRes, error::AppError};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::{
    agreement, hkdf,
    rand::{SecureRandom, SystemRandom},
    signature,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
const VERSION: &str = "tabledb-aes-v1";
const CONTENT: &str = "application/vnd.tabledb.aesgcm";
fn error() -> AppError {
    AppError::new("E_SECURE_TRANSPORT", "encrypted API validation failed")
}

fn stage_error(stage: &str, message: &str, request_id: &str) -> AppError {
    let mut error = AppError::new("E_SECURE_TRANSPORT", message);
    error.details = Some(serde_json::json!({"stage":stage,"requestId":request_id}));
    log::error!(
        "native secure API failed: stage={} request_id={} error={}",
        stage,
        request_id,
        message
    );
    error
}

fn network_failure(stage: &str, request_id: &str, error: reqwest::Error) -> AppError {
    let reason = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_builder() {
        "request_build"
    } else {
        "network"
    };
    let error = error.without_url();
    let mut causes = vec![error.to_string()];
    let mut source = std::error::Error::source(&error);
    for _ in 0..4 {
        let Some(cause) = source else { break };
        causes.push(cause.to_string());
        source = cause.source();
    }
    let message = format!(
        "{stage} {reason}: {}",
        crate::redact::redact(&causes.join(": "))
    );
    let mut result = AppError::new("E_CONFIG_NETWORK", &message).retryable(true);
    result.details =
        Some(serde_json::json!({"stage":stage,"requestId":request_id,"reason":reason}));
    log::error!(
        "native secure API network failed: stage={} request_id={} reason={} error={}",
        stage,
        request_id,
        reason,
        message
    );
    result
}
fn decode(v: &str) -> Result<Vec<u8>, AppError> {
    B64.decode(v).map_err(|_| error())
}
fn nonce(seq: u64, index: u32) -> [u8; 12] {
    let mut n = [0; 12];
    n[..8].copy_from_slice(&seq.to_be_bytes());
    n[8..].copy_from_slice(&index.to_be_bytes());
    n
}
fn aad(id: &str, seq: u64, index: u32, dir: &str) -> Vec<u8> {
    format!("{VERSION}|{id}|{seq}|{index}|{dir}").into_bytes()
}
struct Length;
impl hkdf::KeyType for Length {
    fn len(&self) -> usize {
        32
    }
}
fn derive(secret: &[u8], salt: &[u8], dir: &str) -> Result<Aes256Gcm, AppError> {
    let material = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(secret);
    let info = format!("{VERSION}|{dir}");
    let labels = [info.as_bytes()];
    let key = material.expand(&labels, Length).map_err(|_| error())?;
    let mut raw = [0; 32];
    key.fill(&mut raw).map_err(|_| error())?;
    let result = Aes256Gcm::new_from_slice(&raw).map_err(|_| error());
    raw.fill(0);
    result
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Welcome {
    version: String,
    session_id: String,
    public_key: String,
    nonce: String,
    expires_at: u64,
    signature: String,
    finished: String,
}
async fn bounded(mut r: reqwest::Response, max: usize) -> Result<Vec<u8>, AppError> {
    let mut data = Vec::new();
    while let Some(c) = r.chunk().await.map_err(|_| error())? {
        if data.len() + c.len() > max {
            return Err(error());
        }
        data.extend_from_slice(&c)
    }
    Ok(data)
}
fn append(
    out: &mut Vec<u8>,
    key: &Aes256Gcm,
    id: &str,
    index: u32,
    kind: u8,
    payload: &[u8],
) -> Result<(), AppError> {
    let mut plain = vec![kind];
    plain.extend_from_slice(payload);
    let n = nonce(1, index);
    let a = aad(id, 1, index, "c2s");
    let c = key
        .encrypt(
            Nonce::from_slice(&n),
            Payload {
                msg: &plain,
                aad: &a,
            },
        )
        .map_err(|_| error())?;
    out.extend_from_slice(&(c.len() as u32).to_be_bytes());
    out.extend_from_slice(&c);
    Ok(())
}
fn record(data: &mut &[u8], key: &Aes256Gcm, id: &str, index: u32) -> Result<Vec<u8>, AppError> {
    if data.len() < 4 {
        return Err(error());
    }
    let n = u32::from_be_bytes(data[..4].try_into().map_err(|_| error())?) as usize;
    *data = &data[4..];
    if !(17..=65536 + 1024).contains(&n) || data.len() < n {
        return Err(error());
    }
    let iv = nonce(1, index);
    let a = aad(id, 1, index, "s2c");
    let p = key
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &data[..n],
                aad: &a,
            },
        )
        .map_err(|_| error())?;
    *data = &data[n..];
    Ok(p)
}
pub async fn get(
    client: &reqwest::Client,
    base: &str,
    pin: &str,
    path: &str,
    token: Option<&str>,
) -> Result<HttpRes, AppError> {
    let signing_pin = decode(pin).map_err(|_| {
        stage_error(
            "trusted_key",
            "Desktop server public key is not valid base64",
            "",
        )
    })?;
    if signing_pin.len() != 65 || signing_pin.first() != Some(&4) {
        return Err(stage_error(
            "trusted_key",
            "Desktop server public key must be a P-256 public key",
            "",
        ));
    }
    let rng = SystemRandom::new();
    let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| error())?;
    let public = B64.encode(private.compute_public_key().map_err(|_| error())?.as_ref());
    let mut challenge = [0; 32];
    rng.fill(&mut challenge).map_err(|_| error())?;
    let challenge = B64.encode(challenge);
    let hello = serde_json::json!({"version":VERSION,"clientKind":"desktop","publicKey":public,"nonce":challenge});
    let handshake_id = format!("desktop-{:016x}", rand::random::<u64>());
    log::info!(
        "native secure API sending: stage=handshake request_id={} url={}/secure/handshake",
        handshake_id,
        crate::redact::redact(base)
    );
    let response = client
        .post(format!("{base}/secure/handshake"))
        .header("Content-Type", "application/json")
        .header("X-Request-ID", &handshake_id)
        .body(hello.to_string())
        .send()
        .await
        .map_err(|e| network_failure("handshake", &handshake_id, e))?;
    log::info!(
        "native secure API response: stage=handshake request_id={} status={}",
        handshake_id,
        response.status().as_u16()
    );
    if !response.status().is_success() {
        return Err(stage_error(
            "handshake_http",
            &format!("Handshake returned HTTP {}", response.status().as_u16()),
            &handshake_id,
        ));
    }
    let w: Welcome = serde_json::from_slice(&bounded(response, 8192).await?).map_err(|_| {
        stage_error(
            "handshake_response",
            "Handshake response is not valid protocol JSON",
            &handshake_id,
        )
    })?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| error())?
        .as_secs();
    if w.version != VERSION
        || w.session_id.len() != 32
        || !w
            .session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || w.expires_at <= now
        || w.expires_at > now + 3600
        || decode(&w.nonce)?.len() != 32
    {
        return Err(stage_error("handshake_metadata", "Invalid handshake metadata or session expiry; check desktop/server clocks and protocol versions", &handshake_id));
    }
    let tr = format!(
        "{VERSION}|{}|desktop|{public}|{}|{challenge}|{}|{}",
        w.session_id, w.public_key, w.nonce, w.expires_at
    );
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, signing_pin)
        .verify(tr.as_bytes(), &decode(&w.signature)?)
        .map_err(|_| stage_error("handshake_signature", "Server signature verification failed; check the trusted desktop public key matches the API desktop signing key", &handshake_id))?;
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, decode(&w.public_key)?);
    let mut secret =
        agreement::agree_ephemeral(private, &peer, |s| s.to_vec()).map_err(|_| error())?;
    let salt = Sha256::digest(tr.as_bytes());
    let send = derive(&secret, &salt, "c2s")?;
    let receive = derive(&secret, &salt, "s2c")?;
    secret.fill(0);
    let finished = receive
        .decrypt(
            Nonce::from_slice(&nonce(0, 0)),
            Payload {
                msg: &decode(&w.finished)?,
                aad: tr.as_bytes(),
            },
        )
        .map_err(|_| error())?;
    if finished != b"server-finished" {
        return Err(error());
    }
    let mut headers = serde_json::json!({"accept":"application/json"});
    if let Some(token) = token {
        headers["authorization"] = serde_json::json!(format!("Bearer {token}"))
    }
    let meta =
        serde_json::json!({"method":"GET","path":format!("/api/v1{path}"),"headers":headers});
    let mut body = Vec::new();
    append(
        &mut body,
        &send,
        &w.session_id,
        0,
        1,
        meta.to_string().as_bytes(),
    )?;
    append(&mut body, &send, &w.session_id, 1, 3, &[])?;
    let request_id = format!("desktop-{:016x}", rand::random::<u64>());
    log::info!(
        "native secure API sending: stage=request request_id={} url={}/secure/request",
        request_id,
        crate::redact::redact(base)
    );
    let response = client
        .post(format!("{base}/secure/request"))
        .header("Content-Type", CONTENT)
        .header("X-Request-ID", &request_id)
        .header("X-TableDB-Session", &w.session_id)
        .header("X-TableDB-Sequence", "1")
        .body(body)
        .send()
        .await
        .map_err(|e| network_failure("request", &request_id, e))?;
    log::info!(
        "native secure API response: stage=request request_id={} status={}",
        request_id,
        response.status().as_u16()
    );
    if response.status() != 200
        || response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            != Some(CONTENT)
    {
        return Err(stage_error(
            "request_http",
            &format!(
                "Encrypted request returned HTTP {} or an unexpected content type",
                response.status().as_u16()
            ),
            &request_id,
        ));
    }
    let wire = bounded(response, 160 * 1024).await?;
    let mut data = wire.as_slice();
    let first = record(&mut data, &receive, &w.session_id, 0)?;
    if first.first() != Some(&1) {
        return Err(error());
    }
    #[derive(Deserialize)]
    struct Meta {
        status: u16,
    }
    let meta: Meta = serde_json::from_slice(&first[1..]).map_err(|_| error())?;
    let mut body = Vec::new();
    let mut index = 1;
    loop {
        let p = record(&mut data, &receive, &w.session_id, index)?;
        index += 1;
        match p.first() {
            Some(2) if p.len() > 1 => {
                body.extend_from_slice(&p[1..]);
                if body.len() > 128 * 1024 {
                    return Err(error());
                }
            }
            Some(3) if p.len() == 1 && data.is_empty() => break,
            _ => return Err(error()),
        }
    }
    Ok(HttpRes {
        status: meta.status,
        content_type: "application/json".into(),
        session_id: None,
        body: String::from_utf8(body).map_err(|_| error())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalid_pin_is_reported_before_network_io() {
        let client = crate::api_transport::client("http://127.0.0.1:1", None).unwrap();
        let error = get(
            &client,
            "http://127.0.0.1:1/api/v1",
            "invalid-key",
            "/desktop/config",
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "E_SECURE_TRANSPORT");
        assert_eq!(error.details.unwrap()["stage"], "trusted_key");
    }

    #[tokio::test]
    async fn handshake_http_errors_have_status_and_request_id() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let n = socket.read(&mut request).await.unwrap();
            let text = String::from_utf8_lossy(&request[..n]).to_lowercase();
            assert!(text.starts_with("post /api/v1/secure/handshake "));
            assert!(text.contains("x-request-id: desktop-"));
            socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        });
        let base = format!("http://{address}/api/v1");
        let client = crate::api_transport::client(&base, None).unwrap();
        let pin = crate::config::AppConfig::default().server_signing_public_key;
        let error = get(&client, &base, &pin, "/desktop/config", None)
            .await
            .unwrap_err();
        assert!(error.message.contains("503"));
        let details = error.details.unwrap();
        assert_eq!(details["stage"], "handshake_http");
        assert!(details["requestId"]
            .as_str()
            .unwrap()
            .starts_with("desktop-"));
        server.await.unwrap();
    }
    #[tokio::test]
    #[ignore = "requires disposable Go cross-runtime fixture; see docs/SECURE-TRANSPORT.md"]
    async fn native_handshake_interoperability() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let base = std::env::var("TABLEDB_SECURE_TEST_URL").unwrap();
        let pin = std::env::var("TABLEDB_SECURE_TEST_DESKTOP_PIN").unwrap();
        let wrong = std::env::var("TABLEDB_SECURE_TEST_WEB_PIN").unwrap();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let r = get(&client, &base, &pin, "/desktop/config", None)
            .await
            .unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "{\"ok\":true}");
        assert!(get(&client, &base, &wrong, "/desktop/config", None)
            .await
            .is_err());
    }
}
