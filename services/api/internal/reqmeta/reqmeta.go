// Package reqmeta carries per-request trace fields (client IP, proxy chain, user agent, request id, session reference)
// through the context so every audit entry written while serving that request records who/where/which request.
package reqmeta

import "context"

type Meta struct {
	RequestID  string
	IP         string
	XFF        string // X-Forwarded-For chain, only filled when TRUST_PROXY=1
	UserAgent  string // already sanitized and truncated
	SessionRef string // first 12 hex chars of the stored session-id hash; never the token
	ClientKind string // web | desktop
}

type key struct{}

func With(ctx context.Context, m Meta) context.Context { return context.WithValue(ctx, key{}, m) }

func From(ctx context.Context) (Meta, bool) {
	m, ok := ctx.Value(key{}).(Meta)
	return m, ok
}
