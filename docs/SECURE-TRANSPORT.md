# Application AES transport

Desktop and BO web API calls use `tabledb-aes-v1` in addition to HTTPS. Web and desktop have **different server signing keys**. Each handshake generates new P-256 ephemeral ECDH key pairs; no AES key is sent over the network or stored in config. A signed transcript binds the client kind, both public keys/nonces, session id and expiry. HKDF-SHA256 derives separate AES-256-GCM keys for requests and responses. An encrypted server-finished record confirms key agreement.

The server exposes `POST /api/v1/secure/handshake` and `POST /api/v1/secure/request`. The encrypted request contains method, route/query, bearer/CSRF headers and body. Response status, headers and body are encrypted. Records use a 64-bit request sequence and 32-bit record index as the 96-bit nonce, with direction-specific keys and authenticated protocol/session/sequence/index metadata. Requests require a nonzero sequence; the server rejects duplicates and sequences outside a 128-request reorder window. Session keys stay in process memory and expire.

An authenticated terminal record is mandatory. The server verifies the complete bounded request before running handlers, including handlers that ignore bodies. Uploads remain partitioned by `PART_BYTES`; response/download bodies remain streamed in 64 KiB records. A declared content length must match the bytes written before a terminal record is emitted. Clients reject tampering, missing terminal records and length mismatches. Transport failures never automatically retry mutations; retry only after checking the operation's result/idempotency contract.

Client type is not proof of a trusted device. Existing sessions, bearer credentials, RBAC, CSRF and download capabilities still authorize operations. The server checks that authenticated session kind matches the encrypted channel kind; desktop login/config/agent routes also require desktop channels.

## Deployment configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `SECURE_TRANSPORT_ENABLED` | Enable server transport; enable for these clients | `false` for legacy/test servers |
| `SECURE_TRANSPORT_REQUIRED` | Reject plaintext API calls | `true` |
| `SECURE_DESKTOP_SIGNING_KEY` | Base64 32-byte P-256 private scalar, server only | required when enabled |
| `SECURE_WEB_SIGNING_KEY` | Independent signing private scalar, server only | required when enabled |
| `SECURE_SESSION_TTL_SEC` | Session lifetime, 60–3600 seconds | `900` |
| `SECURE_MAX_SESSIONS` | Live in-memory sessions, 1–4096 | `1024` |
| `SECURE_MAX_INFLIGHT` | Concurrent encrypted requests/downloads, 1–128 | `16` |
| `SECURE_HANDSHAKES_PER_MINUTE` | Handshakes per client IP, 1–1000 | `30` |
| `VITE_SECURE_WEB_PUBLIC_KEY` | Trusted web public key, embedded at build time | shared public pin |
| `TABLEDB_SERVER_SIGNING_PUBLIC_KEY` | Trusted desktop public key, bootstrap/build override | desktop sample public pin |

Maximum decoded request size follows `max(PART_BYTES, 1 MiB)`, capped at 64 MiB. Read deadlines bound handshake/request admission. Handshake IP limiting uses the server's existing trusted-proxy IP resolver; session/admission limits apply per process.

`.env` contains independent generated private keys for the current deployment and corresponding public pins. It is gitignored and must remain private. `packages/shared/src/secure-pins.ts` and desktop `config.sample.json` contain only public trust anchors. Never publish either private signing key as a `VITE_*` variable or put private keys into desktop files. AES session keys are unrelated to the static signing keys.

Generate each signing identity independently, with private output redirected to a restricted temporary file:

```sh
umask 077
cd services/api
go run ./cmd/secure-keygen > web-key.json
go run ./cmd/secure-keygen > desktop-key.json
```

Set the two server private variables and their matching client public pins, then remove the temporary files. Keep API server, web build and desktop bootstrap in sync when rotating keys. Existing clients fail closed when the pin does not match; there is no plaintext downgrade. The GitHub desktop build accepts repository variable `TABLEDB_SERVER_SIGNING_PUBLIC_KEY`; web builds accept `VITE_SECURE_WEB_PUBLIC_KEY`. Vite reads the root `.env`, exposing only `VITE_*` variables.

HTTPS is still required for public web deployments, loading trusted application code, browser HttpOnly cookies and OIDC redirects. The public HTML/JavaScript email-approval page uses HTTPS, then sends its capability POST through a web AES channel; the server serves its embedded crypto module with the web public pin. OIDC `/auth/login` and `/auth/callback` remain HTTPS browser-navigation routes. Health probes and static pages stay outside the AES API. Cookies managed by browsers travel in outer HTTPS headers; AES is not a replacement for TLS.

BO downloads register a module service worker under the assets scope. A one-use local download ticket maps a browser navigation to a decrypted streaming response; the original API download capability is carried inside the encrypted request. Web downloads require service worker support and a secure browser context (HTTPS or localhost). Desktop streams decrypted bytes into the native save path, retaining size/SHA-256 verification.

Sessions, replay state and admission limits are local to one API instance. Multiple instances require sticky routing of handshake and encrypted requests to the same instance. Restarting an instance invalidates its live sessions. A client may have to start a fresh session/reload after such a restart; never replay a mutation merely because its response was lost.

This is an application protocol built from standard crypto primitives, not TLS/HPKE and not an independently audited protocol. HTTPS and normal authorization remain mandatory.

## Validation and maintenance

- `npm test -w @vnpay/shared` runs actual Go ↔ WebCrypto handshakes, wrong-key/client checks, header/body encryption, concurrency, replay, truncation and tamper tests. Go must be installed.
- `cd services/api && go test -race ./...` covers server request completion before mutation, expiry, replay-window behavior, configuration and existing API behavior.
- `cd apps/desktop/src-tauri && cargo test --lib` covers native desktop regressions. Native handshake interoperability is a separate ignored test using the disposable Go fixture: start `go run ./internal/securetransport/testserver`, set `TABLEDB_SECURE_TEST_URL`, `TABLEDB_SECURE_TEST_DESKTOP_PIN`, `TABLEDB_SECURE_TEST_WEB_PIN` from its public startup JSON, then run `cargo test --lib native_handshake_interoperability -- --ignored`.
- A Chrome smoke test verified that the module service worker streams a 256 KiB attachment and only `/secure/handshake` and `/secure/request` reach the API.
- Run `node scripts/generate-secure-browser-client.cjs` after editing shared crypto code. This regenerates the embedded standalone email client. CI verifies that it matches the source.
