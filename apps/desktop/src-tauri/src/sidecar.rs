//! JDBC sidecar manager: NDJSON over stdio (docs/SIDECAR-PROTOCOL.md).
//! - method allowlist, 8 MiB line cap (both directions), id correlation, per-method timeout
//! - lazy spawn from bundled resources, -Xmx cap, restart-on-crash (lazy, rate limited), kill on exit
//! - stdout carries only NDJSON; stderr is logged redacted; params/rows are never logged.

use crate::error::AppError;
use crate::redact::redact;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, Notify};

pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

pub const ALLOWED_METHODS: &[&str] = &[
    "hello",
    "session.open",
    "session.test",
    "session.close",
    "session.closeAll",
    "meta.catalogs",
    "meta.schemas",
    "meta.tables",
    "meta.columns",
    "meta.ddl",
    "meta.fingerprint",
    "query.execute",
    "query.fetch",
    "query.cancel",
    "query.closeCursor",
    "query.plan",
    "session.setSchema",
    "tx.setAutoCommit",
    "tx.commit",
    "tx.rollback",
    "diag.proxy",
];

pub fn is_allowed_method(m: &str) -> bool {
    ALLOWED_METHODS.contains(&m)
}

/// Methods only the Rust core may send (never reachable from the WebView via `sidecar_request`).
pub const INTERNAL_METHODS: &[&str] = &["drivers.reload"];

pub fn is_internal_method(m: &str) -> bool {
    INTERNAL_METHODS.contains(&m)
}

// ---------- framing ----------

pub fn encode_request(id: u64, method: &str, params: &Value) -> Result<Vec<u8>, AppError> {
    let mut line = serde_json::to_vec(&json!({"id": id, "method": method, "params": params}))
        .map_err(|_| AppError::bad_request("params not serializable"))?;
    line.push(b'\n');
    if line.len() > MAX_LINE_BYTES {
        return Err(AppError::new("E_LIMIT", format!("request exceeds {MAX_LINE_BYTES} bytes")));
    }
    Ok(line)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SidecarEvent {
    pub event: String,
    pub seq: u64,
    pub data: Value,
}

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Response { id: u64, outcome: Result<Value, AppError> },
    Event(SidecarEvent),
}

pub fn parse_incoming(line: &[u8]) -> Result<Incoming, String> {
    let v: Value = serde_json::from_slice(line).map_err(|_| "invalid json".to_string())?;
    let obj = v.as_object().ok_or("not an object")?;
    if let Some(ev) = obj.get("event").and_then(Value::as_str) {
        return Ok(Incoming::Event(SidecarEvent {
            event: ev.to_string(),
            seq: obj.get("seq").and_then(Value::as_u64).unwrap_or(0),
            data: obj.get("data").cloned().unwrap_or(Value::Null),
        }));
    }
    let id = obj.get("id").and_then(Value::as_u64).ok_or("missing id")?;
    if let Some(e) = obj.get("error").filter(|e| !e.is_null()) {
        let s = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_string);
        return Ok(Incoming::Response {
            id,
            outcome: Err(AppError {
                code: s("code").unwrap_or_else(|| "E_INTERNAL".into()),
                message: s("message").unwrap_or_default(),
                sql_state: s("sqlState"),
                vendor_code: e.get("vendorCode").and_then(Value::as_i64),
                retryable: e.get("retryable").and_then(Value::as_bool).unwrap_or(false),
                details: e.get("details").filter(|d| d.is_object()).cloned(),
            }),
        });
    }
    Ok(Incoming::Response { id, outcome: Ok(obj.get("result").cloned().unwrap_or(Value::Null)) })
}

/// Per-method timeout: covers the sidecar-side timeout the caller asked for, plus slack.
pub fn timeout_for(method: &str, params: &Value) -> Duration {
    let num = |k: &str| params.get(k).and_then(Value::as_u64);
    let secs = match method {
        "query.execute" | "query.plan" => num("timeoutSec").unwrap_or(60).min(600) + 15,
        "session.open" | "session.test" => {
            let ext = params.pointer("/profile/options/externalAuthTimeoutSec").and_then(Value::as_u64).unwrap_or(0).min(600);
            let conn = params.pointer("/profile/options/connectTimeoutSec").and_then(Value::as_u64).unwrap_or(15).min(120);
            // each SSH hop (and the proxy leg) may use the whole connect timeout before the database itself
            let hops = params.pointer("/profile/ssh/hops").and_then(Value::as_array).map(|a| a.len().min(4) as u64).unwrap_or(0);
            let proxy = u64::from(params.pointer("/profile/options/proxy").is_some_and(|p| p.is_object()));
            (conn * (1 + hops + proxy) + 30).max(ext + conn * (hops + proxy) + 15)
        }
        "query.fetch" => 120,
        "diag.proxy" => 45,
        _ => 30,
    };
    Duration::from_secs(secs)
}

