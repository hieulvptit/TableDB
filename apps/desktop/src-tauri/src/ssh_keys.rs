//! SSH private keys for DB tunnels.
//!
//! A key file picked in a native dialog (opened by Rust, never by the WebView) is copied into `<app_data_dir>/ssh-keys`
//! as `<id>.key`, described in that directory's `manifest.json`; the sidecar (`--ssh-keys <dir>`) reads it by id only.
//! Key bytes never go to the WebView or the logs; the SPA sees `{id, name, format, encrypted, addedAt}`.
//! Passphrases are not stored here (the SPA may keep one in the credential store, like DB passwords).

use crate::error::AppError;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};

pub const MAX_KEY_BYTES: u64 = 64 * 1024;
pub const MAX_KEYS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub id: String,
    pub name: String,
    /// "openssh" | "pem" | "putty"
    pub format: String,
    /// best-effort: needs a passphrase
    pub encrypted: bool,
    /// unix seconds
    pub added_at: u64,
}

/// `[A-Za-z0-9_-]{1,64}` (the sidecar's KEY_ID).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn new_id() -> String {
    format!("k{:016x}", rand::random::<u64>())
}

/// Recognise a private key and whether it is passphrase-protected. None = not a supported private key.
pub fn inspect(bytes: &[u8]) -> Option<(&'static str, bool)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with("PuTTY-User-Key-File-") {
        let enc = t.lines().find_map(|l| l.strip_prefix("Encryption:")).map(|v| v.trim() != "none").unwrap_or(true);
        return Some(("putty", enc));
    }
    if t.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        let body: String = t.lines().skip(1).take_while(|l| !l.starts_with("-----END")).collect::<Vec<_>>().concat();
        let raw = base64::engine::general_purpose::STANDARD.decode(body.trim()).ok()?;
        // "openssh-key-v1\0" + string ciphername
        let magic = b"openssh-key-v1\0";
        if !raw.starts_with(magic) || raw.len() < magic.len() + 4 {
            return None;
        }
        let n = u32::from_be_bytes(raw[magic.len()..magic.len() + 4].try_into().ok()?) as usize;
        let cipher = raw.get(magic.len() + 4..magic.len() + 4 + n)?;
        return Some(("openssh", cipher != b"none"));
    }
    let first = t.lines().next()?;
    if first.starts_with("-----BEGIN ") && first.contains("PRIVATE KEY-----") {
        let enc = first.contains("ENCRYPTED") || t.contains("Proc-Type: 4,ENCRYPTED");
        return Some(("pem", enc));
    }
    None
}

pub fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("manifest.json")
}

pub fn read_manifest(dir: &Path) -> Result<Vec<KeyEntry>, AppError> {
    let p = manifest_path(dir);
    if !p.exists() {
        return Ok(vec![]);
    }
    let txt = std::fs::read_to_string(&p).map_err(|_| AppError::new("E_INTERNAL", "cannot read SSH key list"))?;
    #[derive(Deserialize)]
    struct M {
        keys: Vec<KeyEntry>,
    }
    let m: M = serde_json::from_str(&txt).map_err(|_| AppError::new("E_INTERNAL", "SSH key list is malformed"))?;
    Ok(m.keys.into_iter().filter(|k| valid_id(&k.id)).collect())
}

fn write_manifest(dir: &Path, keys: &[KeyEntry]) -> Result<(), AppError> {
    let tmp = dir.join(format!("manifest.json.{:08x}.tmp", rand::random::<u32>()));
    let body = serde_json::to_vec_pretty(&json!({ "keys": keys })).map_err(|_| AppError::new("E_INTERNAL", "cannot serialize SSH key list"))?;
    let res = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, manifest_path(dir)));
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::new("E_INTERNAL", "cannot write SSH key list"));
    }
    Ok(())
}

/// Display name: 1-64 printable chars; defaults to the picked file's name.
pub fn clean_name(name: Option<&str>, src: &Path) -> Result<String, AppError> {
    let fallback = src.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "ssh-key".into());
    let n = name.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or(fallback);
    let n: String = n.chars().filter(|c| !c.is_control()).take(64).collect();
    if n.trim().is_empty() {
        return Err(AppError::bad_request("key name must be 1-64 characters"));
    }
    Ok(n)
}

fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    // Windows: files under the user's AppData inherit an ACL limited to that user (+SYSTEM/Administrators).
    #[cfg(not(unix))]
    let _ = path;
}

