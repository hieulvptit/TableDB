//! A connection-scoped HTTP proxy shared by the Trino driver and its SSO browser.
use crate::{error::AppError, login_proxy::{self, Credentials, LoginBrowser, LoginProxy}};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, path::Path};
use url::Url;

struct Route {
    bridge: LoginProxy,
    browsers: Vec<LoginBrowser>,
    pending: usize,
    sessions: HashSet<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(host: &str, tls: bool) -> Value {
        json!({"profile":{"driver":"trino","host":host,"port":443,"auth":{"type":"password","username":"u","password":"db-password"},
            "options":{"ssl":tls,"proxy":{"type":"http","host":"10.23.5.189","port":3359,"username":"de_team","password":"proxy-password"}}}})
    }

    #[tokio::test]
    async fn driver_gets_credential_free_bridge_and_routes_live_until_last_session_closes() {
        let mut routes = TrinoRoutes::default();
        let mut first = request("query-engine-staging.vnpayapi.vn", true);
        let key = routes.prepare("session.open", &mut first).await.unwrap().unwrap();
        assert_eq!(first.pointer("/profile/options/proxy/host").unwrap(), "127.0.0.1");
        assert!(first.pointer("/profile/options/proxy/password").is_none());
        assert!(first.pointer("/profile/options/proxy/username").is_none());
        let mut second = request("other.vnpayapi.vn", true);
        assert_eq!(routes.prepare("session.open", &mut second).await.unwrap(), Some(key.clone()));
        routes.finish(&key, "session.open", &Ok(json!({"sessionId":"s1"})));
        routes.finish(&key, "session.open", &Ok(json!({"sessionId":"s2"})));
        routes.close(Some("s1"));
        assert_eq!(routes.routes.len(), 1);
        routes.close(Some("s2"));
        assert!(routes.routes.is_empty());
    }

    #[tokio::test]
    async fn tests_and_failed_connects_release_bridge_and_plain_http_api_is_direct() {
        let mut routes = TrinoRoutes::default();
        let mut test = request("query-engine-staging.vnpayapi.vn", true);
        let key = routes.prepare("session.test", &mut test).await.unwrap().unwrap();
        routes.finish(&key, "session.test", &Ok(json!({"ok":true})));
        assert!(routes.routes.is_empty());
        let key = routes.prepare("session.open", &mut request("query-engine-staging.vnpayapi.vn", true)).await.unwrap().unwrap();
        routes.finish(&key, "session.open", &Err(AppError::new("E_CONN", "failed")));
        assert!(routes.routes.is_empty());
        let mut plain = request("query-engine-staging.vnpayapi.vn", false);
        assert!(routes.prepare("session.open", &mut plain).await.unwrap().is_none());
        assert!(plain.pointer("/profile/options/proxy").is_none());
    }

    #[tokio::test]
    async fn trino_sso_forces_bridge_even_for_old_ssl_false_profile() {
        let mut routes = TrinoRoutes::default();
        let mut p = request("query-engine-staging.vnpayapi.vn", false);
        p["profile"]["auth"] = json!({"type":"trino-external"});
        assert!(routes.prepare("session.test", &mut p).await.unwrap().is_some());
        assert!(routes.open_browser(&Url::parse("https://s2o.vnpay.vn/").unwrap(), "http://127.0.0.1:1/", Path::new(".")).unwrap() == false);
    }
}

#[derive(Default)]
pub struct TrinoRoutes { routes: HashMap<String, Route> }