// ---------- id correlation ----------

pub type Outcome = Result<Value, AppError>;

#[derive(Default)]
pub struct Correlator {
    next: u64,
    pending: HashMap<u64, oneshot::Sender<Outcome>>,
}

impl Correlator {
    pub fn register(&mut self) -> (u64, oneshot::Receiver<Outcome>) {
        self.next += 1;
        let (tx, rx) = oneshot::channel();
        self.pending.insert(self.next, tx);
        (self.next, rx)
    }
    /// false = unknown/duplicate/late id (dropped).
    pub fn resolve(&mut self, id: u64, outcome: Outcome) -> bool {
        match self.pending.remove(&id) {
            Some(tx) => {
                let _ = tx.send(outcome);
                true
            }
            None => false,
        }
    }
    pub fn forget(&mut self, id: u64) {
        self.pending.remove(&id);
    }
    pub fn fail_all(&mut self, err: &AppError) -> usize {
        let n = self.pending.len();
        for (_, tx) in self.pending.drain() {
            let _ = tx.send(Err(err.clone()));
        }
        n
    }
    pub fn len(&self) -> usize {
        self.pending.len()
    }
}

// ---------- restart policy ----------

/// Allow at most `max` unexpected exits within `window`; then refuse to respawn for `cooldown`.
pub struct RestartPolicy {
    exits: Vec<Instant>,
    pub max: usize,
    pub window: Duration,
    pub cooldown: Duration,
}
impl RestartPolicy {
    pub fn new() -> Self {
        Self { exits: vec![], max: 3, window: Duration::from_secs(60), cooldown: Duration::from_secs(30) }
    }
    pub fn record_exit(&mut self, now: Instant) {
        self.exits.push(now);
    }
    /// Err(remaining cooldown) when crash-looping.
    pub fn check(&mut self, now: Instant) -> Result<(), Duration> {
        let window = self.window;
        self.exits.retain(|t| now.saturating_duration_since(*t) <= window.max(self.cooldown));
        let recent: Vec<_> = self.exits.iter().filter(|t| now.saturating_duration_since(**t) <= window).collect();
        if recent.len() >= self.max {
            let last = **recent.last().unwrap();
            let until = last + self.cooldown;
            if now < until {
                return Err(until - now);
            }
        }
        Ok(())
    }
}

// ---------- launch spec ----------

#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

/// Debug builds only: `TABLEDB_DEV_JAVA` + `TABLEDB_DEV_JAR` point at a local JDK/jar (drivers/ beside the jar).
pub fn resolve_launch_dev(java: &Path, jar: &Path, max_heap_mb: u32) -> Result<LaunchSpec, AppError> {
    for p in [java, jar] {
        if !p.is_file() {
            return Err(AppError::new("E_SIDECAR_UNAVAILABLE", format!("dev path not found: {}", p.display())));
        }
    }
    let mut spec = resolve_launch_from(java.to_path_buf(), jar.to_path_buf(), max_heap_mb);
    spec.cwd = jar.parent().map(Path::to_path_buf);
    Ok(spec)
}

fn resolve_launch_from(java: PathBuf, jar: PathBuf, max_heap_mb: u32) -> LaunchSpec {
    LaunchSpec {
        program: java,
        args: vec![
            format!("-Xmx{max_heap_mb}m"),
            "-XX:+ExitOnOutOfMemoryError".into(),
            "-Dfile.encoding=UTF-8".into(),
            "-Dstdout.encoding=UTF-8".into(),
            "-Djava.awt.headless=true".into(),
            "-jar".into(),
            jar.to_string_lossy().into_owned(),
            "--stdio".into(),
        ],
        cwd: jar.parent().map(Path::to_path_buf),
    }
}

impl LaunchSpec {
    /// Adds `--custom-drivers <dir>` (user-imported JDBC drivers, verified by sha256 in the sidecar).
    pub fn with_custom_drivers(mut self, dir: &Path) -> Self {
        self.args.push("--custom-drivers".into());
        self.args.push(dir.to_string_lossy().into_owned());
        self
    }

    /// Adds `--ssh-keys <dir>` (imported SSH private keys, addressed by id only).
    pub fn with_ssh_keys(mut self, dir: &Path) -> Self {
        self.args.push("--ssh-keys".into());
        self.args.push(dir.to_string_lossy().into_owned());
        self
    }
}

