//! User-imported JDBC drivers ("custom" driver type).
//!
//! JARs picked in a native dialog (opened by Rust, never by the WebView) are copied into `<app_data_dir>/drivers-custom`
//! and described in that directory's `manifest.json` with their SHA-256; the sidecar (`--custom-drivers <dir>`) verifies
//! the checksum before loading. The built-in `drivers/` directory next to the sidecar jar is never touched.
//! Manifest: `{"drivers":[{type:"custom", id, name, version?, class, urlTemplate, defaultPort?, files:[{file,sha256}]}]}`.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const MAX_FILES: usize = 20;
pub const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportParams {
    pub name: String,
    pub class_name: String,
    pub url_template: String,
    pub default_port: Option<u16>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DriverFile {
    pub file: String,
    pub sha256: String,
}

/// Manifest entry (field names are the manifest's, not camelCase: `class`, `urlTemplate`, `defaultPort`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub class: String,
    #[serde(rename = "urlTemplate")]
    pub url_template: String,
    #[serde(rename = "defaultPort", skip_serializing_if = "Option::is_none")]
    pub default_port: Option<u16>,
    pub files: Vec<DriverFile>,
}

/// Validated parameters.
#[derive(Debug, Clone)]
pub struct ImportSpec {
    pub name: String,
    pub class_name: String,
    pub url_template: String,
    pub default_port: Option<u16>,
    pub version: Option<String>,
}

fn has_control_or_space(s: &str) -> bool {
    s.chars().any(|c| c.is_control() || c.is_whitespace())
}

pub fn valid_class_name(s: &str) -> bool {
    let mut ch = s.chars();
    match ch.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    s.len() <= 256 && ch.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.')
}

/// `jdbc:` prefix, only {host} {port} {database} placeholders, no whitespace/control chars, <= 512.
pub fn valid_url_template(s: &str) -> bool {
    if !s.starts_with("jdbc:") || s.len() > 512 || has_control_or_space(s) {
        return false;
    }
    let mut rest = s;
    while let Some(i) = rest.find(['{', '}']) {
        if rest.as_bytes()[i] == b'}' {
            return false;
        }
        let after = &rest[i + 1..];
        let Some(j) = after.find('}') else { return false };
        if !matches!(&after[..j], "host" | "port" | "database") {
            return false;
        }
        rest = &after[j + 1..];
    }
    true
}

pub fn validate_import(p: &ImportParams) -> Result<ImportSpec, AppError> {
    let name = p.name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(AppError::bad_request("name must be 1-64 characters"));
    }
    if !valid_class_name(&p.class_name) {
        return Err(AppError::bad_request("invalid driver class name"));
    }
    if !valid_url_template(&p.url_template) {
        return Err(AppError::bad_request("urlTemplate must start with jdbc: and may only use {host} {port} {database}"));
    }
    if let Some(0) = p.default_port {
        return Err(AppError::bad_request("invalid defaultPort"));
    }
    let version = match p.version.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(v) if v.len() <= 64 && !v.chars().any(char::is_control) => Some(v.to_string()),
        Some(_) => return Err(AppError::bad_request("invalid version")),
    };
    Ok(ImportSpec { name: name.to_string(), class_name: p.class_name.clone(), url_template: p.url_template.clone(), default_port: p.default_port, version })
}

/// lowercase [a-z0-9-], no leading/trailing/double '-', at most 32 chars; "driver" if nothing remains.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.chars().take(32).collect();
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "driver".into() } else { out }
}

fn new_id(name: &str) -> String {
    let n: u32 = rand::random();
    format!("{}-{:08x}", slugify(name), n)
}

/// `[A-Za-z0-9._-]` only, no leading dot, always ends with `.jar`, at most 100 chars.
pub fn sanitize_basename(p: &Path) -> String {
    let raw = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = raw.strip_suffix(".jar").or_else(|| raw.strip_suffix(".JAR")).unwrap_or(&raw);
    let mut s: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    s = s.trim_start_matches('.').to_string();
    if s.is_empty() {
        s = "driver".into();
    }
    s.truncate(96);
    format!("{s}.jar")
}

pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

