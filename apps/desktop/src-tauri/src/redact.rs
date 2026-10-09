//! Log redaction. Applied to every log line by the tauri-plugin-log formatter and to sidecar stderr.

use regex::Regex;
use std::sync::OnceLock;

struct Rules {
    bearer: Regex,
    kv: Regex,
    url_param: Regex,
    userinfo: Regex,
    jwt: Regex,
    cb_path: Regex,
    url_query: Regex,
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| Rules {
        bearer: Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{6,}").unwrap(),
        kv: Regex::new(
            r#"(?i)\b((?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|authorization|code_verifier|jwt|api_key|apikey|credential)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\]]+)"#,
        )
        .unwrap(),
        url_param: Regex::new(
            r"(?i)([?&](?:code|state|code_verifier|access_token|refresh_token|id_token|token|password|connectid)=)[^&\s#]+",
        )
        .unwrap(),
        userinfo: Regex::new(r"(?i)(://)[^/\s:@]+:[^/\s@]+@").unwrap(),
        jwt: Regex::new(r"eyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]*").unwrap(),
        cb_path: Regex::new(r"(?i)/cb(/|%2F)[A-Za-z0-9_\-]{16,}").unwrap(),
        url_query: Regex::new(r#"(?i)(https?://[^\s?"<>]+)\?[^\s"<>]+"#).unwrap(),
    })
}

pub const MASK: &str = "[REDACTED]";

pub fn redact(input: &str) -> String {
    let r = rules();
    let s = r.cb_path.replace_all(input, "/cb${1}[REDACTED]");
    let s = r.jwt.replace_all(&s, "[REDACTED_JWT]");
    let s = r.bearer.replace_all(&s, "$1 [REDACTED]");
    let s = r.userinfo.replace_all(&s, "${1}[REDACTED]@");
    let s = r.url_param.replace_all(&s, "${1}[REDACTED]");
    let s = r.kv.replace_all(&s, "${1}[REDACTED]");
    let s = r.url_query.replace_all(&s, "${1}?[REDACTED]");
    s.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_key_values() {
        let o = redact(r#"connect password=hunter2 user=bob"#);
        assert!(!o.contains("hunter2") && o.contains("user=bob"), "{o}");
        let o = redact(r#"{"password":"p@ss w0rd","host":"db"}"#);
        assert!(!o.contains("p@ss") && o.contains("\"host\":\"db\""), "{o}");
        let o = redact("refresh_token: abcdef123456");
        assert!(!o.contains("abcdef123456"), "{o}");
    }

    #[test]
    fn redacts_bearer_and_jwt() {
        let o = redact("Authorization: Bearer abc.def.ghi-123456");
        assert!(!o.contains("abc.def"), "{o}");
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig_nature1";
        let o = redact(&format!("got {jwt} ok"));
        assert!(!o.contains("eyJhbGci") && o.contains("ok"), "{o}");
    }

    #[test]
    fn redacts_url_params_and_userinfo() {
        let o = redact("GET /cb?code=AUTHCODE&state=STATE123 HTTP/1.1");
        assert!(!o.contains("AUTHCODE") && !o.contains("STATE123"), "{o}");
        let o = redact("jdbc at https://user:secretpw@host:5432/db");
        assert!(!o.contains("secretpw") && !o.contains("user:"), "{o}");
    }

    #[test]
    fn redacts_genai_callback_secret_and_token() {
        let sec = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
        let o = redact(&format!("GET /cb/{sec}/sso-callback?token=x.y.z HTTP/1.1"));
        assert!(!o.contains(sec) && !o.contains("x.y.z"), "{o}");
        let o = redact(&format!("open https://genai.vnpay.vn/create-jwt-token?connectid=5555%2Fcb%2F{sec}"));
        assert!(!o.contains(sec), "{o}");
        let o = redact(&format!("http://localhost:5555/cb/{sec}/sso-callback"));
        assert!(!o.contains(sec), "{o}");
    }

    #[test]
    fn leaves_innocuous_text() {
        let s = "sidecar started pid=42 sqlcode=17 method=query.execute";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn redacts_trino_http_log_query_strings() {
        let o = redact("<-- 302 https://trino.example/oauth2/callback?ticket=private-value&nonce=private-nonce (4ms)");
        assert_eq!(o, "<-- 302 https://trino.example/oauth2/callback?[REDACTED] (4ms)");
    }
}
