//! Desktop runtime config: `config.json` in the app config dir (%APPDATA%\vn.vnpay.tabledb on Windows),
//! with environment overrides. Contains no secrets.

use crate::error::AppError;
use crate::urlcheck::validate_endpoint;
use serde::{Deserialize, Serialize};

pub const SAMPLE: &str = include_str!("../config.sample.json");

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarConfig {
    #[serde(default = "default_heap")]
    pub max_heap_mb: u32,
}
fn default_heap() -> u32 {
    512
}
impl Default for SidecarConfig {
    fn default() -> Self {
        Self { max_heap_mb: default_heap() }
    }
}

/// One LLM endpoint the local Agent may call (replaces the admin-managed `agent_settings` of the old server-side Agent).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEndpoint {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Local Agent settings. Contains no secrets: tokens live in the OS credential store.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default)]
    pub endpoints: Vec<AgentEndpoint>,
    #[serde(default)]
    pub default_endpoint_id: Option<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    /// max characters of table metadata sent per prompt (1000..30000)
    #[serde(default = "default_budget")]
    pub budget_chars: u32,
    /// OpenMetadata MCP endpoint (optional); each user stores their own token. Env: TABLEDB_OPENMETADATA_MCP_URL.
    #[serde(default)]
    pub open_metadata_url: Option<String>,
    /// credential header of the LLM gateway / OpenMetadata
    #[serde(default = "default_auth_header")]
    pub auth_header: String,
    /// "" = send the bare token
    #[serde(default = "default_auth_scheme")]
    pub auth_scheme: String,
}
fn default_budget() -> u32 {
    12_000
}
fn default_auth_header() -> String {
    "Authorization".into()
}
fn default_auth_scheme() -> String {
    "Bearer".into()
}
impl Default for AgentConfig {
    fn default() -> Self {
        Self { endpoints: vec![], default_endpoint_id: None, default_model: None, budget_chars: default_budget(), open_metadata_url: None, auth_header: default_auth_header(), auth_scheme: default_auth_scheme() }
    }
}

impl AgentConfig {
    fn validate(&mut self, env: &str) -> Result<(), AppError> {
        let https_only = |u: &url::Url| env != "prod" || u.scheme() == "https";
        if self.endpoints.len() > 16 {
            return Err(AppError::bad_request("agent.endpoints: at most 16"));
        }
        for e in &mut self.endpoints {
            let id_ok = !e.id.is_empty() && e.id.len() <= 100 && e.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if !id_ok {
                return Err(AppError::bad_request("agent.endpoints[].id must match [a-z0-9-]+"));
            }
            if e.label.trim().is_empty() || e.label.len() > 100 {
                return Err(AppError::bad_request("agent.endpoints[].label is required (max 100)"));
            }
            if e.models.is_empty() || e.models.len() > 50 || e.models.iter().any(|m| m.is_empty() || m.len() > 100) {
                return Err(AppError::bad_request("agent.endpoints[].models must list 1..50 model names"));
            }
            let u = validate_endpoint(&e.base_url)?;
            if !https_only(&u) {
                return Err(AppError::bad_request("agent endpoints must use https in prod"));
            }
            e.base_url = e.base_url.trim_end_matches('/').to_string();
        }
        let mut seen = std::collections::HashSet::new();
        if !self.endpoints.iter().all(|e| seen.insert(e.id.clone())) {
            return Err(AppError::bad_request("agent.endpoints: duplicate id"));
        }
        if !(1000..=30_000).contains(&self.budget_chars) {
            return Err(AppError::bad_request("agent.budgetChars must be within 1000..30000"));
        }
        if let Some(u) = &self.open_metadata_url {
            if u.trim().is_empty() {
                self.open_metadata_url = None;
            } else {
                let parsed = validate_endpoint(u.trim())?;
                if !https_only(&parsed) {
                    return Err(AppError::bad_request("agent.openMetadataUrl must use https in prod"));
                }
                self.open_metadata_url = Some(u.trim().trim_end_matches('/').to_string());
            }
        }
        let name_ok = !self.auth_header.is_empty() && self.auth_header.len() <= 64 && self.auth_header.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !name_ok || matches!(self.auth_header.to_ascii_lowercase().as_str(), "host" | "cookie" | "content-length" | "content-type") {
            return Err(AppError::bad_request("agent.authHeader invalid"));
        }
        if self.auth_scheme.len() > 32 || self.auth_scheme.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(AppError::bad_request("agent.authScheme invalid"));
        }
        Ok(())
    }
}