impl TrinoRoutes {
    /// Called after native credentials are resolved. The driver receives only a loopback proxy without credentials.
    pub async fn prepare(&mut self, method: &str, params: &mut Value) -> Result<Option<String>, AppError> {
        if !matches!(method, "session.open" | "session.test")
            || params.pointer("/profile/driver").and_then(Value::as_str) != Some("trino")
            || params.pointer("/profile/ssh").is_some_and(|v| !v.is_null()) { return Ok(None); }
        let Some(proxy) = params.pointer("/profile/options/proxy").filter(|v| v.is_object()).cloned() else { return Ok(None); };
        if proxy.get("type").and_then(Value::as_str) != Some("http") { return Ok(None); }
        let host = params.pointer("/profile/host").and_then(Value::as_str).ok_or_else(|| AppError::bad_request("Trino host is required"))?.to_string();
        let port = params.pointer("/profile/port").and_then(Value::as_u64).unwrap_or(8080);
        let port = u16::try_from(port).ok().filter(|p| *p != 0).ok_or_else(|| AppError::bad_request("invalid Trino port"))?;
        let tls = params.pointer("/profile/options/ssl").and_then(Value::as_bool) == Some(true)
            || params.pointer("/profile/auth/type").and_then(Value::as_str) == Some("trino-external");
        if !tls {
            if login_proxy::direct_api_host(&host) {
                params.pointer_mut("/profile/options").unwrap().as_object_mut().unwrap().remove("proxy");
                log::info!("Trino route=direct destination={host}:{port}");
            }
            return Ok(None);
        }
        let upstream_host = proxy.get("host").and_then(Value::as_str).ok_or_else(|| AppError::bad_request("proxy host is required"))?;
        let upstream_port = proxy.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0)
            .ok_or_else(|| AppError::bad_request("invalid proxy port"))?;
        let upstream = login_proxy::validate_proxy(&format!("http://{upstream_host}:{upstream_port}"))?;
        let credentials = match proxy.get("username").and_then(Value::as_str).filter(|u| !u.is_empty()) {
            Some(username) => {
                let password = proxy.get("password").and_then(Value::as_str).unwrap_or("");
                if username.len() > 255 || password.len() > 255 || username.chars().any(char::is_control) || password.chars().any(char::is_control) {
                    return Err(AppError::bad_request("invalid proxy credentials"));
                }
                Some(Credentials { username: username.into(), password: password.into() })
            }
            None => None,
        };
        let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&proxy).unwrap()));
        if !self.routes.contains_key(&key) {
            if self.routes.len() >= 64 { return Err(AppError::new("E_LIMIT", "too many active Trino proxy routes")); }
            let bridge = LoginProxy::start(upstream, credentials, &[]).await?;
            self.routes.insert(key.clone(), Route { bridge, browsers: vec![], pending: 0, sessions: HashSet::new() });
        }
        let route = self.routes.get_mut(&key).unwrap();
        if let Err(error) = route.bridge.allow_coordinator(&host, port) { self.prune(); return Err(error); }
        route.pending += 1;
        *params.pointer_mut("/profile/options/proxy").unwrap() = json!({"type":"http","host":"127.0.0.1","port":route.bridge.url.port().unwrap()});
        log::info!("Trino split routing configured destination={host}:{port} coordinator_route={} sso_route=proxy",
            if login_proxy::direct_api_host(&host) { "direct" } else { "proxy" });
        Ok(Some(key))
    }

    pub fn finish(&mut self, key: &str, method: &str, result: &Result<Value, AppError>) {
        if let Some(route) = self.routes.get_mut(key) {
            route.pending = route.pending.saturating_sub(1);
            if method == "session.open" {
                if let Ok(value) = result {
                    if let Some(id) = value.get("sessionId").and_then(Value::as_str) { route.sessions.insert(id.into()); }
                }
            }
        }
        self.prune();
    }

    pub fn close(&mut self, session: Option<&str>) {
        for route in self.routes.values_mut() {
            if let Some(id) = session { route.sessions.remove(id); } else { route.sessions.clear(); }
        }
        self.prune();
    }

    fn prune(&mut self) { self.routes.retain(|_, route| route.pending != 0 || !route.sessions.is_empty()); }

    /// A sidecar event can select only a bridge already owned by a live/pending Trino connection.
    pub fn open_browser(&mut self, url: &Url, proxy_url: &str, profiles: &Path) -> Result<bool, AppError> {
        let Some(route) = self.routes.values_mut().find(|r| r.bridge.url.as_str() == proxy_url) else { return Ok(false); };
        route.browsers.retain_mut(LoginBrowser::running);
        let profile = profiles.join(format!("trino-sso-{}", route.bridge.url.port().unwrap()));
        route.browsers.push(login_proxy::open_browser(url.as_str(), &route.bridge.url, &profile, false)?);
        Ok(true)
    }
}
