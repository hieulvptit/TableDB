//! Secret store on the OS credential store (Windows Credential Manager via the `keyring` crate).
//! Keys are validated; neither keys' values nor errors carrying them are ever logged.

use crate::error::AppError;

pub const SERVICE_PREFIX: &str = "vn.vnpay.tabledb";
/// Credential Manager blob limit is 2560 bytes and keyring stores UTF-16 => ~1280 chars.
#[cfg(windows)]
pub const MAX_VALUE_CHARS: usize = 1200;
/// macOS Keychain has no such small limit; allow a whole token bundle in one item (one prompt instead of three).
#[cfg(not(windows))]
pub const MAX_VALUE_CHARS: usize = 16000;
const MAX_KEY_LEN: usize = 128;

pub fn service_name(env: &str) -> String {
    format!("{SERVICE_PREFIX}.{env}")
}

pub fn validate_key(key: &str) -> Result<(), AppError> {
    let ok = !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@'))
        && !key.starts_with('/')
        && !key.contains("..");
    if ok {
        Ok(())
    } else {
        Err(AppError::new("E_SECRET_KEY", "invalid secret key (allowed: [A-Za-z0-9._:/@-], max 128)"))
    }
}

pub fn validate_value(value: &str) -> Result<(), AppError> {
    if value.is_empty() {
        return Err(AppError::new("E_SECRET_VALUE", "empty secret value"));
    }
    if value.chars().count() > MAX_VALUE_CHARS {
        return Err(AppError::new("E_SECRET_TOO_LARGE", format!("secret exceeds {MAX_VALUE_CHARS} characters")));
    }
    Ok(())
}

fn entry(service: &str, key: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(service, key).map_err(map_err)
}

// keyring errors never contain the secret; still map to generic messages.
fn map_err(e: keyring::Error) -> AppError {
    match e {
        keyring::Error::NoEntry => AppError::new("E_NOT_FOUND", "secret not found"),
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            AppError::new("E_SECRET_STORE", "credential store unavailable")
        }
        _ => AppError::new("E_SECRET_STORE", "credential store error"),
    }
}

pub fn set(service: &str, key: &str, value: &str) -> Result<(), AppError> {
    validate_key(key)?;
    validate_value(value)?;
    entry(service, key)?.set_password(value).map_err(map_err)
}

pub fn get(service: &str, key: &str) -> Result<Option<String>, AppError> {
    validate_key(key)?;
    match entry(service, key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// Idempotent: deleting a missing key succeeds.
pub fn delete(service: &str, key: &str) -> Result<(), AppError> {
    validate_key(key)?;
    match entry(service, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(map_err(e)),
    }
}

// ---------- vault: every secret in ONE credential-store item ----------

/// Name of the single item that holds all secrets (JSON object key -> value).
pub const VAULT_KEY: &str = "vault.v1";
/// macOS Keychain items hold far more; the cap only keeps a runaway caller from bloating the item.
const MAX_VAULT_BYTES: usize = 256 * 1024;

/// Where the vault blob lives. The OS keychain in production, an in-memory fake in tests.
pub trait VaultBackend: Send + Sync {
    fn read(&self) -> Result<Option<String>, AppError>;
    fn write(&self, blob: &str) -> Result<(), AppError>;
}

pub struct KeyringBackend {
    service: String,
}

impl VaultBackend for KeyringBackend {
    fn read(&self) -> Result<Option<String>, AppError> {
        match entry(&self.service, VAULT_KEY)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_err(e)),
        }
    }
    #[cfg(not(target_os = "macos"))]
    fn write(&self, blob: &str) -> Result<(), AppError> {
        entry(&self.service, VAULT_KEY)?.set_password(blob).map_err(map_err)
    }
    /// keyring's `set_password` on macOS = find WITH data (prompt) + modify in place (prompt): two prompts per write,
    /// three per launch together with the startup read. Delete-by-attributes + add reads no secret data, so it does
    /// not prompt, and the re-created item trusts the current binary: its later reads are silent too.
    #[cfg(target_os = "macos")]
    fn write(&self, blob: &str) -> Result<(), AppError> {
        use security_framework::item::{ItemClass, ItemSearchOptions};
        use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
        let store_err = || AppError::new("E_SECRET_STORE", "credential store error");
        // same keychain keyring reads from (keyring's default target = User domain)
        let kc = SecKeychain::default_for_domain(SecPreferencesDomain::User).map_err(|_| store_err())?;
        match ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .keychains(std::slice::from_ref(&kc))
            .service(&self.service)
            .account(VAULT_KEY)
            .delete()
        {
            Ok(()) => {}
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => {}
            Err(_) => return Err(store_err()),
        }
        kc.add_generic_password(&self.service, VAULT_KEY, blob.as_bytes()).map_err(|_| store_err())
    }
}