/// Which browser hosts the VNPAY SSO login.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GenaiBrowser {
    /// In-app webview window (uses `proxy.url`); no loopback listener.
    #[default]
    Internal,
    /// System browser + loopback listener (fallback, e.g. Google "disallowed_useragent").
    System,
}

impl GenaiBrowser {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "internal" => Some(Self::Internal),
            "system" => Some(Self::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// "test" | "prod". Also namespaces the credential-manager service name.
    #[serde(default = "default_env")]
    pub env: String,
    #[serde(default)]
    pub api_base_url: String,
    #[serde(default)]
    pub proxy: ProxyConfig,
    #[serde(default)]
    pub sidecar: SidecarConfig,
    /// Allow-list of https origins accepted as `loginUrl` for the VNPAY SSO broker login.
    #[serde(default = "default_genai_origins")]
    pub genai_login_origins: Vec<String>,
    /// OPT-IN: use CONNECTID `<port>/cb/<S>` (secret callback path). Enable only after genai validates connectid
    /// with a regex that allows this form. Default false = `<port>` only, callback `/sso-callback`.
    #[serde(default)]
    pub genai_secret_path: bool,
    /// Keep the IdP cookies of the internal login window in a dedicated profile dir (default true). Env: TABLEDB_GENAI_PERSIST_SSO=0/1.
    #[serde(default = "default_true")]
    pub genai_persist_sso: bool,
    /// `internal` (default) or `system`. Env: TABLEDB_GENAI_BROWSER.
    #[serde(default)]
    pub genai_login_browser: GenaiBrowser,
    /// Local Agent (LLM endpoints, OpenMetadata MCP). The Agent runs in this app, not on the API server.
    #[serde(default)]
    pub agent: AgentConfig,
}
fn default_true() -> bool {
    true
}
fn default_genai_origins() -> Vec<String> {
    vec![crate::genai::DEFAULT_ORIGIN.to_string()]
}
fn default_env() -> String {
    "prod".into()
}
impl Default for AppConfig {
    fn default() -> Self {
        Self { env: default_env(), api_base_url: String::new(), proxy: ProxyConfig::default(), sidecar: SidecarConfig::default(), genai_login_origins: default_genai_origins(), genai_secret_path: false, genai_persist_sso: true, genai_login_browser: GenaiBrowser::Internal, agent: AgentConfig::default() }
    }
}

/// Env overrides: TABLEDB_GENAI_PERSIST_SSO, TABLEDB_GENAI_BROWSER, TABLEDB_GENAI_SECRET_PATH, TABLEDB_ENV, TABLEDB_API_BASE_URL, TABLEDB_PROXY_URL.
pub trait EnvSource {
    fn get(&self, key: &str) -> Option<String>;
}
pub struct OsEnv;
impl EnvSource for OsEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.trim().is_empty())
    }
}

impl AppConfig {
    pub fn parse(json: &str) -> Result<Self, AppError> {
        serde_json::from_str(json).map_err(|e| AppError::bad_request(format!("config.json invalid: {e}")))
    }

    pub fn apply_env(&mut self, env: &dyn EnvSource) {
        if let Some(v) = env.get("TABLEDB_ENV") {
            self.env = v.trim().to_string();
        }
        if let Some(v) = env.get("TABLEDB_API_BASE_URL") {
            self.api_base_url = v.trim().to_string();
        }
        if let Some(v) = env.get("TABLEDB_GENAI_BROWSER") {
            if let Some(b) = GenaiBrowser::parse(&v) {
                self.genai_login_browser = b;
            } // invalid values are ignored (keeps the file/default value)
        }
        if let Some(v) = env.get("TABLEDB_GENAI_PERSIST_SSO") {
            self.genai_persist_sso = !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off");
        }
        if let Some(v) = env.get("TABLEDB_GENAI_SECRET_PATH") {
            self.genai_secret_path = matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on");
        }
        if let Some(v) = env.get("TABLEDB_OPENMETADATA_MCP_URL") {
            self.agent.open_metadata_url = Some(v.trim().to_string());
        }
        if let Some(v) = env.get("TABLEDB_PROXY_URL") {
            self.proxy.url = Some(v.trim().to_string());
        }
    }