fn check_source(p: &Path) -> Result<(), AppError> {
    let ext_ok = p.extension().map(|e| e.eq_ignore_ascii_case("jar")).unwrap_or(false);
    if !ext_ok {
        return Err(AppError::bad_request("only .jar files are accepted"));
    }
    let md = std::fs::symlink_metadata(p).map_err(|_| AppError::bad_request("cannot read selected file"))?;
    if md.file_type().is_symlink() || !md.is_file() {
        return Err(AppError::bad_request("selected file is not a regular file"));
    }
    if md.len() > MAX_FILE_BYTES {
        return Err(AppError::bad_request("a JAR file exceeds 200 MB"));
    }
    Ok(())
}

// ---------- manifest ----------

pub fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("manifest.json")
}

/// Whole manifest as loose JSON entries so unknown/other entries are preserved on rewrite.
pub fn read_manifest(dir: &Path) -> Result<Vec<Value>, AppError> {
    let p = manifest_path(dir);
    if !p.exists() {
        return Ok(vec![]);
    }
    let txt = std::fs::read_to_string(&p).map_err(|_| AppError::new("E_INTERNAL", "cannot read driver manifest"))?;
    match serde_json::from_str::<Value>(&txt) {
        Ok(Value::Array(a)) => Ok(a),
        Ok(Value::Object(mut o)) => match o.remove("drivers") {
            Some(Value::Array(a)) => Ok(a),
            None => Ok(vec![]),
            _ => Err(AppError::new("E_INTERNAL", "driver manifest is malformed")),
        },
        _ => Err(AppError::new("E_INTERNAL", "driver manifest is malformed")),
    }
}

/// Atomic: write a temp file then rename over the manifest.
pub fn write_manifest(dir: &Path, entries: &[Value]) -> Result<(), AppError> {
    let tmp = dir.join(format!("manifest.json.{:08x}.tmp", rand::random::<u32>()));
    let body = serde_json::to_vec_pretty(&json!({ "drivers": entries })).map_err(|_| AppError::new("E_INTERNAL", "cannot serialize manifest"))?;
    let res = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, manifest_path(dir)));
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::new("E_INTERNAL", "cannot write driver manifest"));
    }
    Ok(())
}

/// Copy the picked JARs into `dir` (as `<id>__<name>.jar`), hash the copies, append the manifest entry.
pub fn import_files(dir: &Path, spec: &ImportSpec, paths: &[PathBuf]) -> Result<Entry, AppError> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(AppError::bad_request("select between 1 and 20 JAR files"));
    }
    for p in paths {
        check_source(p)?;
    }
    std::fs::create_dir_all(dir).map_err(|_| AppError::new("E_INTERNAL", "cannot create drivers directory"))?;
    let mut entries = read_manifest(dir)?;
    let id = new_id(&spec.name);
    let mut files: Vec<DriverFile> = Vec::new();
    let mut copied: Vec<PathBuf> = Vec::new();
    let cleanup = |copied: &[PathBuf]| copied.iter().for_each(|c| { let _ = std::fs::remove_file(c); });
    for (i, src) in paths.iter().enumerate() {
        let mut base = sanitize_basename(src);
        if files.iter().any(|f| f.file == format!("{id}__{base}")) {
            base = format!("{i}-{base}");
        }
        let name = format!("{id}__{base}");
        let dest = dir.join(&name);
        let step = std::fs::copy(src, &dest).and_then(|_| {
            copied.push(dest.clone());
            sha256_file(&dest)
        });
        match step {
            Ok(sha256) => files.push(DriverFile { file: name, sha256 }),
            Err(_) => {
                cleanup(&copied);
                return Err(AppError::new("E_INTERNAL", "cannot copy driver file"));
            }
        }
    }
    let entry = Entry {
        kind: "custom".into(),
        id,
        name: spec.name.clone(),
        version: spec.version.clone(),
        class: spec.class_name.clone(),
        url_template: spec.url_template.clone(),
        default_port: spec.default_port,
        files,
    };
    entries.push(serde_json::to_value(&entry).expect("entry serializes"));
    if let Err(e) = write_manifest(dir, &entries) {
        cleanup(&copied);
        return Err(e);
    }
    Ok(entry)
}