/// resources/jre/bin/java.exe + resources/sidecar/tabledb-jdbc.jar (drivers/ beside the jar).
pub fn resolve_launch(resource_dir: &Path, max_heap_mb: u32) -> Result<LaunchSpec, AppError> {
    let root = strip_verbatim(resource_dir);
    let java_name = if cfg!(windows) { "java.exe" } else { "java" };
    let java = root.join("resources").join("jre").join("bin").join(java_name);
    let jar = root.join("resources").join("sidecar").join("tabledb-jdbc.jar");
    for (what, p) in [("bundled JRE", &java), ("sidecar jar", &jar)] {
        if !p.is_file() {
            return Err(AppError::new("E_SIDECAR_UNAVAILABLE", format!("{what} not found at {}", p.display())));
        }
    }
    Ok(resolve_launch_from(java, jar, max_heap_mb))
}

// ---------- events ----------

pub trait EventSink: Send + Sync {
    fn emit(&self, ev: &SidecarEvent);
}

/// For `auth.openUrl` with purpose `trino-sso`: the validated URL to open in the system browser.
pub fn browser_url_for_event(ev: &SidecarEvent) -> Option<url::Url> {
    if ev.event != "auth.openUrl" || ev.data.get("purpose").and_then(Value::as_str) != Some("trino-sso") {
        return None;
    }
    crate::urlcheck::validate_external_url(ev.data.get("url")?.as_str()?).ok()
}

// ---------- manager ----------

struct Running {
    generation: u64,
    accepting: bool,
    stdin: Arc<Mutex<ChildStdin>>,
    kill: Arc<Notify>,
}

pub struct SidecarManager {
    heap_mb: AtomicU32,
    spec: Result<LaunchSpec, AppError>,
    sink: Arc<dyn EventSink>,
    running: Mutex<Option<Running>>,
    correlator: Arc<StdMutex<Correlator>>,
    policy: StdMutex<RestartPolicy>,
    generation: AtomicU64,
    shutting_down: AtomicBool,
    ready: StdMutex<Option<Value>>,
}

impl SidecarManager {
    pub fn new(spec: Result<LaunchSpec, AppError>, sink: Arc<dyn EventSink>) -> Arc<Self> {
        Arc::new(Self {
            heap_mb: AtomicU32::new(0),
            spec,
            sink,
            running: Mutex::new(None),
            correlator: Arc::new(StdMutex::new(Correlator::default())),
            policy: StdMutex::new(RestartPolicy::new()),
            generation: AtomicU64::new(0),
            shutting_down: AtomicBool::new(false),
            ready: StdMutex::new(None),
        })
    }

    pub fn set_heap_mb(&self, mb: u32) { self.heap_mb.store(mb, Ordering::SeqCst); }

    pub fn ready_info(&self) -> Option<Value> {
        self.ready.lock().unwrap().clone()
    }

    /// Validates, correlates and forwards. Timeout is derived from the method/params.
    pub async fn request(self: &Arc<Self>, method: &str, params: Value) -> Outcome {
        let t = timeout_for(method, &params);
        self.request_with_timeout(method, params, t).await
    }

    pub async fn request_with_timeout(self: &Arc<Self>, method: &str, params: Value, timeout: Duration) -> Outcome {
        if !is_allowed_method(method) {
            return Err(AppError::bad_request("method not allowed"));
        }
        self.dispatch(method, params, timeout).await
    }

    /// For the Rust core only (driver management): allowed protocol methods plus [`INTERNAL_METHODS`].
    pub async fn request_internal(self: &Arc<Self>, method: &str, params: Value) -> Outcome {
        if !is_allowed_method(method) && !is_internal_method(method) {
            return Err(AppError::bad_request("method not allowed"));
        }
        let t = timeout_for(method, &params);
        self.dispatch(method, params, t).await
    }