    pub fn validate(&mut self) -> Result<(), AppError> {
        if self.env != "test" && self.env != "prod" {
            return Err(AppError::bad_request("config env must be \"test\" or \"prod\""));
        }
        if self.api_base_url.is_empty() {
            return Err(AppError::bad_request("config apiBaseUrl is required"));
        }
        crate::urlcheck::validate_api_endpoint(&self.api_base_url)?;
        self.api_base_url = self.api_base_url.trim_end_matches('/').to_string();
        if let Some(p) = &self.proxy.url {
            if p.is_empty() {
                self.proxy.url = None;
            } else {
                let u = url::Url::parse(p).map_err(|_| AppError::bad_request("proxy.url malformed"))?;
                if !matches!(u.scheme(), "http" | "https" | "socks5") || u.host_str().is_none() {
                    return Err(AppError::bad_request("proxy.url must be http(s):// or socks5://"));
                }
            }
        }
        if !(128..=4096).contains(&self.sidecar.max_heap_mb) {
            return Err(AppError::bad_request("sidecar.maxHeapMb must be within 128..4096"));
        }
        if self.genai_login_origins.is_empty() || self.genai_login_origins.len() > 8 {
            return Err(AppError::bad_request("genaiLoginOrigins must list 1..8 https origins"));
        }
        self.genai_login_origins =
            self.genai_login_origins.iter().map(|o| crate::genai::normalize_origin(o)).collect::<Result<Vec<_>, _>>()?;
        let env = self.env.clone();
        self.agent.validate(&env)?;
        Ok(())
    }

