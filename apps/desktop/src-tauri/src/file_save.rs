//! Saving an approved office → jump transfer to disk. The destination comes from the native save dialog (Rust), never
//! from the WebView. Bytes stream in chunks into `<target>.part`; the file is renamed into place only after its size and
//! SHA-256 match what the ticket declared, so a truncated or tampered download never appears under the chosen name.

use crate::error::AppError;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct SaveJob {
    target: PathBuf,
    tmp: PathBuf,
    file: Option<File>,
    hasher: Sha256,
    written: u64,
    size: u64,
    sha256: String,
    done: bool,
}

pub fn validate(size: u64, sha256: &str) -> Result<(), AppError> {
    if size == 0 {
        return Err(AppError::bad_request("size must be > 0"));
    }
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(AppError::bad_request("sha256 must be 64 lowercase hex chars"));
    }
    Ok(())
}

/// Default name offered in the save dialog: last path component, no control or reserved characters.
pub fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')).collect();
    let clean = clean.trim().trim_matches('.').trim().to_string();
    if clean.is_empty() { "download".into() } else { clean }
}

fn tmp_path(target: &std::path::Path) -> PathBuf {
    let mut name = target.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    target.with_file_name(name)
}

impl SaveJob {
    pub fn create(target: PathBuf, size: u64, sha256: &str) -> Result<Self, AppError> {
        validate(size, sha256)?;
        let tmp = tmp_path(&target);
        let file = OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)
            .map_err(|e| AppError::new("E_IO", format!("cannot create file: {e}")))?;
        Ok(Self { target, tmp, file: Some(file), hasher: Sha256::new(), written: 0, size, sha256: sha256.to_string(), done: false })
    }

    pub fn write(&mut self, chunk: &[u8]) -> Result<(), AppError> {
        if self.written + chunk.len() as u64 > self.size {
            return Err(AppError::bad_request("received more bytes than the ticket declares"));
        }
        let f = self.file.as_mut().ok_or_else(|| AppError::new("E_INTERNAL", "save already closed"))?;
        f.write_all(chunk).map_err(|e| AppError::new("E_IO", format!("write failed: {e}")))?;
        self.hasher.update(chunk);
        self.written += chunk.len() as u64;
        Ok(())
    }

    /// Verifies size + SHA-256, fsyncs and renames `.part` onto the target. Returns the saved file name.
    pub fn finish(mut self) -> Result<String, AppError> {
        if self.written != self.size {
            return Err(AppError::new("E_INTEGRITY", format!("incomplete download: {} of {} bytes", self.written, self.size)));
        }
        let digest: String = std::mem::take(&mut self.hasher).finalize().iter().map(|b| format!("{b:02x}")).collect();
        if digest != self.sha256 {
            return Err(AppError::new("E_INTEGRITY", "downloaded file does not match the approved SHA-256"));
        }
        let f = self.file.take().ok_or_else(|| AppError::new("E_INTERNAL", "save already closed"))?;
        f.sync_all().map_err(|e| AppError::new("E_IO", format!("flush failed: {e}")))?;
        drop(f);
        std::fs::rename(&self.tmp, &self.target).map_err(|e| AppError::new("E_IO", format!("cannot move file into place: {e}")))?;
        self.done = true;
        Ok(self.target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
    }
}

impl Drop for SaveJob {
    fn drop(&mut self) {
        if !self.done {
            self.file.take();
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}

/// In-flight saves keyed by an opaque random handle (the WebView only ever sees the handle).
#[derive(Default)]
pub struct Saves {
    jobs: Mutex<HashMap<String, Arc<Mutex<Option<SaveJob>>>>>,
}

impl Saves {
    pub fn insert(&self, job: SaveJob) -> String {
        use rand::RngCore;
        let mut b = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut b);
        let id: String = b.iter().map(|x| format!("{x:02x}")).collect();
        self.jobs.lock().unwrap().insert(id.clone(), Arc::new(Mutex::new(Some(job))));
        id
    }
    pub fn get(&self, id: &str) -> Result<Arc<Mutex<Option<SaveJob>>>, AppError> {
        self.jobs.lock().unwrap().get(id).cloned().ok_or_else(|| AppError::new("E_NOT_FOUND", "unknown save handle"))
    }
    pub fn take(&self, id: &str) -> Result<SaveJob, AppError> {
        let slot = self.jobs.lock().unwrap().remove(id).ok_or_else(|| AppError::new("E_NOT_FOUND", "unknown save handle"))?;
        let job = slot.lock().unwrap().take();
        job.ok_or_else(|| AppError::new("E_NOT_FOUND", "unknown save handle"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String { Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect() }
    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("tdb-save-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_verifies_and_renames() {
        let d = dir();
        let target = d.join("data.csv");
        let body = b"hello, jump host";
        let mut j = SaveJob::create(target.clone(), body.len() as u64, &hex(body)).unwrap();
        j.write(&body[..5]).unwrap();
        j.write(&body[5..]).unwrap();
        assert!(!target.exists());
        assert_eq!(j.finish().unwrap(), "data.csv");
        assert_eq!(std::fs::read(&target).unwrap(), body);
        assert!(!d.join("data.csv.part").exists());
    }

    #[test]
    fn hash_mismatch_leaves_nothing_behind() {
        let d = dir();
        let target = d.join("x.bin");
        let mut j = SaveJob::create(target.clone(), 3, &hex(b"abc")).unwrap();
        j.write(b"abd").unwrap();
        assert_eq!(j.finish().unwrap_err().code, "E_INTEGRITY");
        assert!(!target.exists());
        assert!(!d.join("x.bin.part").exists());
    }

    #[test]
    fn rejects_overflow_short_files_and_bad_params() {
        let d = dir();
        let mut j = SaveJob::create(d.join("a"), 2, &hex(b"ab")).unwrap();
        assert!(j.write(b"abc").is_err());
        assert_eq!(j.finish().unwrap_err().code, "E_INTEGRITY");
        assert!(SaveJob::create(d.join("b"), 0, &hex(b"")).is_err());
        assert!(SaveJob::create(d.join("c"), 1, "ABC").is_err());
    }

    #[test]
    fn abort_removes_partial_file() {
        let d = dir();
        let saves = Saves::default();
        let mut j = SaveJob::create(d.join("p.zip"), 10, &hex(b"0123456789")).unwrap();
        j.write(b"01234").unwrap();
        let id = saves.insert(j);
        assert!(d.join("p.zip.part").exists());
        drop(saves.take(&id).unwrap());
        assert!(!d.join("p.zip.part").exists());
        assert!(saves.take(&id).is_err());
    }

    #[test]
    fn sanitizes_default_names() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\x\\a?b*.csv"), "ab.csv");
        assert_eq!(sanitize_file_name(".."), "download");
        assert_eq!(sanitize_file_name("báo cáo.xlsx"), "báo cáo.xlsx");
    }
}