/// Validate and copy one private key file into `dir` as `<id>.key`; append the manifest entry.
pub fn import_file(dir: &Path, src: &Path, name: Option<&str>) -> Result<KeyEntry, AppError> {
    let md = std::fs::symlink_metadata(src).map_err(|_| AppError::bad_request("cannot read selected file"))?;
    if md.file_type().is_symlink() || !md.is_file() {
        return Err(AppError::bad_request("selected file is not a regular file"));
    }
    if md.len() == 0 || md.len() > MAX_KEY_BYTES {
        return Err(AppError::bad_request("an SSH private key file must be between 1 byte and 64 KB"));
    }
    let bytes = std::fs::read(src).map_err(|_| AppError::bad_request("cannot read selected file"))?;
    let Some((format, encrypted)) = inspect(&bytes) else {
        return Err(AppError::bad_request("not a supported SSH private key (OpenSSH, PEM or PuTTY .ppk); did you pick the .pub file?"));
    };
    std::fs::create_dir_all(dir).map_err(|_| AppError::new("E_INTERNAL", "cannot create SSH key directory"))?;
    let mut keys = read_manifest(dir)?;
    if keys.len() >= MAX_KEYS {
        return Err(AppError::bad_request("too many SSH keys; remove some first"));
    }
    let id = new_id();
    let dest = dir.join(format!("{id}.key"));
    std::fs::write(&dest, &bytes).map_err(|_| AppError::new("E_INTERNAL", "cannot store SSH key"))?;
    restrict(&dest);
    let added_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let entry = KeyEntry { id, name: clean_name(name, src)?, format: format.into(), encrypted, added_at };
    keys.push(entry.clone());
    if let Err(e) = write_manifest(dir, &keys) {
        let _ = std::fs::remove_file(&dest);
        return Err(e);
    }
    Ok(entry)
}

/// Removes the entry and its file. `id` is validated so it can never address other paths.
pub fn remove_key(dir: &Path, id: &str) -> Result<(), AppError> {
    if !valid_id(id) {
        return Err(AppError::bad_request("invalid SSH key id"));
    }
    let mut keys = read_manifest(dir)?;
    let Some(pos) = keys.iter().position(|k| k.id == id) else {
        return Err(AppError::new("E_NOT_FOUND", "SSH key not found"));
    };
    keys.remove(pos);
    write_manifest(dir, &keys)?;
    let _ = std::fs::remove_file(dir.join(format!("{id}.key")));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tdb-sk-{tag}-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn openssh(cipher: &str) -> String {
        let mut raw = b"openssh-key-v1\0".to_vec();
        raw.extend_from_slice(&(cipher.len() as u32).to_be_bytes());
        raw.extend_from_slice(cipher.as_bytes());
        raw.extend_from_slice(&[0u8; 16]);
        let b = base64::engine::general_purpose::STANDARD.encode(raw);
        format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{b}\n-----END OPENSSH PRIVATE KEY-----\n")
    }

    #[test]
    fn inspect_formats() {
        assert_eq!(inspect(openssh("none").as_bytes()), Some(("openssh", false)));
        assert_eq!(inspect(openssh("aes256-ctr").as_bytes()), Some(("openssh", true)));
        assert_eq!(inspect(b"-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nxx\n-----END RSA PRIVATE KEY-----\n"), Some(("pem", true)));
        assert_eq!(inspect(b"-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----\n"), Some(("pem", false)));
        assert_eq!(inspect(b"-----BEGIN ENCRYPTED PRIVATE KEY-----\nxx\n"), Some(("pem", true)));
        assert_eq!(inspect(b"PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n"), Some(("putty", false)));
        assert_eq!(inspect(b"PuTTY-User-Key-File-2: ssh-rsa\nEncryption: aes256-cbc\n"), Some(("putty", true)));
        assert_eq!(inspect(b"ssh-ed25519 AAAAC3Nza user@host\n"), None, "a public key is rejected");
        assert_eq!(inspect(b"-----BEGIN CERTIFICATE-----\n"), None);
        assert_eq!(inspect(&[0xff, 0xfe, 0x00]), None);
    }

    #[test]
    fn import_list_remove() {
        let src = tmp("src");
        let dir = tmp("dir");
        let f = src.join("id_ed25519");
        std::fs::write(&f, openssh("none")).unwrap();
        let e = import_file(&dir, &f, Some("  bastion key ")).unwrap();
        assert!(valid_id(&e.id));
        assert_eq!(e.name, "bastion key");
        assert!(!e.encrypted);
        assert!(dir.join(format!("{}.key", e.id)).is_file());
        assert_eq!(read_manifest(&dir).unwrap(), vec![e.clone()]);
        let e2 = import_file(&dir, &f, None).unwrap();
        assert_eq!(e2.name, "id_ed25519");
        remove_key(&dir, &e.id).unwrap();
        assert!(!dir.join(format!("{}.key", e.id)).exists());
        assert_eq!(read_manifest(&dir).unwrap().len(), 1);
        assert!(remove_key(&dir, &e.id).is_err());
        assert!(remove_key(&dir, "../manifest").is_err());
    }

    #[test]
    fn import_rejects_bad_sources() {
        let src = tmp("bad");
        let dir = tmp("bad-dir");
        let pubk = src.join("id.pub");
        std::fs::write(&pubk, "ssh-ed25519 AAAA x\n").unwrap();
        assert!(import_file(&dir, &pubk, None).is_err());
        let empty = src.join("empty");
        std::fs::write(&empty, "").unwrap();
        assert!(import_file(&dir, &empty, None).is_err());
        let big = src.join("big");
        std::fs::write(&big, vec![b'a'; (MAX_KEY_BYTES + 1) as usize]).unwrap();
        assert!(import_file(&dir, &big, None).is_err());
        assert!(import_file(&dir, &src.join("missing"), None).is_err());
        #[cfg(unix)]
        {
            let real = src.join("real");
            std::fs::write(&real, openssh("none")).unwrap();
            let link = src.join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(import_file(&dir, &link, None).is_err());
        }
        assert!(read_manifest(&dir).unwrap().is_empty());
    }
}
