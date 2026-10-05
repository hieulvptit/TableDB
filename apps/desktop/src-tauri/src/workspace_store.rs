//! Encrypted editor workspace (SQL tabs, query history, snippets) in app data.
//!
//! One file `<app_data_dir>/workspace.bin` = MAGIC | 12-byte nonce | AES-256-GCM(ciphertext + tag), with MAGIC as
//! associated data. A fresh random nonce is used for every write; the file is replaced atomically (temp + rename).
//! The 256-bit key is random, created on first save and kept in the OS credential store under a reserved name that
//! the WebView's `secret_*` commands cannot read. Deleting the key makes every copy of the file (backups included)
//! unreadable. Contents are never logged.

use crate::error::AppError;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use std::path::{Path, PathBuf};

pub const MAGIC: &[u8; 5] = b"TDBW1";
/// Credential-store key of the workspace key (the `internal:` prefix is refused by the secret_* commands).
pub const KEY_NAME: &str = "internal:workspace.key";
pub const MAX_PLAINTEXT: usize = 16 * 1024 * 1024;
const NONCE_LEN: usize = 12;

/// Where the key lives (the OS credential store in the app; in memory in tests).
pub trait KeySource: Send + Sync {
    fn get(&self) -> Result<Option<String>, AppError>;
    fn set(&self, b64: &str) -> Result<(), AppError>;
    fn delete(&self) -> Result<(), AppError>;
}

pub struct VaultKey(pub std::sync::Arc<crate::secrets::Vault>);
impl KeySource for VaultKey {
    fn get(&self) -> Result<Option<String>, AppError> { self.0.get(KEY_NAME) }
    fn set(&self, b64: &str) -> Result<(), AppError> { self.0.set(KEY_NAME, b64) }
    fn delete(&self) -> Result<(), AppError> { self.0.delete(KEY_NAME) }
}

pub struct WorkspaceStore {
    path: PathBuf,
    keys: Box<dyn KeySource>,
    lock: std::sync::Mutex<()>,
}

fn decode_key(b64: &str) -> Result<[u8; 32], AppError> {
    let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|_| AppError::new("E_WORKSPACE_KEY", "workspace key is invalid"))?;
    raw.try_into().map_err(|_| AppError::new("E_WORKSPACE_KEY", "workspace key is invalid"))
}

pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| AppError::new("E_INTERNAL", "cipher init failed"))?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: MAGIC })
        .map_err(|_| AppError::new("E_INTERNAL", "encryption failed"))?;
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Fails (never returns garbage) on a wrong key, a modified file or another format.
pub fn decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, AppError> {
    let unreadable = || AppError::new("E_WORKSPACE_UNREADABLE", "workspace file cannot be decrypted");
    if data.len() < MAGIC.len() + NONCE_LEN + 16 || &data[..MAGIC.len()] != MAGIC {
        return Err(unreadable());
    }
    let (nonce, ct) = data[MAGIC.len()..].split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| AppError::new("E_INTERNAL", "cipher init failed"))?;
    cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: MAGIC }).map_err(|_| unreadable())
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), AppError> {
    let io = |_| AppError::new("E_WORKSPACE_IO", "cannot write workspace file");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, data).map_err(io)?;
    // std::fs::rename replaces an existing target on Windows (MoveFileExW + MOVEFILE_REPLACE_EXISTING) and Unix
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e)
    })
}

impl WorkspaceStore {
    pub fn new(path: PathBuf, keys: Box<dyn KeySource>) -> Self {
        WorkspaceStore { path, keys, lock: std::sync::Mutex::new(()) }
    }

