package config

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

type AgentEndpoint struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	BaseURL     string   `json:"baseUrl"`
	Models      []string `json:"models"`
	Description string   `json:"description,omitempty"`
}

// AgentConfig contains deployment settings only; user credentials stay on desktop.
type AgentConfig struct {
	Runtime           AgentRuntime    `json:"runtime"`
	Endpoints         []AgentEndpoint `json:"endpoints"`
	DefaultEndpointID *string         `json:"defaultEndpointId"`
	DefaultModel      *string         `json:"defaultModel"`
	BudgetChars       int             `json:"budgetChars"`
	OpenMetadataURL   *string         `json:"openMetadataUrl"`
	AuthHeader        string          `json:"authHeader"`
	AuthScheme        string          `json:"authScheme"`
}

//go:embed agent-defaults.json
var defaultAgentConfig string

var agentID = regexp.MustCompile(`^[a-z0-9-]{1,100}$`)
var agentHeader = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

func loadAgent(raw, env string) (AgentConfig, error) {
	var c AgentConfig
	_ = json.Unmarshal([]byte(defaultAgentConfig), &c)
	if len(raw) > 128<<10 {
		return c, fmt.Errorf("AGENT_CONFIG: exceeds 128 KiB")
	}
	if raw != "" {
		// Runtime-only overrides retain endpoints. A replacement list resets its defaults.
		var keys map[string]json.RawMessage
		_ = json.Unmarshal([]byte(raw), &keys)
		if _, replacing := keys["endpoints"]; replacing {
			c.Endpoints = []AgentEndpoint{}
			c.DefaultEndpointID, c.DefaultModel = nil, nil
		}
		dec := json.NewDecoder(strings.NewReader(raw))
		dec.DisallowUnknownFields()
		err := dec.Decode(&c)
		var extra any
		if err != nil || dec.Decode(&extra) != io.EOF || strings.TrimSpace(raw) == "null" {
			return c, fmt.Errorf("AGENT_CONFIG: invalid JSON object")
		}
	}
	invalid := func() (AgentConfig, error) {
		return c, fmt.Errorf("AGENT_CONFIG: invalid endpoints, defaults, budget or authentication settings")
	}
	validURL := func(raw string) bool {
		u, err := url.Parse(raw)
		if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(raw, " \t\r\n") {
			return false
		}
		return u.Scheme == "https" || env != "prod" && u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
	}
	if len(c.Endpoints) > 16 || c.BudgetChars < 1000 || c.BudgetChars > 30000 {
		return invalid()
	}
	seen := map[string]bool{}
	for i := range c.Endpoints {
		e := &c.Endpoints[i]
		if !agentID.MatchString(e.ID) || seen[e.ID] || strings.TrimSpace(e.Label) == "" || len(e.Label) > 100 || len(e.Description) > 1000 || !validURL(e.BaseURL) || len(e.Models) < 1 || len(e.Models) > 50 {
			return invalid()
		}
		seen[e.ID] = true
		e.BaseURL = strings.TrimRight(e.BaseURL, "/")
		for _, m := range e.Models {
			if strings.TrimSpace(m) == "" || len(m) > 100 {
				return invalid()
			}
		}
	}
	if c.DefaultEndpointID != nil || c.DefaultModel != nil {
		found := false
		if c.DefaultEndpointID != nil && c.DefaultModel != nil {
			for _, e := range c.Endpoints {
				for _, m := range e.Models {
					if e.ID == *c.DefaultEndpointID && m == *c.DefaultModel {
						found = true
					}
				}
			}
		}
		if !found {
			return invalid()
		}
	}
	if c.OpenMetadataURL != nil && !validURL(*c.OpenMetadataURL) {
		return invalid()
	}
	if !agentHeader.MatchString(c.AuthHeader) || len(c.AuthScheme) > 32 || strings.IndexFunc(c.AuthScheme, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return invalid()
	}
	switch strings.ToLower(c.AuthHeader) {
	case "host", "cookie", "content-length", "content-type":
		return invalid()
	}
	if err := c.Runtime.validate(); err != nil {
		return c, err
	}
	if c.Endpoints == nil {
		c.Endpoints = []AgentEndpoint{}
	}
	encoded, err := json.Marshal(c)
	if err != nil || len(encoded) > 128<<10 {
		return c, fmt.Errorf("AGENT_CONFIG: response exceeds 128 KiB")
	}
	return c, nil
}
