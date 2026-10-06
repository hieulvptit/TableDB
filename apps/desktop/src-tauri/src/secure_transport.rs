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
    let rng = SystemRandom::new();
    let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| error())?;
    let public = B64.encode(private.compute_public_key().map_err(|_| error())?.as_ref());
    let mut challenge = [0; 32];
    rng.fill(&mut challenge).map_err(|_| error())?;
    let challenge = B64.encode(challenge);
    let hello = serde_json::json!({"version":VERSION,"clientKind":"desktop","publicKey":public,"nonce":challenge});
    let response = client
        .post(format!("{base}/secure/handshake"))
        .header("Content-Type", "application/json")
        .body(hello.to_string())
        .send()
        .await
        .map_err(|_| error())?;
    if !response.status().is_success() {
        return Err(error());
    }
    let w: Welcome =
        serde_json::from_slice(&bounded(response, 8192).await?).map_err(|_| error())?;
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
        return Err(error());
    }
    let tr = format!(
        "{VERSION}|{}|desktop|{public}|{}|{challenge}|{}|{}",
        w.session_id, w.public_key, w.nonce, w.expires_at
    );
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, decode(pin)?)
        .verify(tr.as_bytes(), &decode(&w.signature)?)
        .map_err(|_| error())?;
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
    let response = client
        .post(format!("{base}/secure/request"))
        .header("Content-Type", CONTENT)
        .header("X-TableDB-Session", &w.session_id)
        .header("X-TableDB-Sequence", "1")
        .body(body)
        .send()
        .await
        .map_err(|_| error())?;
    if response.status() != 200
        || response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            != Some(CONTENT)
    {
        return Err(error());
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