/// On macOS every keychain item has its own access prompt, and every read without "Always Allow" prompts again.
/// So all secrets (session tokens, saved DB passwords) share ONE item, read once per process and cached in memory:
/// at most one prompt at startup, none afterwards. Writes happen only when a value actually changes.
/// Windows Credential Manager does not prompt but caps an item at ~2.5 KB, so there each key stays its own item.
pub struct Vault {
    backend: Option<Box<dyn VaultBackend>>,
    service: String,
    cache: std::sync::Mutex<Option<std::collections::BTreeMap<String, String>>>,
}

impl Vault {
    pub fn new(service: String) -> Self {
        let single_item = !cfg!(windows);
        let backend: Option<Box<dyn VaultBackend>> =
            single_item.then(|| Box::new(KeyringBackend { service: service.clone() }) as Box<dyn VaultBackend>);
        Vault { backend, service, cache: std::sync::Mutex::new(None) }
    }

    pub fn with_backend(backend: Box<dyn VaultBackend>) -> Self {
        Vault { backend: Some(backend), service: String::new(), cache: std::sync::Mutex::new(None) }
    }

    /// Runs `f` on the cached map, loading it from the backend on first use. A failed load is not cached,
    /// so a denied prompt is asked again only on the next explicit action.
    fn with_map<T>(
        &self,
        backend: &dyn VaultBackend,
        f: impl FnOnce(&mut std::collections::BTreeMap<String, String>) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut guard = self.cache.lock().map_err(|_| AppError::new("E_INTERNAL", "vault lock poisoned"))?;
        if guard.is_none() {
            // unreadable/corrupt blob => start empty (the next write replaces it)
            let map = backend.read()?.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
            *guard = Some(map);
        }
        f(guard.as_mut().expect("loaded above"))
    }