    /// The stored JSON document; None when nothing was saved yet. A file that cannot be decrypted (key lost,
    /// tampered) is an error: the caller starts empty and the next save replaces it.
    pub fn load(&self) -> Result<Option<String>, AppError> {
        let _g = self.lock.lock().map_err(|_| AppError::new("E_INTERNAL", "workspace lock poisoned"))?;
        let data = match std::fs::read(&self.path) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(AppError::new("E_WORKSPACE_IO", "cannot read workspace file")),
        };
        let Some(k) = self.keys.get()? else {
            return Err(AppError::new("E_WORKSPACE_UNREADABLE", "workspace key is missing"));
        };
        let plain = decrypt(&decode_key(&k)?, &data)?;
        String::from_utf8(plain).map(Some).map_err(|_| AppError::new("E_WORKSPACE_UNREADABLE", "workspace file is not text"))
    }

    pub fn save(&self, json: &str) -> Result<(), AppError> {
        if json.len() > MAX_PLAINTEXT {
            return Err(AppError::new("E_LIMIT", "workspace too large"));
        }
        let _g = self.lock.lock().map_err(|_| AppError::new("E_INTERNAL", "workspace lock poisoned"))?;
        let key = match self.keys.get()? {
            Some(k) => decode_key(&k)?,
            None => {
                let mut k = [0u8; 32];
                rand::rngs::OsRng.fill_bytes(&mut k);
                self.keys.set(&base64::engine::general_purpose::STANDARD.encode(k))?;
                k
            }
        };
        write_atomic(&self.path, &encrypt(&key, json.as_bytes())?)
    }

    /// Removes the file and the key (old copies of the file can no longer be decrypted).
    pub fn clear(&self) -> Result<(), AppError> {
        let _g = self.lock.lock().map_err(|_| AppError::new("E_INTERNAL", "workspace lock poisoned"))?;
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(AppError::new("E_WORKSPACE_IO", "cannot delete workspace file")),
        }
        self.keys.delete()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default, Clone)]
    struct MemKey(Arc<Mutex<Option<String>>>);
    impl KeySource for MemKey {
        fn get(&self) -> Result<Option<String>, AppError> { Ok(self.0.lock().unwrap().clone()) }
        fn set(&self, b64: &str) -> Result<(), AppError> { *self.0.lock().unwrap() = Some(b64.into()); Ok(()) }
        fn delete(&self) -> Result<(), AppError> { *self.0.lock().unwrap() = None; Ok(()) }
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tdbw-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trip_and_file_is_not_plaintext() {
        let dir = tmpdir("rt");
        let keys = MemKey::default();
        let s = WorkspaceStore::new(dir.join("workspace.bin"), Box::new(keys.clone()));
        assert_eq!(s.load().unwrap(), None);
        let doc = r#"{"history":[{"sql":"SELECT * FROM cards WHERE pan = '4111111111111111'"}]}"#;
        s.save(doc).unwrap();
        assert!(keys.0.lock().unwrap().is_some(), "key created on first save");
        let raw = std::fs::read(dir.join("workspace.bin")).unwrap();
        assert!(raw.starts_with(MAGIC));
        assert!(!String::from_utf8_lossy(&raw).contains("4111"));
        assert!(!String::from_utf8_lossy(&raw).contains("SELECT"));
        assert_eq!(s.load().unwrap().as_deref(), Some(doc));
        // a new nonce per write: same plaintext, different file
        s.save(doc).unwrap();
        assert_ne!(std::fs::read(dir.join("workspace.bin")).unwrap(), raw);
        assert!(!dir.join("workspace.bin.tmp").exists());
    }

    #[test]
    fn tampering_wrong_key_and_missing_key_fail_closed() {
        let dir = tmpdir("tamper");
        let keys = MemKey::default();
        let s = WorkspaceStore::new(dir.join("workspace.bin"), Box::new(keys.clone()));
        s.save("{\"a\":1}").unwrap();
        let mut raw = std::fs::read(dir.join("workspace.bin")).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        std::fs::write(dir.join("workspace.bin"), &raw).unwrap();
        assert_eq!(s.load().unwrap_err().code, "E_WORKSPACE_UNREADABLE");

        s.save("{\"a\":2}").unwrap();
        *keys.0.lock().unwrap() = Some(base64::engine::general_purpose::STANDARD.encode([7u8; 32]));
        assert_eq!(s.load().unwrap_err().code, "E_WORKSPACE_UNREADABLE");
        *keys.0.lock().unwrap() = None;
        assert_eq!(s.load().unwrap_err().code, "E_WORKSPACE_UNREADABLE");
        // the next save starts over with a new key
        s.save("{\"a\":3}").unwrap();
        assert_eq!(s.load().unwrap().as_deref(), Some("{\"a\":3}"));
        assert_eq!(decrypt(&[0u8; 32], b"not a workspace file").unwrap_err().code, "E_WORKSPACE_UNREADABLE");
    }

    #[test]
    fn clear_removes_file_and_key() {
        let dir = tmpdir("clear");
        let keys = MemKey::default();
        let s = WorkspaceStore::new(dir.join("workspace.bin"), Box::new(keys.clone()));
        s.save("{}").unwrap();
        let copy = std::fs::read(dir.join("workspace.bin")).unwrap();
        s.clear().unwrap();
        assert!(!dir.join("workspace.bin").exists());
        assert!(keys.0.lock().unwrap().is_none());
        assert_eq!(s.load().unwrap(), None);
        s.clear().unwrap(); // idempotent
        // an old copy of the file is useless once the key is gone
        std::fs::write(dir.join("workspace.bin"), copy).unwrap();
        assert_eq!(s.load().unwrap_err().code, "E_WORKSPACE_UNREADABLE");
    }

    #[test]
    fn size_cap() {
        let dir = tmpdir("cap");
        let s = WorkspaceStore::new(dir.join("workspace.bin"), Box::new(MemKey::default()));
        assert_eq!(s.save(&"x".repeat(MAX_PLAINTEXT + 1)).unwrap_err().code, "E_LIMIT");
    }
}