    /// file content (None = missing) + env -> validated config.
    pub fn resolve(file: Option<&str>, env: &dyn EnvSource) -> Result<Self, AppError> {
        let mut cfg = match file {
            Some(s) => Self::parse(s)?,
            None => Self::default(),
        };
        cfg.apply_env(env);
        cfg.validate()?;
        Ok(cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Fake(HashMap<&'static str, &'static str>);
    impl EnvSource for Fake {
        fn get(&self, k: &str) -> Option<String> {
            self.0.get(k).map(|s| s.to_string())
        }
    }

    #[test]
    fn sample_is_valid() {
        let c = AppConfig::resolve(Some(SAMPLE), &Fake(HashMap::new())).unwrap();
        assert_eq!(c.env, "test");
        assert!(c.proxy.url.is_none());
    }

    #[test]
    fn env_overrides_file() {
        let env = Fake(HashMap::from([("TABLEDB_ENV", "prod"), ("TABLEDB_API_BASE_URL", "https://api.vnpay.vn/"), ("TABLEDB_PROXY_URL", "http://proxy:8080")]));
        let c = AppConfig::resolve(Some(SAMPLE), &env).unwrap();
        assert_eq!(c.env, "prod");
        assert_eq!(c.api_base_url, "https://api.vnpay.vn");
        assert_eq!(c.proxy.url.as_deref(), Some("http://proxy:8080"));
    }

    #[test]
    fn rejects_bad_values() {
        let none = Fake(HashMap::new());
        assert!(AppConfig::resolve(None, &none).is_err()); // no apiBaseUrl
        assert!(AppConfig::resolve(Some(r#"{"env":"dev","apiBaseUrl":"https://a.com"}"#), &none).is_err());
        assert!(AppConfig::resolve(Some(r#"{"apiBaseUrl":"http://a.com"}"#), &none).is_err());
        assert!(AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com","proxy":{"url":"ftp://p"}}"#), &none).is_err());
        assert!(AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com","sidecar":{"maxHeapMb":8}}"#), &none).is_err());
        assert!(AppConfig::resolve(Some("{oops"), &none).is_err());
        assert!(AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com","genaiLoginOrigins":["http://g.com"]}"#), &none).is_err());
        assert!(AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com","genaiLoginOrigins":[]}"#), &none).is_err());
    }

    #[test]
    fn genai_persist_sso_default_file_env() {
        let base = r#"{"apiBaseUrl":"https://a.com"}"#;
        assert!(AppConfig::resolve(Some(base), &Fake(HashMap::new())).unwrap().genai_persist_sso);
        assert!(!AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com","genaiPersistSso":false}"#), &Fake(HashMap::new())).unwrap().genai_persist_sso);
        assert!(!AppConfig::resolve(Some(base), &Fake(HashMap::from([("TABLEDB_GENAI_PERSIST_SSO", "0")]))).unwrap().genai_persist_sso);
        assert!(AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com","genaiPersistSso":false}"#), &Fake(HashMap::from([("TABLEDB_GENAI_PERSIST_SSO", "1")]))).unwrap().genai_persist_sso);
    }

    #[test]
    fn genai_browser_default_file_env() {
        let base = r#"{"apiBaseUrl":"https://a.com"}"#;
        let none = Fake(HashMap::new());
        assert_eq!(AppConfig::resolve(Some(base), &none).unwrap().genai_login_browser, GenaiBrowser::Internal);
        let sys = r#"{"apiBaseUrl":"https://a.com","genaiLoginBrowser":"system"}"#;
        assert_eq!(AppConfig::resolve(Some(sys), &none).unwrap().genai_login_browser, GenaiBrowser::System);
        let env = Fake(HashMap::from([("TABLEDB_GENAI_BROWSER", "SYSTEM")]));
        assert_eq!(AppConfig::resolve(Some(base), &env).unwrap().genai_login_browser, GenaiBrowser::System);
        let env = Fake(HashMap::from([("TABLEDB_GENAI_BROWSER", "internal")]));
        assert_eq!(AppConfig::resolve(Some(sys), &env).unwrap().genai_login_browser, GenaiBrowser::Internal);
        assert!(AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com","genaiLoginBrowser":"chrome"}"#), &none).is_err());
    }

    #[test]
    fn genai_secret_path_default_off_and_env_opt_in() {
        let c = AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com"}"#), &Fake(HashMap::new())).unwrap();
        assert!(!c.genai_secret_path);
        let c = AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com"}"#), &Fake(HashMap::from([("TABLEDB_GENAI_SECRET_PATH", "1")]))).unwrap();
        assert!(c.genai_secret_path);
        let c = AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com","genaiSecretPath":true}"#), &Fake(HashMap::new())).unwrap();
        assert!(c.genai_secret_path);
    }

    #[test]
    fn agent_config_defaults_and_validation() {
        let none = Fake(HashMap::new());
        let c = AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com"}"#), &none).unwrap();
        assert!(c.agent.endpoints.is_empty());
        assert_eq!(c.agent.budget_chars, 12_000);
        assert_eq!((c.agent.auth_header.as_str(), c.agent.auth_scheme.as_str()), ("Authorization", "Bearer"));
        let ok = r#"{"apiBaseUrl":"https://a.com","agent":{"endpoints":[{"id":"gw-1","label":"GW","baseUrl":"https://g.vn/v1/","models":["m1"]}],"defaultEndpointId":"gw-1","defaultModel":"m1","openMetadataUrl":"https://om.vn/mcp/"}}"#;
        let c = AppConfig::resolve(Some(ok), &none).unwrap();
        assert_eq!(c.agent.endpoints[0].base_url, "https://g.vn/v1");
        assert_eq!(c.agent.open_metadata_url.as_deref(), Some("https://om.vn/mcp"));
        let env = Fake(HashMap::from([("TABLEDB_OPENMETADATA_MCP_URL", "https://om2.vn/mcp")]));
        assert_eq!(AppConfig::resolve(Some(ok), &env).unwrap().agent.open_metadata_url.as_deref(), Some("https://om2.vn/mcp"));
        let bad = |agent: &str| AppConfig::resolve(Some(&format!(r#"{{"apiBaseUrl":"https://a.com","agent":{agent}}}"#)), &none).is_err();
        assert!(bad(r#"{"endpoints":[{"id":"BAD","label":"x","baseUrl":"https://g.vn","models":["m"]}]}"#));
        assert!(bad(r#"{"endpoints":[{"id":"a","label":"x","baseUrl":"http://g.vn","models":["m"]}]}"#)); // http not loopback
        assert!(bad(r#"{"endpoints":[{"id":"a","label":"x","baseUrl":"https://g.vn","models":[]}]}"#));
        assert!(bad(r#"{"endpoints":[{"id":"a","label":"x","baseUrl":"https://g.vn","models":["m"]},{"id":"a","label":"y","baseUrl":"https://g.vn","models":["m"]}]}"#));
        assert!(bad(r#"{"budgetChars":10}"#));
        assert!(bad(r#"{"authHeader":"Host"}"#));
        assert!(bad(r#"{"openMetadataUrl":"ftp://om"}"#));
    }

    #[test]
    fn genai_origins_default_and_override() {
        let none = Fake(HashMap::new());
        let c = AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com"}"#), &none).unwrap();
        assert_eq!(c.genai_login_origins, vec!["https://genai.vnpay.vn".to_string()]);
        let c = AppConfig::resolve(Some(r#"{"apiBaseUrl":"https://a.com","genaiLoginOrigins":["https://g.test.vn/"]}"#), &none).unwrap();
        assert_eq!(c.genai_login_origins, vec!["https://g.test.vn".to_string()]);
    }
}