    async fn dispatch(self: &Arc<Self>, method: &str, params: Value, timeout: Duration) -> Outcome {
        let params = match params {
            Value::Null => json!({}),
            Value::Object(_) => params,
            _ => return Err(AppError::bad_request("params must be an object")),
        };
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(AppError::new("E_SIDECAR_EXITED", "application is shutting down"));
        }
        let deadline = tokio::time::Instant::now() + timeout;
        let stdin = tokio::time::timeout_at(deadline, self.ensure_running()).await
            .map_err(|_| AppError::new("E_TIMEOUT", "timed out starting sidecar").retryable(true))??;
        let (id, rx) = self.correlator.lock().unwrap().register();
        let line = match encode_request(id, method, &params) {
            Ok(l) => l,
            Err(e) => {
                self.correlator.lock().unwrap().forget(id);
                return Err(e);
            }
        };
        let write = async {
            let mut w = stdin.lock().await;
            if !self.running.lock().await.as_ref().is_some_and(|r| r.accepting && Arc::ptr_eq(&r.stdin, &stdin)) {
                return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "sidecar transport invalidated"));
            }
            w.write_all(&line).await?;
            w.flush().await
        };
        match tokio::time::timeout_at(deadline, write).await {
            Ok(Ok(())) => {}
            result => {
                self.correlator.lock().unwrap().forget(id);
                // A failed/cancelled write may have emitted a partial NDJSON frame. Kill this
                // generation before accepting any further writes on the same pipe.
                let mut running = self.running.lock().await;
                if let Some(r) = running.as_mut().filter(|r| Arc::ptr_eq(&r.stdin, &stdin)) {
                    r.accepting = false;
                    r.kill.notify_one();
                }
                return Err(if result.is_err() {
                    AppError::new("E_TIMEOUT", "timed out writing to sidecar").retryable(true)
                } else {
                    AppError::new("E_SIDECAR_EXITED", "sidecar is not accepting requests").retryable(true)
                });
            }
        }
        match tokio::time::timeout_at(deadline, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(AppError::new("E_SIDECAR_EXITED", "sidecar exited before responding").retryable(true)),
            Err(_) => {
                self.correlator.lock().unwrap().forget(id);
                if matches!(method, "query.execute" | "query.fetch") {
                    let key = if method == "query.fetch" { "cursorId" } else { "queryId" };
                    if let Some(q) = params.get(key).and_then(Value::as_str) {
                        // best effort: ask the sidecar to cancel the statement that we stopped waiting for
                        let me = self.clone();
                        let q = q.to_string();
                        tokio::spawn(async move {
                            me.fire_and_forget("query.cancel", json!({(key): q})).await;
                        });
                    }
                }
                Err(AppError::new("E_TIMEOUT", format!("no response to {method} within {}s", timeout.as_secs())).retryable(true))
            }
        }
    }

    /// Send without waiting for the response (the reply is matched and dropped).
    /// Not recursive on `request_with_timeout`, so it is usable from spawned tasks.
    async fn fire_and_forget(self: &Arc<Self>, method: &str, params: Value) {
        let stdin = {
            let running = self.running.lock().await;
            let Some(r) = running.as_ref().filter(|r| r.accepting) else { return };
            r.stdin.clone()
        };
        let (id, rx) = self.correlator.lock().unwrap().register();
        drop(rx);
        if let Ok(line) = encode_request(id, method, &params) {
            let write = async {
                let mut w = stdin.lock().await;
                if !self.running.lock().await.as_ref().is_some_and(|r| r.accepting && Arc::ptr_eq(&r.stdin, &stdin)) {
                    return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "sidecar transport invalidated"));
                }
                w.write_all(&line).await?;
                w.flush().await
            };
            if !matches!(tokio::time::timeout(Duration::from_secs(5), write).await, Ok(Ok(()))) {
                let mut running = self.running.lock().await;
                if let Some(r) = running.as_mut().filter(|r| Arc::ptr_eq(&r.stdin, &stdin)) { r.accepting = false; r.kill.notify_one(); }
            }
        }
        self.correlator.lock().unwrap().forget(id);
    }

    async fn ensure_running(self: &Arc<Self>) -> Result<Arc<Mutex<ChildStdin>>, AppError> {
        let mut guard = self.running.lock().await;
        if let Some(r) = guard.as_ref() {
            if !r.accepting { return Err(AppError::new("E_SIDECAR_EXITED", "sidecar transport is restarting").retryable(true)); }
            return Ok(r.stdin.clone());
        }
        let spec = self.spec.as_ref().map_err(Clone::clone)?;
        if let Err(wait) = self.policy.lock().unwrap().check(Instant::now()) {
            return Err(AppError::new(
                "E_SIDECAR_CRASH_LOOP",
                format!("sidecar keeps crashing; retry in {}s", wait.as_secs() + 1),
            )
            .retryable(true));
        }
        let mut cmd = Command::new(&spec.program);
        let mb = self.heap_mb.load(Ordering::SeqCst);
        let args: Vec<String> = spec.args.iter().map(|a| if mb > 0 && a.starts_with("-Xmx") { format!("-Xmx{mb}m") } else { a.clone() }).collect();
        cmd.args(&args)
            .env_remove("JDBC_SERVICE_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(d) = &spec.cwd {
            cmd.current_dir(d);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| {
            log::error!("sidecar spawn failed: {e}");
            AppError::new("E_SIDECAR_UNAVAILABLE", "cannot start JDBC sidecar")
        })?;
        let stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let stderr = child.stderr.take().expect("piped");
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let kill = Arc::new(Notify::new());
        log::info!("sidecar started (generation {generation}, pid {:?})", child.id());

        tokio::spawn(read_stderr(stderr));
        tokio::spawn(read_stdout(self.clone(), stdout, kill.clone()));
        tokio::spawn(supervise(self.clone(), child, generation, kill.clone()));

        let stdin = Arc::new(Mutex::new(stdin));
        *guard = Some(Running { generation, accepting: true, stdin: stdin.clone(), kill });
        Ok(stdin)
    }

    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(r) = self.running.lock().await.take() {
            r.kill.notify_one();
            // dropping stdin (EOF) also makes the sidecar exit; give the supervisor a moment to kill
            drop(r.stdin);
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        self.correlator.lock().unwrap().fail_all(&AppError::new("E_SIDECAR_EXITED", "application is shutting down"));
    }

    fn handle_line(&self, line: &[u8]) -> Result<(), String> {
        match parse_incoming(line)? {
            Incoming::Response { id, outcome } => {
                if !self.correlator.lock().unwrap().resolve(id, outcome) {
                    log::debug!("dropping response with unknown id {id}");
                }
            }
            Incoming::Event(ev) => {
                if ev.event == "ready" {
                    *self.ready.lock().unwrap() = Some(ev.data.clone());
                }
                self.sink.emit(&ev);
            }
        }
        Ok(())
    }
}

