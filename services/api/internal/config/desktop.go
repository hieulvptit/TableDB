package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
)

//go:embed desktop-defaults.json
var desktopDefaults string

// DesktopConfig is public deployment configuration; never put credentials here.
type DesktopConfig struct {
	Proxy struct {
		URL *string `json:"url"`
	} `json:"proxy"`
	Sidecar struct {
		MaxHeapMb int `json:"maxHeapMb"`
	} `json:"sidecar"`
	GenaiLoginOrigins        []string `json:"genaiLoginOrigins"`
	GenaiSecretPath          bool     `json:"genaiSecretPath"`
	GenaiPersistSso          bool     `json:"genaiPersistSso"`
	GenaiLoginBrowser        string   `json:"genaiLoginBrowser"`
	GenaiProxyURL            *string  `json:"genaiProxyUrl"`
	GenaiTimeoutSec          int      `json:"genaiTimeoutSec"`
	GenaiInternalConnectPort int      `json:"genaiInternalConnectPort"`
	ConfigTimeoutSec         int      `json:"configTimeoutSec"`
}

func loadDesktop(raw string) (DesktopConfig, error) {
	var c DesktopConfig
	_ = json.Unmarshal([]byte(desktopDefaults), &c)
	if raw != "" {
		dec := json.NewDecoder(strings.NewReader(raw))
		dec.DisallowUnknownFields()
		err := dec.Decode(&c)
		var extra any
		if len(raw) > 32768 || err != nil || dec.Decode(&extra) != io.EOF || strings.TrimSpace(raw) == "null" {
			return c, fmt.Errorf("DESKTOP_CONFIG: invalid JSON object")
		}
	}
	bad := func() (DesktopConfig, error) { return c, fmt.Errorf("DESKTOP_CONFIG: invalid deployment settings") }
	if c.Sidecar.MaxHeapMb < 128 || c.Sidecar.MaxHeapMb > 4096 || c.GenaiTimeoutSec < 5 || c.GenaiTimeoutSec > 600 || c.ConfigTimeoutSec < 1 || c.ConfigTimeoutSec > 120 || c.GenaiInternalConnectPort < 1024 || c.GenaiInternalConnectPort > 65535 || len(c.GenaiLoginOrigins) < 1 || len(c.GenaiLoginOrigins) > 8 || c.GenaiLoginBrowser != "internal" && c.GenaiLoginBrowser != "system" {
		return bad()
	}
	for _, raw := range c.GenaiLoginOrigins {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
			return bad()
		}
	}
	for _, p := range []*string{c.Proxy.URL, c.GenaiProxyURL} {
		if p != nil {
			u, err := url.Parse(*p)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5") || u.Hostname() == "" || u.User != nil {
				return bad()
			}
		}
	}
	if c.GenaiProxyURL != nil && !strings.HasPrefix(*c.GenaiProxyURL, "http://") {
		return bad()
	}
	return c, nil
}