    fn persist(backend: &dyn VaultBackend, map: &std::collections::BTreeMap<String, String>) -> Result<(), AppError> {
        let blob = serde_json::to_string(map).map_err(|_| AppError::new("E_INTERNAL", "vault not serializable"))?;
        if blob.len() > MAX_VAULT_BYTES {
            return Err(AppError::new("E_SECRET_TOO_LARGE", "secret store is full"));
        }
        backend.write(&blob)
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, AppError> {
        validate_key(key)?;
        let Some(b) = self.backend.as_deref() else { return get(&self.service, key) };
        self.with_map(b, |m| Ok(m.get(key).cloned()))
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), AppError> {
        validate_key(key)?;
        validate_value(value)?;
        let Some(b) = self.backend.as_deref() else { return set(&self.service, key, value) };
        self.with_map(b, |m| {
            if m.get(key).map(String::as_str) == Some(value) {
                return Ok(());
            }
            let prev = m.insert(key.to_owned(), value.to_owned());
            Self::persist(b, m).inspect_err(|_| {
                // keep the cache equal to what is stored
                match prev {
                    Some(p) => m.insert(key.to_owned(), p),
                    None => m.remove(key),
                };
            })
        })
    }

    /// Idempotent; deleting a missing key touches nothing.
    pub fn delete(&self, key: &str) -> Result<(), AppError> {
        validate_key(key)?;
        let Some(b) = self.backend.as_deref() else { return delete(&self.service, key) };
        self.with_map(b, |m| {
            let Some(prev) = m.remove(key) else { return Ok(()) };
            Self::persist(b, m).inspect_err(|_| {
                m.insert(key.to_owned(), prev);
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_validation() {
        for ok in ["auth.refresh", "db:profile-1/password", "a@b_c", "k"] {
            assert!(validate_key(ok).is_ok(), "{ok}");
        }
        for bad in ["", "/abs", "a b", "a\nb", "../x", "ключ", &"k".repeat(129), "a;b", "a*b"] {
            assert!(validate_key(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn value_limits() {
        assert!(validate_value("x").is_ok());
        assert!(validate_value("").is_err());
        assert_eq!(validate_value(&"a".repeat(MAX_VALUE_CHARS + 1)).unwrap_err().code, "E_SECRET_TOO_LARGE");
    }

    #[test]
    fn service_is_namespaced_per_env() {
        assert_eq!(service_name("test"), "vn.vnpay.tabledb.test");
        assert_ne!(service_name("test"), service_name("prod"));
    }

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Fake {
        blob: Mutex<Option<String>>,
        reads: AtomicUsize,
        writes: AtomicUsize,
        fail_writes: std::sync::atomic::AtomicBool,
    }
    struct FakeRef(Arc<Fake>);
    impl VaultBackend for FakeRef {
        fn read(&self) -> Result<Option<String>, AppError> {
            self.0.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.0.blob.lock().unwrap().clone())
        }
        fn write(&self, blob: &str) -> Result<(), AppError> {
            if self.0.fail_writes.load(Ordering::SeqCst) {
                return Err(AppError::new("E_SECRET_STORE", "denied"));
            }
            self.0.writes.fetch_add(1, Ordering::SeqCst);
            *self.0.blob.lock().unwrap() = Some(blob.to_owned());
            Ok(())
        }
    }
    fn vault() -> (Vault, Arc<Fake>) {
        let f = Arc::new(Fake::default());
        (Vault::with_backend(Box::new(FakeRef(f.clone()))), f)
    }

    #[test]
    fn vault_reads_the_store_once_for_many_keys() {
        let (v, f) = vault();
        v.set("auth.session", "tok").unwrap();
        v.set("db.profile.a.password", "pa").unwrap();
        v.set("db.profile.b.password", "pb").unwrap();
        for _ in 0..10 {
            assert_eq!(v.get("auth.session").unwrap().as_deref(), Some("tok"));
            assert_eq!(v.get("db.profile.b.password").unwrap().as_deref(), Some("pb"));
            assert_eq!(v.get("db.profile.missing.password").unwrap(), None);
        }
        assert_eq!(f.reads.load(Ordering::SeqCst), 1);
        assert_eq!(f.writes.load(Ordering::SeqCst), 3);

        // a new process sees the same single item
        let v2 = Vault::with_backend(Box::new(FakeRef(f.clone())));
        assert_eq!(v2.get("db.profile.a.password").unwrap().as_deref(), Some("pa"));
    }

    #[test]
    fn vault_skips_needless_writes() {
        let (v, f) = vault();
        v.set("k", "v").unwrap();
        v.set("k", "v").unwrap(); // unchanged
        v.delete("absent").unwrap(); // nothing to delete
        assert_eq!(f.writes.load(Ordering::SeqCst), 1);
        v.delete("k").unwrap();
        assert_eq!(v.get("k").unwrap(), None);
        assert_eq!(f.writes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn vault_cache_matches_store_after_failed_write() {
        let (v, f) = vault();
        v.set("k", "old").unwrap();
        f.fail_writes.store(true, Ordering::SeqCst);
        assert!(v.set("k", "new").is_err());
        assert!(v.set("k2", "x").is_err());
        assert!(v.delete("k").is_err());
        assert_eq!(v.get("k").unwrap().as_deref(), Some("old"));
        assert_eq!(v.get("k2").unwrap(), None);
    }

    #[test]
    fn vault_corrupt_blob_starts_empty_and_validates_keys() {
        let (v, f) = vault();
        *f.blob.lock().unwrap() = Some("not json".into());
        assert_eq!(v.get("k").unwrap(), None);
        assert!(v.get("../x").is_err());
        assert!(v.set("k", "").is_err());
    }

    // Touches the real login keychain (own throwaway service): `cargo test -- --ignored real_keychain`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn real_keychain_overwrite_roundtrip() {
        let b = KeyringBackend { service: service_name("selftest") };
        b.write(r#"{"k":"1"}"#).unwrap();
        b.write(r#"{"k":"2"}"#).unwrap(); // replaces the existing item
        assert_eq!(b.read().unwrap().as_deref(), Some(r#"{"k":"2"}"#));
        entry(&b.service, VAULT_KEY).unwrap().delete_credential().unwrap();
        assert_eq!(b.read().unwrap(), None);
    }

    // Round trip through the keyring mock backend (no OS keychain touched).
    #[test]
    fn mock_backend_roundtrip() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        // Mock entries are independent per Entry, so only assert error mapping semantics here.
        assert_eq!(get("svc", "k").unwrap(), None);
        assert!(delete("svc", "k").is_ok());
        assert!(set("svc", "k", "v").is_ok());
    }
}
