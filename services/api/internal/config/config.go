// Package config parses the environment exactly like services/api/src/config.ts (same variables, defaults and prod validation).
package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type OidcProvider struct {
	ID              string   `json:"id"`
	Label           string   `json:"label"`
	Issuer          string   `json:"issuer"`
	ClientID        string   `json:"clientId"`
	ClientSecret    string   `json:"clientSecret"`
	DesktopClientID string   `json:"desktopClientId"`
	Scopes          []string `json:"scopes"`
	// ASSUMPTION knobs: override discovery only if the IdP needs it.
	AuthorizationEndpoint string `json:"authorizationEndpoint"`
	TokenEndpoint         string `json:"tokenEndpoint"`
	JwksURI               string `json:"jwksUri"`
}

type Genai struct {
	LoginURL            string
	VerifyURL           string
	JWTKey              string
	DevTrustUnverified  bool
	EmailPath           string
	NamePath            string
	AllowedEmailDomains []string
}

type SMTP struct {
	Host string
	Port int
	TLS  string // starttls | implicit | none
	User string
	Pass string
	From string
}

type HRM struct{ BaseURL, Secret string }

type PII struct {
	Enabled                    bool
	URL, APIKey, Model         string
	MaxFileBytes, MaxTextBytes int64
	ChunkChars, TimeoutSec     int
	SampleLines                int
}

type Config struct {
	Env       string // dev | test | prod
	Host      string
	Port      int
	PublicURL string

	DatabaseURL string
	PgliteDir   string // data dir for the embedded Postgres (dev/test); name kept for env compatibility
	DataKey     string

	BaseDir           string // directory relative paths are resolved against (executable dir; APP_BASE_DIR overrides)
	StorageDir        string
	MaxUploadBytes    int64
	PartBytes         int64
	AllowedExtensions []string

	TicketTTLHours          float64
	ApprovalWindowHours     float64
	MaxDownloads            int
	DownloadReauthMaxAgeSec float64
	SessionTTLHours         float64

	OidcProviders        []OidcProvider
	BootstrapAdmins      []string
	AllowDevLogin        bool
	DevLogMail           bool
	LoginRateLimitPerMin int

	Genai Genai
	SMTP  SMTP

	OutboundProxies map[string]string
	TrustProxy      bool
	CorsOrigins     []string
	HRM             HRM
	PII             PII

	// logging / rotation (C)
	LogDir                 string
	LogFileEnabled         bool
	LogToStdout            bool
	LogMaxSizeMB           int
	LogMaxAgeDays          int
	LogMaxBackups          int
	LogRotateDaily         bool
	AuditFileEnabled       bool
	AuditFileMinRetainDays int

	// disk budget
	DiskMaxUsedPct       float64
	DiskCheckIntervalSec int
	DiskReserveMB        int

	// file inspection (A)
	InspectEnabled           bool
	InspectMaxDepth          int
	InspectMaxEntries        int
	InspectMaxBytes          int64
	InspectMaxRatio          float64
	InspectTimeoutSec        float64
	InspectEntryHashMaxBytes int64
	InspectNestedMaxBytes    int64
}

type env map[string]string

func (e env) str(k, def string) string {
	if v, ok := e[k]; ok && v != "" {
		return v
	}
	return def
}

func csv(s string, lower bool) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if lower {
			p = strings.ToLower(p)
		}
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func validURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Scheme != ""
}

