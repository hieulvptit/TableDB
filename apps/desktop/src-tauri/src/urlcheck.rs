//! URL validation for anything handed to the system browser or used as an OIDC / API endpoint.

use crate::error::AppError;
use url::{Host, Url};

const MAX_URL_LEN: usize = 4096;

fn basic(raw: &str) -> Result<Url, AppError> {
    if raw.is_empty() || raw.len() > MAX_URL_LEN {
        return Err(AppError::bad_request("invalid url length"));
    }
    // The `url` crate silently strips tab/newline; reject control chars and whitespace up front.
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(AppError::bad_request("url contains control or whitespace characters"));
    }
    let u = Url::parse(raw).map_err(|_| AppError::bad_request("malformed url"))?;
    if u.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return Err(AppError::bad_request("url has no host"));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(AppError::bad_request("url must not contain credentials"));
    }
    Ok(u)
}

/// http/https only. Used for `open_external` and sidecar `auth.openUrl`.
pub fn validate_external_url(raw: &str) -> Result<Url, AppError> {
    let u = basic(raw)?;
    match u.scheme() {
        "http" | "https" => Ok(u),
        _ => Err(AppError::bad_request("only http/https urls are allowed")),
    }
}

pub fn is_loopback_host(u: &Url) -> bool {
    match u.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// https required; plain http only for loopback (local dev). Used for API base URL and OIDC authorize endpoint.
pub fn validate_endpoint(raw: &str) -> Result<Url, AppError> {
    let u = validate_external_url(raw)?;
    if u.scheme() == "http" && !is_loopback_host(&u) {
        return Err(AppError::bad_request("endpoint must use https (http allowed only for loopback)"));
    }
    Ok(u)
}

/// `scheme://host[:port]` of a URL (what a CSP source expression looks like).
pub fn origin_string(u: &Url) -> String {
    u.origin().ascii_serialization()
}

/// Does the CSP `connect-src` (or default-src fallback) list `origin`?
pub fn csp_allows_origin(csp: &str, origin: &str) -> bool {
    let mut default_src: Option<&str> = None;
    for d in csp.split(';') {
        let d = d.trim();
        if let Some(rest) = d.strip_prefix("connect-src") {
            return rest.split_whitespace().any(|s| s == origin || s == "*");
        }
        if let Some(rest) = d.strip_prefix("default-src") {
            default_src = Some(rest);
        }
    }
    default_src.map(|r| r.split_whitespace().any(|s| s == origin || s == "*")).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_https() {
        assert!(validate_external_url("https://example.com/a?b=1").is_ok());
        assert!(validate_external_url("http://127.0.0.1:8080/x").is_ok());
    }

    #[test]
    fn rejects_other_schemes_and_junk() {
        for bad in [
            "file:///C:/Windows/system32/calc.exe",
            "javascript:alert(1)",
            "ms-msdt:/id",
            "data:text/html,hi",
            "ftp://x/y",
            "https://user:pw@host/",
            "https://",
            "not a url",
            "https://exa mple.com",
            "https://example.com/\r\nX: y",
            "",
        ] {
            assert!(validate_external_url(bad).is_err(), "should reject {bad:?}");
        }
        assert!(validate_external_url(&format!("https://a.com/{}", "a".repeat(5000))).is_err());
    }

    #[test]
    fn endpoint_requires_https_except_loopback() {
        assert!(validate_endpoint("https://s2o.vnpay.vn/authorize").is_ok());
        assert!(validate_endpoint("http://localhost:3000").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:3000").is_ok());
        assert!(validate_endpoint("http://api.vnpay.vn").is_err());
    }

    #[test]
    fn csp_origin_check() {
        let csp = "default-src 'self'; connect-src 'self' ipc: https://api.example.com";
        assert!(csp_allows_origin(csp, "https://api.example.com"));
        assert!(!csp_allows_origin(csp, "https://evil.com"));
        assert!(csp_allows_origin("default-src https://a.com", "https://a.com"));
        assert!(!csp_allows_origin("script-src 'self'", "https://a.com"));
    }

    #[test]
    fn origin_string_strips_path() {
        let u = Url::parse("https://api.example.com:8443/v1/x").unwrap();
        assert_eq!(origin_string(&u), "https://api.example.com:8443");
    }
}
