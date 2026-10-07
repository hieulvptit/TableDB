package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func prod() map[string]string {
	return map[string]string{"APP_ENV": "prod", "DATABASE_URL": "postgres://x", "DATA_KEY": "k", "PUBLIC_URL": "https://bo.vnpay.vn",
		"HRM_BASE_URL": "https://hrm.example/dataservice", "HRM_SIGNATURE_SECRET": "s",
		"OIDC_PROVIDERS": `[{"id":"a","label":"a","issuer":"https://i.example","clientId":"c"}]`}
}

func with(m map[string]string, kv ...string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	for i := 0; i < len(kv); i += 2 {
		if kv[i+1] == "" {
			delete(out, kv[i])
		} else {
			out[kv[i]] = kv[i+1]
		}
	}
	return out
}

func TestDefaults(t *testing.T) {
	c, err := Load(map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if c.Env != "dev" || c.Host != "127.0.0.1" || c.Port != 8080 || c.PublicURL != "http://localhost:8080" || c.StorageDir != filepath.Join(c.BaseDir, "data", "files") ||
		c.MaxUploadBytes != 2<<30 || c.PartBytes != 8<<20 || c.TicketTTLHours != 72 || c.ApprovalWindowHours != 168 || c.MaxDownloads != 3 ||
		c.DownloadReauthMaxAgeSec != 300 || c.SessionTTLHours != 12 || c.LoginRateLimitPerMin != 10 || c.SMTP.Port != 587 || c.SMTP.TLS != "starttls" ||
		c.Genai.EmailPath != "email" || c.Genai.NamePath != "userFullName" || c.AllowDevLogin || c.TrustProxy {
		t.Fatalf("defaults: %+v", c)
	}
	if len(c.OidcProviders) != 0 || len(c.OutboundProxies) != 0 || len(c.AllowedExtensions) != 0 {
		t.Fatalf("collections: %+v", c)
	}
}

func TestLogLevelConfiguration(t *testing.T) {
	for _, level := range []string{"debug", "info", "warn", "error", "DEBUG"} {
		cfg, err := Load(map[string]string{"LOG_LEVEL": level})
		if err != nil || cfg.LogLevel != strings.ToLower(level) {
			t.Fatalf("log level %q: %v", level, err)
		}
	}
	if _, err := Load(map[string]string{"LOG_LEVEL": "trace"}); err == nil {
		t.Fatal("invalid log level accepted")
	}
}

func TestPIIConfiguration(t *testing.T) {
	c, err := Load(with(prod(), "PII_ENABLED", "1", "PII_LLM_URL", "https://genai.vnpay.vn/aigateway/llm_kimi/v1/chat/completions"))
	if err != nil || !c.PII.Enabled || c.PII.SampleLines != 20 || c.PII.ChunkChars != 12000 {
		t.Fatalf("PII configuration invalid: %v", err)
	}
	// Missing key does not prevent the API from starting; PII is an optional helper for approval.
	for _, kv := range [][]string{{"PII_SAMPLE_LINES", "1001"}, {"PII_ENABLED", "1"}, {"PII_ENABLED", "1", "PII_LLM_URL", "http://genai.vnpay.vn/chat"}, {"PII_MAX_FILE_BYTES", "999999999"}, {"PII_CHUNK_CHARS", "64"}} {
		if _, err := Load(with(prod(), kv...)); err == nil {
			t.Fatalf("accepted invalid PII config %v", kv)
		}
	}
}

func TestParsing(t *testing.T) {
	c, err := Load(map[string]string{
		"PUBLIC_URL": "https://bo.example/", "ALLOWED_EXTENSIONS": " ZIP, 7z ,,csv", "BOOTSTRAP_ADMINS": "A@vnpay.vn, b@vnpay.vn", "ALLOWED_EMAIL_DOMAINS": "VNPAY.vn",
		"OUTBOUND_PROXIES": `{"oidc":"http://p:8080","llm":""}`, "TRUST_PROXY": "1", "CORS_ORIGINS": "http://localhost:5173, tauri://localhost",
		"HRM_BASE_URL": "https://hrm.example/dataservice/", "OIDC_PROVIDERS": `[{"id":"s2o","label":"S","issuer":"https://i","clientId":"c","scopes":["openid"]},{"id":"g","label":"G","issuer":"https://g","clientId":"c2"}]`,
		"ALLOW_DEV_LOGIN": "1", "PORT": "9000", "MAX_UPLOAD_BYTES": "1024", "SMTP_TLS": "implicit", "RATE_LIMIT_LOGIN_PER_MIN": "3",
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicURL != "https://bo.example" || !c.IsHTTPS() || c.Port != 9000 || c.MaxUploadBytes != 1024 || c.SMTP.TLS != "implicit" || c.LoginRateLimitPerMin != 3 {
		t.Fatalf("%+v", c)
	}
	if strings.Join(c.AllowedExtensions, ",") != "zip,7z,csv" || strings.Join(c.BootstrapAdmins, ",") != "a@vnpay.vn,b@vnpay.vn" || strings.Join(c.Genai.AllowedEmailDomains, ",") != "vnpay.vn" {
		t.Fatalf("lists: %v %v %v", c.AllowedExtensions, c.BootstrapAdmins, c.Genai.AllowedEmailDomains)
	}
	if c.OutboundProxies["oidc"] != "http://p:8080" || !c.TrustProxy || len(c.CorsOrigins) != 2 || c.HRM.BaseURL != "https://hrm.example/dataservice" {
		t.Fatalf("misc: %+v", c)
	}
	if strings.Join(c.OidcProviders[0].Scopes, " ") != "openid" || strings.Join(c.OidcProviders[1].Scopes, " ") != "openid email profile" {
		t.Fatalf("scopes: %v / %v", c.OidcProviders[0].Scopes, c.OidcProviders[1].Scopes)
	}
	if c.Provider("g") == nil || c.Provider("nope") != nil {
		t.Fatal("Provider lookup")
	}
}

func TestInvalidInputs(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"APP_ENV":      {"APP_ENV": "staging"},
		"PORT":         {"PORT": "abc"},
		"PUBLIC_URL":   {"PUBLIC_URL": "not a url"},
		"SMTP_TLS":     {"SMTP_TLS": "maybe"},
		"OIDC json":    {"OIDC_PROVIDERS": "{"},
		"OIDC issuer":  {"OIDC_PROVIDERS": `[{"id":"a","label":"a","issuer":"nope","clientId":"c"}]`},
		"proxies json": {"OUTBOUND_PROXIES": "[1"},
		"GENAI url":    {"GENAI_VERIFY_URL": "::"},
	} {
		if _, err := Load(env); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestProdValidation(t *testing.T) {
	if _, err := Load(prod()); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"dev login", with(prod(), "ALLOW_DEV_LOGIN", "1"), "ALLOW_DEV_LOGIN"},
		{"dev mail", with(prod(), "DEV_LOG_MAIL", "1"), "DEV_LOG_MAIL"},
		{"genai trust", with(prod(), "GENAI_DEV_TRUST_UNVERIFIED", "1"), "GENAI_DEV_TRUST_UNVERIFIED"},
		{"http public", with(prod(), "PUBLIC_URL", "http://bo"), "https"},
		{"no data key", with(prod(), "DATA_KEY", ""), "DATA_KEY"},
		{"no database", with(prod(), "DATABASE_URL", ""), "DATABASE_URL"},
		{"no oidc", with(prod(), "OIDC_PROVIDERS", "[]"), "OIDC"},
		{"cors star", with(prod(), "CORS_ORIGINS", "*"), "CORS_ORIGINS"},
		{"cors http", with(prod(), "CORS_ORIGINS", "http://evil.example"), "CORS_ORIGINS"},
		{"genai http", with(prod(), "GENAI_LOGIN_URL", "http://g", "ALLOWED_EMAIL_DOMAINS", "vnpay.vn"), "https"},
		{"genai no domains", with(prod(), "GENAI_JWT_KEY", "a2V5"), "ALLOWED_EMAIL_DOMAINS"},
		{"no hrm", with(prod(), "HRM_BASE_URL", ""), "HRM_BASE_URL"},
		{"no hrm secret", with(prod(), "HRM_SIGNATURE_SECRET", ""), "HRM_SIGNATURE_SECRET"},
		{"hrm http", with(prod(), "HRM_BASE_URL", "http://h/dataservice"), "HRM_BASE_URL must be https"},
		{"smtp none", with(prod(), "SMTP_TLS", "none"), "SMTP_TLS=none"},
	}
	for _, c := range cases {
		_, err := Load(c.env)
		if err == nil || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "invalid prod configuration") {
			t.Errorf("%s: err=%v, want mention of %q", c.name, err, c.want)
		}
	}
	// all problems are reported together
	_, err := Load(with(prod(), "ALLOW_DEV_LOGIN", "1", "HRM_BASE_URL", "", "SMTP_TLS", "none"))
	if err == nil || !strings.Contains(err.Error(), "ALLOW_DEV_LOGIN") || !strings.Contains(err.Error(), "HRM_BASE_URL") || !strings.Contains(err.Error(), "SMTP_TLS") {
		t.Fatalf("%v", err)
	}
	// local http CORS origins stay allowed in prod (desktop WebView)
	if _, err := Load(with(prod(), "CORS_ORIGINS", "tauri://localhost,http://tauri.localhost,http://localhost:5173")); err != nil {
		t.Fatal(err)
	}
	// same settings are fine outside prod
	if _, err := Load(map[string]string{"APP_ENV": "test", "ALLOW_DEV_LOGIN": "1", "SMTP_TLS": "none"}); err != nil {
		t.Fatal(err)
	}
}

func TestPathDefaultsAnchoredToBaseDir(t *testing.T) {
	base := t.TempDir()
	c, err := Load(map[string]string{"APP_BASE_DIR": base})
	if err != nil {
		t.Fatal(err)
	}
	if c.StorageDir != filepath.Join(base, "data", "files") || c.LogDir != filepath.Join(base, "logs") {
		t.Errorf("defaults: %q %q", c.StorageDir, c.LogDir)
	}
	// relative explicit values are anchored to the base dir too (never to the CWD); absolute ones are kept
	abs := filepath.Join(t.TempDir(), "elsewhere")
	c, err = Load(map[string]string{"APP_BASE_DIR": base, "STORAGE_DIR": "./store/x", "LOG_DIR": abs})
	if err != nil {
		t.Fatal(err)
	}
	if c.StorageDir != filepath.Join(base, "store", "x") || c.LogDir != abs {
		t.Errorf("explicit: %q %q", c.StorageDir, c.LogDir)
	}
	if filepath.IsAbs(base) == false || !filepath.IsAbs(c.StorageDir) {
		t.Errorf("paths must be absolute")
	}
}

func TestExeDirNotTemp(t *testing.T) {
	d := ExeDir()
	if d == "" || !filepath.IsAbs(d) {
		t.Errorf("ExeDir = %q", d)
	}
}

func TestDiskAndLogConfig(t *testing.T) {
	c, err := Load(map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if c.DiskMaxUsedPct != 90 || c.DiskCheckIntervalSec != 60 || c.LogMaxSizeMB != 50 || !c.AuditFileEnabled || c.AuditFileMinRetainDays != 90 || !c.LogToStdout ||
		c.InspectMaxDepth != 2 || c.InspectMaxEntries != 10000 || !c.InspectEnabled {
		t.Errorf("defaults: %+v", c)
	}
	for _, v := range []string{"10", "49.9", "96", "100", "abc"} {
		if _, err := Load(map[string]string{"DISK_MAX_USED_PCT": v}); err == nil {
			t.Errorf("DISK_MAX_USED_PCT=%s must be rejected", v)
		}
	}
	for _, v := range []string{"50", "75", "95"} {
		if _, err := Load(map[string]string{"DISK_MAX_USED_PCT": v}); err != nil {
			t.Errorf("DISK_MAX_USED_PCT=%s: %v", v, err)
		}
	}
	if _, err := Load(map[string]string{"LOG_MAX_SIZE_MB": "0"}); err == nil {
		t.Error("LOG_MAX_SIZE_MB=0 must be rejected")
	}
}