// Load builds the config from an env map (tests) — os.Environ is adapted by FromOS.
func Load(src map[string]string) (*Config, error) {
	e := env(src)
	var errs []string
	num := func(k string, def float64) float64 {
		v := e.str(k, "")
		if v == "" {
			return def
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			errs = append(errs, k+": Expected number")
			return def
		}
		return f
	}
	optURL := func(k string) string {
		v := e.str(k, "")
		if v != "" && !validURL(v) {
			errs = append(errs, k+": Invalid url")
		}
		return v
	}
	appEnv := e.str("APP_ENV", "dev")
	if appEnv != "dev" && appEnv != "test" && appEnv != "prod" {
		errs = append(errs, "APP_ENV: Invalid enum value. Expected 'dev' | 'test' | 'prod'")
	}
	publicURL := e.str("PUBLIC_URL", "http://localhost:8080")
	if !validURL(publicURL) {
		errs = append(errs, "PUBLIC_URL: Invalid url")
	}
	tls := e.str("SMTP_TLS", "starttls")
	if tls != "starttls" && tls != "implicit" && tls != "none" {
		errs = append(errs, "SMTP_TLS: Invalid enum value. Expected 'starttls' | 'implicit' | 'none'")
	}

	base := e.str("APP_BASE_DIR", "")
	if base == "" {
		base = ExeDir()
	} else if abs, err := filepath.Abs(base); err == nil {
		base = abs
	}
	diskPct := num("DISK_MAX_USED_PCT", 90)
	if diskPct < 50 || diskPct > 95 {
		errs = append(errs, "DISK_MAX_USED_PCT: must be between 50 and 95")
	}
	flag := func(k string, def bool) bool {
		v := e.str(k, "")
		if v == "" {
			return def
		}
		return v == "1" || strings.EqualFold(v, "true")
	}
	posInt := func(k string, def, min int) int {
		n := int(num(k, float64(def)))
		if n < min {
			errs = append(errs, fmt.Sprintf("%s: must be >= %d", k, min))
			return def
		}
		return n
	}

	c := &Config{
		Env: appEnv, Host: e.str("HOST", "127.0.0.1"), Port: int(num("PORT", 8080)), PublicURL: strings.TrimSuffix(publicURL, "/"),
		DatabaseURL: e.str("DATABASE_URL", ""), PgliteDir: e.str("PGLITE_DIR", ""), DataKey: e.str("DATA_KEY", ""),
		BaseDir: base, StorageDir: resolvePath(base, e.str("STORAGE_DIR", ""), "data", "files"), MaxUploadBytes: int64(num("MAX_UPLOAD_BYTES", 2*1024*1024*1024)),
		PartBytes: int64(num("PART_BYTES", 8*1024*1024)), AllowedExtensions: csv(e.str("ALLOWED_EXTENSIONS", ""), true),
		TicketTTLHours: num("TICKET_TTL_HOURS", 72), ApprovalWindowHours: num("APPROVAL_WINDOW_HOURS", 168),
		MaxDownloads: int(num("MAX_DOWNLOADS", 3)), DownloadReauthMaxAgeSec: num("DOWNLOAD_REAUTH_MAX_AGE_SEC", 300),
		SessionTTLHours: num("SESSION_TTL_HOURS", 12),
		BootstrapAdmins: csv(e.str("BOOTSTRAP_ADMINS", ""), true),
		AllowDevLogin:   e.str("ALLOW_DEV_LOGIN", "0") == "1", DevLogMail: e.str("DEV_LOG_MAIL", "0") == "1",
		LoginRateLimitPerMin: int(num("RATE_LIMIT_LOGIN_PER_MIN", 10)),
		Genai: Genai{
			LoginURL: optURL("GENAI_LOGIN_URL"), VerifyURL: optURL("GENAI_VERIFY_URL"), JWTKey: e.str("GENAI_JWT_KEY", ""),
			DevTrustUnverified: e.str("GENAI_DEV_TRUST_UNVERIFIED", "0") == "1",
			EmailPath:          e.str("GENAI_EMAIL_PATH", "email"), NamePath: e.str("GENAI_NAME_PATH", "userFullName"),
			AllowedEmailDomains: csv(e.str("ALLOWED_EMAIL_DOMAINS", ""), true),
		},
		SMTP:            SMTP{Host: e.str("SMTP_HOST", ""), Port: int(num("SMTP_PORT", 587)), TLS: tls, User: e.str("SMTP_USER", ""), Pass: e.str("SMTP_PASS", ""), From: e.str("MAIL_FROM", "")},
		OutboundProxies: map[string]string{}, TrustProxy: e.str("TRUST_PROXY", "0") == "1", CorsOrigins: csv(e.str("CORS_ORIGINS", ""), false),
		HRM: HRM{BaseURL: strings.TrimSuffix(optURL("HRM_BASE_URL"), "/"), Secret: e.str("HRM_SIGNATURE_SECRET", "")},
		PII: PII{Enabled: flag("PII_ENABLED", false), URL: optURL("PII_LLM_URL"), APIKey: e.str("PII_LLM_API_KEY", ""),
			Model:        e.str("PII_LLM_MODEL", "v_kimi"),
			MaxFileBytes: int64(posInt("PII_MAX_FILE_BYTES", 8<<20, 1)), MaxTextBytes: int64(posInt("PII_MAX_TEXT_BYTES", 256<<10, 1)),
			ChunkChars: posInt("PII_CHUNK_CHARS", 12000, 128), TimeoutSec: posInt("PII_TIMEOUT_SEC", 180, 1), SampleLines: posInt("PII_SAMPLE_LINES", 20, 1)},

		LogDir: resolvePath(base, e.str("LOG_DIR", ""), "logs"), LogFileEnabled: flag("LOG_FILE_ENABLED", true), LogToStdout: flag("LOG_STDOUT", true),
		LogMaxSizeMB: posInt("LOG_MAX_SIZE_MB", 50, 1), LogMaxAgeDays: posInt("LOG_MAX_AGE_DAYS", 30, 0), LogMaxBackups: posInt("LOG_MAX_BACKUPS", 20, 0),
		LogRotateDaily: flag("LOG_ROTATE_DAILY", true), AuditFileEnabled: flag("AUDIT_FILE_ENABLED", true),
		AuditFileMinRetainDays: posInt("AUDIT_FILE_MIN_RETAIN_DAYS", 90, 0),
		DiskMaxUsedPct:         diskPct, DiskCheckIntervalSec: posInt("DISK_CHECK_INTERVAL_SEC", 60, 1), DiskReserveMB: posInt("DISK_RESERVE_MB", 256, 0),

		InspectEnabled: flag("INSPECT_ENABLED", true), InspectMaxDepth: posInt("INSPECT_MAX_DEPTH", 2, 1), InspectMaxEntries: posInt("INSPECT_MAX_ENTRIES", 10000, 1),
		InspectMaxBytes: int64(num("INSPECT_MAX_BYTES", 1<<30)), InspectMaxRatio: num("INSPECT_MAX_RATIO", 200), InspectTimeoutSec: num("INSPECT_TIMEOUT_SEC", 120),
		InspectEntryHashMaxBytes: int64(num("INSPECT_ENTRY_HASH_MAX_BYTES", 64<<20)), InspectNestedMaxBytes: int64(num("INSPECT_NESTED_MAX_BYTES", 64<<20)),
	}

	if c.PII.MaxFileBytes > 64<<20 || c.PII.MaxTextBytes > 16<<20 || c.PII.ChunkChars > 32000 || c.PII.TimeoutSec > 900 || c.PII.SampleLines > 1000 {
		errs = append(errs, "PII limits exceeded: file <=64 MiB, text <=16 MiB, chunk <=32000 chars, timeout <=900 seconds, sample <=1000 lines")
	}
	if c.PII.Enabled && (c.PII.URL == "" || c.Env == "prod" && !strings.HasPrefix(c.PII.URL, "https://")) {
		errs = append(errs, "PII_LLM_URL: HTTPS endpoint required when PII is enabled in prod")
	}
	if raw := e.str("OIDC_PROVIDERS", "[]"); true {
		var ps []OidcProvider
		if err := json.Unmarshal([]byte(raw), &ps); err != nil {
			errs = append(errs, "OIDC_PROVIDERS: invalid JSON")
		} else {
			for i := range ps {
				p := &ps[i]
				if !validURL(p.Issuer) {
					errs = append(errs, fmt.Sprintf("OIDC_PROVIDERS.%d.issuer: Invalid url", i))
				}
				for _, u := range []string{p.AuthorizationEndpoint, p.TokenEndpoint, p.JwksURI} {
					if u != "" && !validURL(u) {
						errs = append(errs, fmt.Sprintf("OIDC_PROVIDERS.%d: Invalid url", i))
					}
				}
				if p.Scopes == nil {
					p.Scopes = []string{"openid", "email", "profile"}
				}
			}
			c.OidcProviders = ps
		}
	}
	if raw := e.str("OUTBOUND_PROXIES", "{}"); true {
		m := map[string]string{}
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			errs = append(errs, "OUTBOUND_PROXIES: invalid JSON")
		} else {
			c.OutboundProxies = m
		}
	}
	if len(errs) > 0 {
		return nil, fmt.Errorf("invalid configuration: %s", strings.Join(errs, "; "))
	}

	if c.Env == "prod" {
		var pe []string
		if c.AllowDevLogin {
			pe = append(pe, "ALLOW_DEV_LOGIN must be 0 in prod")
		}
		if c.DevLogMail {
			pe = append(pe, "DEV_LOG_MAIL must be 0 in prod")
		}
		if c.Genai.DevTrustUnverified {
			pe = append(pe, "GENAI_DEV_TRUST_UNVERIFIED must be 0 in prod")
		}
		if c.DatabaseURL == "" {
			pe = append(pe, "DATABASE_URL required in prod")
		}
		if c.DataKey == "" {
			pe = append(pe, "DATA_KEY (or KMS provider) required in prod")
		}
		if !strings.HasPrefix(c.PublicURL, "https://") {
			pe = append(pe, "PUBLIC_URL must be https in prod")
		}
		if len(c.OidcProviders) == 0 {
			pe = append(pe, "OIDC_PROVIDERS required in prod")
		}
		localHTTP := regexp.MustCompile(`^http://(localhost|tauri\.localhost)(:\d+)?$`)
		for _, o := range c.CorsOrigins {
			if o == "*" || strings.HasPrefix(o, "http://") && !localHTTP.MatchString(o) {
				pe = append(pe, "CORS_ORIGINS must not contain * or non-local http origins in prod")
				break
			}
		}
		for _, u := range []string{c.Genai.LoginURL, c.Genai.VerifyURL} {
			if u != "" && !strings.HasPrefix(u, "https://") {
				pe = append(pe, "GENAI_* URLs must be https in prod")
			}
		}
		if (c.Genai.VerifyURL != "" || c.Genai.JWTKey != "") && len(c.Genai.AllowedEmailDomains) == 0 {
			pe = append(pe, "ALLOWED_EMAIL_DOMAINS required when genai login is enabled in prod")
		}
		if c.HRM.BaseURL == "" || c.HRM.Secret == "" {
			pe = append(pe, "HRM_BASE_URL and HRM_SIGNATURE_SECRET required in prod")
		}
		if c.HRM.BaseURL != "" && !strings.HasPrefix(c.HRM.BaseURL, "https://") {
			pe = append(pe, "HRM_BASE_URL must be https in prod")
		}
		if c.SMTP.TLS == "none" {
			pe = append(pe, "SMTP_TLS=none is not allowed in prod")
		}
		if len(pe) > 0 {
			return nil, fmt.Errorf("invalid prod configuration: %s", strings.Join(pe, "; "))
		}
	}
	return c, nil
}

// HRMConfigured reports whether approvers come from HRM.
func (c *Config) HRMConfigured() bool { return c.HRM.BaseURL != "" && c.HRM.Secret != "" }

func (c *Config) IsHTTPS() bool { return strings.HasPrefix(c.PublicURL, "https://") }

func (c *Config) Provider(id string) *OidcProvider {
	for i := range c.OidcProviders {
		if c.OidcProviders[i].ID == id {
			return &c.OidcProviders[i]
		}
	}
	return nil
}
