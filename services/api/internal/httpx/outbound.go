// Package httpx: outbound HTTP with per-hop proxies, plus request/response helpers for the server.
package httpx

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Hop names: oidc | genai | hrm. Each hop may use its own proxy — never one global proxy.
type Hop string

const (
	HopOIDC  Hop = "oidc"
	HopGenai Hop = "genai"
	HopHRM   Hop = "hrm"
	HopPII   Hop = "pii"
)

type Outbound struct {
	proxies map[string]string
	mu      sync.Mutex
	clients map[Hop]*http.Client
}

func NewOutbound(proxies map[string]string) *Outbound {
	return &Outbound{proxies: proxies, clients: map[Hop]*http.Client{}}
}

// RouteInfo describes the configured route without exposing proxy credentials.
func (o *Outbound) RouteInfo(h Hop) (route, proxy string, auth bool) {
	raw := o.proxies[string(h)]
	if raw == "" {
		return "direct", "", false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "proxy", "invalid_proxy_url", false
	}
	return "proxy", u.Scheme + "://" + u.Host, u.User != nil
}

func (o *Outbound) client(h Hop) (*http.Client, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if c, ok := o.clients[h]; ok {
		return c, nil
	}
	tr := &http.Transport{
		Proxy:               nil, // direct unless this hop has its own proxy; HTTP(S)_PROXY from the environment is NOT used
		MaxIdleConns:        20,
		IdleConnTimeout:     60 * time.Second,
		TLSHandshakeTimeout: 15 * time.Second,
	}
	if raw := o.proxies[string(h)]; raw != "" {
		u, err := url.Parse(raw)
		if err != nil {
			return nil, fmt.Errorf("OUTBOUND_PROXIES.%s: %w", h, err)
		}
		tr.Proxy = http.ProxyURL(u)
	}
	// no client timeout: callers bound each call with a context deadline (response bodies are read within it)
	c := &http.Client{Transport: tr}
	o.clients[h] = c
	return c, nil
}

// Do sends req on the given hop. timeout 0 means 15s. The returned cancel must be called after the body is consumed.
func (o *Outbound) Do(ctx context.Context, h Hop, req *http.Request, timeout time.Duration) (*http.Response, context.CancelFunc, error) {
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	c, err := o.client(h)
	if err != nil {
		return nil, func() {}, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	resp, err := c.Do(req.WithContext(ctx))
	if err != nil {
		cancel()
		return nil, func() {}, err
	}
	return resp, cancel, nil
}