/// Removes the manifest entry (matched by id) and its files. `id` is validated so it can never address other paths.
pub fn remove_entry(dir: &Path, id: &str) -> Result<(), AppError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(AppError::bad_request("invalid driver id"));
    }
    let mut entries = read_manifest(dir)?;
    let Some(pos) = entries.iter().position(|e| e.get("id").and_then(Value::as_str) == Some(id) && e.get("type").and_then(Value::as_str) == Some("custom")) else {
        return Err(AppError::new("E_NOT_FOUND", "driver not found"));
    };
    let removed = entries.remove(pos);
    write_manifest(dir, &entries)?;
    let prefix = format!("{id}__");
    if let Some(files) = removed.get("files").and_then(Value::as_array) {
        for f in files.iter().filter_map(|f| f.get("file").and_then(Value::as_str)) {
            // only flat names that belong to this driver id
            if f.starts_with(&prefix) && !f.contains(['/', '\\']) && f.ends_with(".jar") {
                let _ = std::fs::remove_file(dir.join(f));
            }
        }
    }
    Ok(())
}

// ---------- sidecar view ----------

/// `type=="custom"` entries from a `hello` / `drivers.reload` result (`{drivers:[...]}`).
pub fn custom_entries(result: &Value) -> Vec<Value> {
    result
        .get("drivers")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|d| d.get("type").and_then(Value::as_str) == Some("custom")).cloned().collect())
        .unwrap_or_default()
}

