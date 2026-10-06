package config

import (
	"encoding/json"
	"fmt"
)

// DBConfig contains desktop execution settings, never credentials or DB endpoints.
type DBConfig struct {
	DefaultMaxRows         int `json:"defaultMaxRows"`
	MaxRows                int `json:"maxRows"`
	DefaultTimeoutSec      int `json:"defaultTimeoutSec"`
	MaxTimeoutSec          int `json:"maxTimeoutSec"`
	PageSize               int `json:"pageSize"`
	TablePageSize          int `json:"tablePageSize"`
	ConnectTimeoutSec      int `json:"connectTimeoutSec"`
	ExternalAuthTimeoutSec int `json:"externalAuthTimeoutSec"`
}

func DefaultDBConfig() DBConfig { return DBConfig{1000, 100000, 60, 600, 500, 200, 15, 180} }

type UploadClientConfig struct {
	Parallelism int `json:"parallelism"`
	MaxRetries  int `json:"maxRetries"`
	RetryBaseMs int `json:"retryBaseMs"`
}

func loadRuntime(e env, c *Config) error {
	for _, item := range []struct {
		name string
		dst  any
	}{{"DB_CONFIG", &c.DB}, {"UPLOAD_CLIENT_CONFIG", &c.UploadClient}} {
		raw := e.str(item.name, "")
		if raw != "" {
			if err := json.Unmarshal([]byte(raw), item.dst); err != nil {
				return fmt.Errorf("%s: %w", item.name, err)
			}
		}
	}
	d := c.DB
	if d.DefaultMaxRows < 1 || d.MaxRows < d.DefaultMaxRows || d.MaxRows > 100000 ||
		d.DefaultTimeoutSec < 1 || d.MaxTimeoutSec < d.DefaultTimeoutSec || d.MaxTimeoutSec > 600 ||
		d.PageSize < 1 || d.PageSize > 5000 || d.TablePageSize < 1 || d.TablePageSize > 5000 ||
		d.ConnectTimeoutSec < 1 || d.ConnectTimeoutSec > 300 || d.ExternalAuthTimeoutSec < 1 || d.ExternalAuthTimeoutSec > 600 {
		return fmt.Errorf("DB_CONFIG: invalid rows, timeout or page limits")
	}
	u := c.UploadClient
	if u.Parallelism < 1 || u.Parallelism > 16 || u.MaxRetries < 0 || u.MaxRetries > 10 || u.RetryBaseMs < 1 || u.RetryBaseMs > 60000 {
		return fmt.Errorf("UPLOAD_CLIENT_CONFIG: parallelism 1..16, retries 0..10, retry base 1..60000 ms required")
	}
	if c.DownloadTokenTTLSec > 3600 || c.DelegationMaxDays > 365 {
		return fmt.Errorf("download token TTL must be <=3600 seconds; delegation <=365 days")
	}
	return nil
}