async fn read_stdout(mgr: Arc<SidecarManager>, stdout: tokio::process::ChildStdout, kill: Arc<Notify>) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = match (&mut reader).take(MAX_LINE_BYTES as u64 + 1).read_until(b'\n', &mut buf).await {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        if buf.last() != Some(&b'\n') && buf.len() > MAX_LINE_BYTES {
            log::error!("sidecar sent an oversized line; killing it");
            kill.notify_one();
            break;
        }
        if buf.last() != Some(&b'\n') {
            // EOF in the middle of a line
            break;
        }
        while matches!(buf.last(), Some(b'\n' | b'\r')) {
            buf.pop();
        }
        if buf.is_empty() {
            continue;
        }
        if let Err(e) = mgr.handle_line(&buf) {
            // never log the line itself (may contain row data)
            log::warn!("ignoring malformed sidecar line ({e}, {} bytes)", buf.len());
        }
    }
}

async fn read_stderr(stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(l)) = lines.next_line().await {
        let l: String = l.chars().take(8192).collect();
        log::info!(target: "sidecar", "{}", redact(&l));
    }
}

async fn supervise(mgr: Arc<SidecarManager>, mut child: Child, generation: u64, kill: Arc<Notify>) {
    let status = tokio::select! {
        s = child.wait() => s.ok(),
        _ = kill.notified() => {
            let _ = child.kill().await;
            child.wait().await.ok()
        }
    };
    let expected = mgr.shutting_down.load(Ordering::SeqCst);
    let n = {
        let mut running = mgr.running.lock().await;
        // Fail the old generation before making a successor spawnable.
        let n = mgr.correlator.lock().unwrap().fail_all(&AppError::new("E_SIDECAR_EXITED", "sidecar exited unexpectedly").retryable(true));
        if !expected { mgr.policy.lock().unwrap().record_exit(Instant::now()); }
        if running.as_ref().map(|r| r.generation) == Some(generation) { *running = None; }
        n
    };
    if !expected {
        log::warn!("sidecar generation {generation} exited ({status:?}); {n} request(s) failed; will restart on next request");
        mgr.sink.emit(&SidecarEvent { event: "exit".into(), seq: 0, data: json!({"code": status.and_then(|s| s.code())}) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_matches_protocol() {
        for m in ["hello", "session.open", "query.execute", "query.cancel", "diag.proxy", "meta.fingerprint", "query.closeCursor", "session.closeAll",
                  "query.plan", "session.setSchema", "tx.setAutoCommit", "tx.commit", "tx.rollback"] {
            assert!(is_allowed_method(m), "{m}");
        }
        assert!(!is_allowed_method("drivers.reload"), "internal only, never from the WebView");
        assert!(is_internal_method("drivers.reload") && !is_internal_method("hello"));
        for m in ["", "exec", "system.exit", "session.open ", "Query.Execute", "query.explain", "shell", "meta.", "../hello"] {
            assert!(!is_allowed_method(m), "{m:?}");
        }
    }

    #[test]
    fn encode_ok_and_size_cap() {
        let l = encode_request(7, "hello", &json!({})).unwrap();
        assert_eq!(l.last(), Some(&b'\n'));
        assert_eq!(l.iter().filter(|b| **b == b'\n').count(), 1);
        let v: Value = serde_json::from_slice(&l).unwrap();
        assert_eq!(v["id"], 7);
        // newlines inside strings are escaped, never raw
        let l = encode_request(1, "query.execute", &json!({"sql": "a\nb"})).unwrap();
        assert_eq!(l.iter().filter(|b| **b == b'\n').count(), 1);
        let big = json!({"sql": "x".repeat(MAX_LINE_BYTES)});
        assert_eq!(encode_request(1, "query.execute", &big).unwrap_err().code, "E_LIMIT");
    }

    #[test]
    fn parse_response_result_and_error() {
        assert_eq!(
            parse_incoming(br#"{"id":12,"result":{"a":1}}"#).unwrap(),
            Incoming::Response { id: 12, outcome: Ok(json!({"a": 1})) }
        );
        match parse_incoming(br#"{"id":3,"error":{"code":"E_SQL","message":"boom","sqlState":"42P01","vendorCode":7,"retryable":false}}"#).unwrap() {
            Incoming::Response { id: 3, outcome: Err(e) } => {
                assert_eq!(e.code, "E_SQL");
                assert_eq!(e.sql_state.as_deref(), Some("42P01"));
                assert_eq!(e.vendor_code, Some(7));
                assert!(e.details.is_none());
            }
            o => panic!("{o:?}"),
        }
        let hk = br#"{"id":4,"error":{"code":"E_SSH_HOSTKEY","message":"unknown host key","retryable":false,"details":{"hop":0,"fingerprint":"SHA256:abc","reason":"unknown"}}}"#;
        match parse_incoming(hk).unwrap() {
            Incoming::Response { id: 4, outcome: Err(e) } => {
                assert_eq!(e.code, "E_SSH_HOSTKEY");
                assert_eq!(e.details.as_ref().and_then(|d| d.get("fingerprint")).and_then(Value::as_str), Some("SHA256:abc"));
                // forwarded to the SPA
                assert!(serde_json::to_string(&e).unwrap().contains("\"details\""));
            }
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn parse_events_and_garbage() {
        match parse_incoming(br#"{"event":"ready","seq":0,"data":{"protocol":1}}"#).unwrap() {
            Incoming::Event(e) => assert_eq!((e.event.as_str(), e.seq), ("ready", 0)),
            o => panic!("{o:?}"),
        }
        assert!(parse_incoming(b"not json").is_err());
        assert!(parse_incoming(b"[1]").is_err());
        assert!(parse_incoming(br#"{"result":1}"#).is_err());
        assert!(parse_incoming(br#"{"id":"x","result":1}"#).is_err());
    }

    #[tokio::test]
    async fn correlator_matches_ids_out_of_order() {
        let mut c = Correlator::default();
        let (a, ra) = c.register();
        let (b, rb) = c.register();
        assert_ne!(a, b);
        assert!(c.resolve(b, Ok(json!("B"))));
        assert!(c.resolve(a, Ok(json!("A"))));
        assert_eq!(rb.await.unwrap().unwrap(), json!("B"));
        assert_eq!(ra.await.unwrap().unwrap(), json!("A"));
        assert!(!c.resolve(a, Ok(json!(null)))); // duplicate/late
        assert!(!c.resolve(999, Ok(json!(null))));
    }

    #[tokio::test]
    async fn correlator_fail_all() {
        let mut c = Correlator::default();
        let (_, r1) = c.register();
        let (id2, _r2) = c.register();
        c.forget(id2);
        assert_eq!(c.fail_all(&AppError::new("E_X", "x")), 1);
        assert_eq!(r1.await.unwrap().unwrap_err().code, "E_X");
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn timeouts_follow_request() {
        assert_eq!(timeout_for("query.execute", &json!({})), Duration::from_secs(75));
        assert_eq!(timeout_for("query.execute", &json!({"timeoutSec": 9999})), Duration::from_secs(615));
        assert_eq!(timeout_for("meta.tables", &json!({})), Duration::from_secs(30));
        let sso = json!({"profile": {"options": {"externalAuthTimeoutSec": 180}}});
        assert!(timeout_for("session.open", &sso) >= Duration::from_secs(195));
        assert_eq!(timeout_for("session.open", &json!({})), Duration::from_secs(45));
        // two SSH hops + a proxy leg: each may use the whole connect timeout before the database
        let tunnel = json!({"profile": {"options": {"connectTimeoutSec": 10, "proxy": {"type": "http"}}, "ssh": {"hops": [{}, {}]}}});
        assert_eq!(timeout_for("session.test", &tunnel), Duration::from_secs(70));
    }

    #[test]
    fn restart_policy_crash_loop() {
        let mut p = RestartPolicy::new();
        let t0 = Instant::now();
        assert!(p.check(t0).is_ok());
        for i in 0..3 {
            p.record_exit(t0 + Duration::from_secs(i));
        }
        assert!(p.check(t0 + Duration::from_secs(5)).is_err());
        assert!(p.check(t0 + Duration::from_secs(40)).is_ok()); // cooldown over
    }

    #[test]
    fn launch_spec_paths_and_heap() {
        let dir = std::env::temp_dir().join(format!("tdb-launch-{}", std::process::id()));
        let java_name = if cfg!(windows) { "java.exe" } else { "java" };
        assert_eq!(resolve_launch(&dir, 512).unwrap_err().code, "E_SIDECAR_UNAVAILABLE");
        std::fs::create_dir_all(dir.join("resources/jre/bin")).unwrap();
        std::fs::create_dir_all(dir.join("resources/sidecar")).unwrap();
        std::fs::write(dir.join("resources/jre/bin").join(java_name), b"").unwrap();
        std::fs::write(dir.join("resources/sidecar/tabledb-jdbc.jar"), b"").unwrap();
        let s = resolve_launch(&dir, 384).unwrap();
        assert!(s.args.contains(&"-Xmx384m".to_string()) && s.args.contains(&"--stdio".to_string()));
        assert!(s.cwd.unwrap().ends_with("sidecar"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn custom_drivers_arg_appended() {
        let spec = resolve_launch_from("java".into(), "/x/tabledb-jdbc.jar".into(), 512).with_custom_drivers(Path::new("/data/drivers-custom"));
        let n = spec.args.len();
        assert_eq!(spec.args[n - 2], "--custom-drivers");
        assert_eq!(spec.args[n - 1], "/data/drivers-custom");
        assert!(spec.args.contains(&"--stdio".to_string()));
        let spec = spec.with_ssh_keys(Path::new("/data/ssh-keys"));
        let n = spec.args.len();
        assert_eq!(&spec.args[n - 4..], &["--custom-drivers", "/data/drivers-custom", "--ssh-keys", "/data/ssh-keys"]);
    }

    #[tokio::test]
    async fn internal_method_rejected_on_public_path() {
        struct Nop;
        impl EventSink for Nop {
            fn emit(&self, _ev: &SidecarEvent) {}
        }
        let mgr = SidecarManager::new(Err(AppError::new("E_SIDECAR_UNAVAILABLE", "x")), Arc::new(Nop));
        assert_eq!(mgr.request("drivers.reload", json!({})).await.unwrap_err().code, "E_BAD_REQUEST");
        // internal path passes the allowlist and only then fails on the missing launch spec
        assert_eq!(mgr.request_internal("drivers.reload", json!({})).await.unwrap_err().code, "E_SIDECAR_UNAVAILABLE");
        assert_eq!(mgr.request_internal("exec", json!({})).await.unwrap_err().code, "E_BAD_REQUEST");
    }

    #[test]
    fn sso_url_only_for_trino_sso_and_http() {
        let ev = |purpose: &str, url: &str| SidecarEvent {
            event: "auth.openUrl".into(),
            seq: 1,
            data: json!({"sessionId": "s", "url": url, "purpose": purpose}),
        };
        assert!(browser_url_for_event(&ev("trino-sso", "https://trino.example/oauth2/token/initiate/abc")).is_some());
        assert!(browser_url_for_event(&ev("other", "https://x.com")).is_none());
        assert!(browser_url_for_event(&ev("trino-sso", "file:///c:/x.exe")).is_none());
        assert!(browser_url_for_event(&ev("trino-sso", "javascript:1")).is_none());
        let mut e = ev("trino-sso", "https://x.com");
        e.event = "ready".into();
        assert!(browser_url_for_event(&e).is_none());
    }

    // ---- process-level tests with a fake sidecar (POSIX sh) ----
    #[cfg(unix)]
    mod process {
        use super::*;

        #[derive(Default)]
        struct Collect(StdMutex<Vec<SidecarEvent>>);
        impl EventSink for Collect {
            fn emit(&self, ev: &SidecarEvent) {
                self.0.lock().unwrap().push(ev.clone());
            }
        }

        fn sh(script: &str) -> Result<LaunchSpec, AppError> {
            Ok(LaunchSpec { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()], cwd: None })
        }

        const ECHO: &str = r#"echo '{"event":"ready","seq":0,"data":{"protocol":1}}';
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -e 's/^{"id":\([0-9]*\),.*/\1/')
  case "$line" in *slow*) sleep 3;; esac
  echo "{\"id\":$id,\"result\":{\"ok\":true}}"
done"#;

        #[tokio::test]
        async fn roundtrip_events_and_rejection() {
            let sink = Arc::new(Collect::default());
            let m = SidecarManager::new(sh(ECHO), sink.clone());
            let r = m.request("hello", json!({})).await.unwrap();
            assert_eq!(r, json!({"ok": true}));
            // concurrent requests are correlated independently
            let (a, b) = tokio::join!(m.request("meta.catalogs", json!({"sessionId": "s"})), m.request("meta.schemas", json!({"sessionId": "s"})));
            assert!(a.is_ok() && b.is_ok());
            assert_eq!(m.request("exec", json!({})).await.unwrap_err().code, "E_BAD_REQUEST");
            assert_eq!(m.request("hello", json!([1])).await.unwrap_err().code, "E_BAD_REQUEST");
            assert!(sink.0.lock().unwrap().iter().any(|e| e.event == "ready"));
            assert_eq!(m.ready_info(), Some(json!({"protocol": 1})));
            m.shutdown().await;
        }

        #[tokio::test]
        async fn timeout_returns_structured_error() {
            let m = SidecarManager::new(sh(ECHO), Arc::new(Collect::default()));
            let e = m.request_with_timeout("hello", json!({"slow": true}), Duration::from_millis(300)).await.unwrap_err();
            assert_eq!(e.code, "E_TIMEOUT");
            m.shutdown().await;
        }

        #[tokio::test]
        async fn fetch_timeout_sends_cursor_cancellation() {
            let sink = Arc::new(Collect::default());
            let script = r#"while IFS= read -r line; do
case "$line" in *query.cancel*cursorId*fetch-1*) echo '{"event":"cancel-observed","seq":1,"data":{}}';; esac
done"#;
            let m = SidecarManager::new(sh(script), sink.clone());
            assert_eq!(m.request_with_timeout("query.fetch", json!({"cursorId": "fetch-1"}), Duration::from_millis(50)).await.unwrap_err().code, "E_TIMEOUT");
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if sink.0.lock().unwrap().iter().any(|e| e.event == "cancel-observed") { break; }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.unwrap();
            m.shutdown().await;
        }

        #[tokio::test]
        async fn blocked_stdin_obeys_deadline_and_kills_generation() {
            let m = SidecarManager::new(sh("exec sleep 30"), Arc::new(Collect::default()));
            let result = tokio::time::timeout(Duration::from_secs(3),
                m.request_with_timeout("hello", json!({"payload": "x".repeat(1024 * 1024)}), Duration::from_millis(150))).await;
            assert_eq!(result.unwrap().unwrap_err().code, "E_TIMEOUT");
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if m.running.lock().await.is_none() { break; }
                    tokio::task::yield_now().await;
                }
            }).await.unwrap();
            assert_eq!(m.correlator.lock().unwrap().len(), 0);
            m.shutdown().await;
        }

        #[tokio::test]
        async fn crash_fails_pending_then_restarts() {
            // first process dies after the first request; the next request spawns a fresh one
            let script = "read -r line; exit 3";
            let m = SidecarManager::new(sh(script), Arc::new(Collect::default()));
            let e = m.request("hello", json!({})).await.unwrap_err();
            assert_eq!(e.code, "E_SIDECAR_EXITED");
            // a second call respawns (policy allows < 3 crashes)
            let e2 = m.request("hello", json!({})).await.unwrap_err();
            assert_eq!(e2.code, "E_SIDECAR_EXITED");
            m.shutdown().await;
        }

        #[tokio::test]
        async fn oversized_stdout_line_kills_sidecar() {
            // emit > 8 MiB without newline
            let script = r#"read -r line; head -c 9000000 /dev/zero | tr '\0' 'a'; sleep 5"#;
            let m = SidecarManager::new(sh(script), Arc::new(Collect::default()));
            let e = m.request_with_timeout("hello", json!({}), Duration::from_secs(10)).await.unwrap_err();
            assert_eq!(e.code, "E_SIDECAR_EXITED");
            m.shutdown().await;
        }

        #[tokio::test]
        async fn missing_binary_is_unavailable() {
            let m = SidecarManager::new(
                Ok(LaunchSpec { program: "/nonexistent/java".into(), args: vec![], cwd: None }),
                Arc::new(Collect::default()),
            );
            assert_eq!(m.request("hello", json!({})).await.unwrap_err().code, "E_SIDECAR_UNAVAILABLE");
        }
    }
}