/// `{id, name, files:[{file,sha256}], loaded, error?}` for the SPA. `reload` is the sidecar's `drivers.reload` outcome.
pub fn import_result(entry: &Entry, reload: Result<Value, AppError>) -> Value {
    let (loaded, error) = match &reload {
        Ok(v) => match custom_entries(v).iter().find(|d| d.get("id").and_then(Value::as_str) == Some(&entry.id)) {
            Some(d) => (
                d.get("loaded").and_then(Value::as_bool).unwrap_or(false),
                d.get("error").and_then(Value::as_str).map(str::to_string),
            ),
            None => (false, Some("driver not reported by sidecar".to_string())),
        },
        Err(e) => (false, Some(e.message.clone())),
    };
    let mut out = json!({ "id": entry.id, "name": entry.name, "files": entry.files, "loaded": loaded });
    if let Some(e) = error.filter(|_| !loaded) {
        out["error"] = json!(e);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tdb-cd-{tag}-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn spec() -> ImportSpec {
        validate_import(&ImportParams { name: "MySQL 8".into(), class_name: "com.mysql.cj.jdbc.Driver".into(), url_template: "jdbc:mysql://{host}:{port}/{database}".into(), default_port: Some(3306), version: Some("8.0".into()) }).unwrap()
    }

    #[test]
    fn class_and_url_validation() {
        assert!(valid_class_name("com.mysql.cj.jdbc.Driver") && valid_class_name("$a_b.C1"));
        for bad in ["", "1abc", "a b", "a;b", "a/b", "a-b"] {
            assert!(!valid_class_name(bad), "{bad}");
        }
        assert!(valid_url_template("jdbc:mysql://{host}:{port}/{database}") && valid_url_template("jdbc:h2:mem:x"));
        for bad in ["mysql://x", "jdbc:a://{user}", "jdbc:a://{host", "jdbc:a://host}", "jdbc: a", "jdbc:a\n{host}", &format!("jdbc:{}", "x".repeat(600))] {
            assert!(!valid_url_template(bad), "{bad}");
        }
    }

    #[test]
    fn params_validation() {
        let mk = |n: &str, port| ImportParams { name: n.into(), class_name: "a.B".into(), url_template: "jdbc:x:{host}".into(), default_port: port, version: None };
        assert!(validate_import(&mk("ok", None)).is_ok());
        assert!(validate_import(&mk("  ", None)).is_err());
        assert!(validate_import(&mk(&"n".repeat(65), None)).is_err());
        assert!(validate_import(&mk("ok", Some(0))).is_err());
    }

    #[test]
    fn slug_and_basename() {
        assert_eq!(slugify("MySQL 8 (prod)"), "mysql-8-prod");
        assert_eq!(slugify("***"), "driver");
        assert!(new_id("Ünï code").chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        assert_eq!(sanitize_basename(Path::new("/x/my driver (1).jar")), "my_driver__1_.jar");
        assert_eq!(sanitize_basename(Path::new("/x/.hidden.JAR")), "hidden.jar");
        assert_eq!(sanitize_basename(Path::new("/x/..jar")), "driver.jar");
    }

    #[test]
    fn import_hashes_and_writes_manifest_then_remove() {
        let src = tmp("src");
        let dir = tmp("dst").join("drivers-custom");
        let a = src.join("a.jar");
        let b = src.join("sub-b.jar");
        std::fs::write(&a, b"abc").unwrap();
        std::fs::write(&b, b"").unwrap();
        // pre-existing foreign entry must survive
        std::fs::create_dir_all(&dir).unwrap();
        write_manifest(&dir, &[json!({"type":"custom","id":"other-00000000","name":"o","files":[]})]).unwrap();

        let e = import_files(&dir, &spec(), &[a.clone(), b]).unwrap();
        assert!(e.id.starts_with("mysql-8-") && e.kind == "custom");
        assert_eq!(e.files.len(), 2);
        assert_eq!(e.files[0].sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // sha256("abc")
        assert!(e.files.iter().all(|f| dir.join(&f.file).is_file() && f.file.starts_with(&format!("{}__", e.id))));
        let m = read_manifest(&dir).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[1]["class"], "com.mysql.cj.jdbc.Driver");
        assert_eq!(m[1]["urlTemplate"], "jdbc:mysql://{host}:{port}/{database}");
        assert_eq!(m[1]["defaultPort"], 3306);
        assert!(std::fs::read_dir(&dir).unwrap().all(|f| !f.unwrap().file_name().to_string_lossy().ends_with(".tmp")));

        remove_entry(&dir, &e.id).unwrap();
        assert_eq!(read_manifest(&dir).unwrap().len(), 1);
        assert!(e.files.iter().all(|f| !dir.join(&f.file).exists()));
        assert_eq!(remove_entry(&dir, &e.id).unwrap_err().code, "E_NOT_FOUND");
        assert_eq!(remove_entry(&dir, "../x").unwrap_err().code, "E_BAD_REQUEST");
        std::fs::remove_dir_all(&src).ok();
        std::fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    #[test]
    fn import_rejects_bad_sources() {
        let src = tmp("bad");
        let dir = tmp("baddst");
        let txt = src.join("x.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert!(import_files(&dir, &spec(), &[txt]).is_err());
        assert!(import_files(&dir, &spec(), &[]).is_err());
        assert!(import_files(&dir, &spec(), &[src.join("missing.jar")]).is_err());
        assert!(import_files(&dir, &spec(), &vec![src.join("a.jar"); 21]).is_err());
        assert!(!manifest_path(&dir).exists());
        #[cfg(unix)]
        {
            let real = src.join("r.jar");
            std::fs::write(&real, b"x").unwrap();
            let link = src.join("l.jar");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(import_files(&dir, &spec(), &[link]).is_err());
        }
        std::fs::remove_dir_all(&src).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sidecar_view_and_result() {
        let hello = json!({"protocol":1,"drivers":[{"type":"oracle","loaded":true},{"type":"custom","id":"m-1","loaded":false,"error":"checksum mismatch"}]});
        assert_eq!(custom_entries(&hello).len(), 1);
        let e = Entry { kind: "custom".into(), id: "m-1".into(), name: "M".into(), version: None, class: "a.B".into(), url_template: "jdbc:x".into(), default_port: None, files: vec![] };
        let r = import_result(&e, Ok(hello));
        assert_eq!(r["loaded"], false);
        assert_eq!(r["error"], "checksum mismatch");
        let r = import_result(&e, Ok(json!({"drivers":[{"type":"custom","id":"m-1","loaded":true}]})));
        assert_eq!(r["loaded"], true);
        assert!(r.get("error").is_none());
        let r = import_result(&e, Err(AppError::new("E_SIDECAR_UNAVAILABLE", "cannot start")));
        assert_eq!(r["error"], "cannot start");
    }
}
