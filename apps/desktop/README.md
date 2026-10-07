# VNPAY TableDB – desktop shell (Tauri 2, Windows)

Rust core + WebView hosting the React SPA (`apps/web`, build output `apps/web/dist`). Binding design: `docs/ARCHITECTURE.md`
(sections 2, 4, 5, 9) and `docs/SIDECAR-PROTOCOL.md`.

## What the Rust core does

| Command (`invoke`) | Purpose |
|---|---|
| `sidecar_request(method, params)` | One NDJSON request to the JDBC sidecar. Method allowlist (protocol methods only), 8 MiB line cap, id correlation, per-method timeout, structured errors `{code,message,sqlState?,vendorCode?,retryable}`. |
| `sidecar_cancel(queryId)` | `query.cancel`. |
| `secret_set/get/delete(key[,value])` | OS credential store via `keyring`, service `vn.vnpay.tabledb.<env>`. **macOS/Linux:** all keys live in ONE item (`vault.v1`, a JSON map) that is read once per process and cached in memory, so the Keychain asks at most once per launch (none after "Always Allow"); on macOS a write deletes + re-adds the item instead of read-then-modify (no prompt, and the new item trusts the current binary); a write happens only when a value changes, deleting a missing key touches nothing. Items from older versions (`auth.session`, `db.profile.*.password`) are not migrated: sign in / re-save the password once. **Windows:** one Credential Manager item per key (no prompts there, but a ~2.5 KB item limit), value max 1200 chars. Keys `[A-Za-z0-9._:/@-]{1,128}`. `get` returns `null` if absent; `delete` is idempotent. Values/keys are never logged. |
| `oidc_begin({authorizeEndpoint, clientId, scope?, extraParams?, timeoutSec?})` | RFC 8252 loopback + PKCE (S256). Binds `127.0.0.1:<random>`, opens the **system browser**, validates `state`, returns `{code, redirectUri, codeVerifier}`. The SPA then calls `POST /auth/desktop/exchange` on the API. Endpoint/client id come from the API's `/auth/desktop/config` (nothing hard-coded); https required (http only for loopback dev). Listener is single-use, default timeout 300 s (30–600), one flow at a time. |
| `genai_login_begin({params:{loginUrl, timeoutSec?}})` -> `{token}` | VNPAY SSO broker login. **Browser mode** (`genaiLoginBrowser`, default `internal`): `internal` opens an in-app webview window (label `genai-login`, 480x720, incognito, own data dir) on `<loginUrl>?connectid=1`, so the login traffic uses `proxy.url` (`http://`/`socks5://` only, else `E_PROXY_UNSUPPORTED`; macOS needs 14+ for webview proxies). No listener: the broker's redirect to `http://localhost:1/sso-callback?token=…` is intercepted in `on_navigation` and cancelled. Only https navigations are allowed; popups, downloads and every other scheme are blocked; the window has **no IPC** (it is not in any capability, which lists only `main`). Closing the window -> `E_GENAI_CANCELLED`, timeout -> `E_GENAI_TIMEOUT`. `system` is the loopback-listener mode described below and is the fallback where the embedded browser is refused (Google accounts return `disallowed_useragent` in embedded webviews). The rest of this row describes `system` mode:  (`https://genai.vnpay.vn/create-jwt-token?connectid=…`, `oidc_begin` stays as fallback). `loginUrl` must be https with an origin in `genaiLoginOrigins` (default only `https://genai.vnpay.vn`). Binds `127.0.0.1` **and** `::1` on one port (the broker redirects to `http://localhost:<connectid>/sso-callback?token=…`). **Default protocol (as the antisw reference apps)**: `connectid=<port>`, only `GET /sso-callback?token=<JWT>` is accepted. Opt-in `genaiSecretPath` (config / `TABLEDB_GENAI_SECRET_PATH=1`; enable only after genai validates connectid with a regex that allows this form): `connectid=<port>/cb/<S>` with `S` = 32 random bytes (base64url) and only `GET /cb/<S>/sso-callback` (constant-time compare) for login-CSRF protection. In both modes: Host must be `localhost|127.0.0.1|[::1]:<port>`, exactly one valid callback is accepted, anything else gets 404 and the listener keeps waiting. 8 KiB / 5 s request limits, token URL-decoded, ≤ 4 KiB, must look like a JWT (not verified here, the API verifies HS256). Default timeout 180 s (5–600). Shares the busy flag with `oidc_begin` (`E_GENAI_BUSY`). Errors: `E_GENAI_ORIGIN/LISTEN/TIMEOUT/CANCELLED/NO_TOKEN/BAD_TOKEN`. Token and `S` are never logged (`redact.rs` strips `/cb/<S>` (secret mode), `connectid=`, `token=`). |
| `genai_login_forget()` | Deletes the persisted SSO profile of the login window so the next login asks for credentials again. Refused while a login is running (`E_GENAI_BUSY`). Windows/Linux: removes `<app_local_data_dir>/genai-login-webview` (best effort, not-found is fine). macOS: WKWebView ignores `data_directory` and keys its store by identifier (macOS 14+), so the store is cleared through a short-lived hidden window using the same identifier. |
| `genai_login_cancel()` | Aborts the in-flight `genai_login_begin` (it then fails with `E_GENAI_CANCELLED`) and closes the login window. |
| `open_external(url)` | http/https only, no credentials/control chars. |
| `app_info()` | version, log dir, env, apiBaseUrl, proxyUrl, config path/error, `cspAllowsApi`, sidecar `ready` info. |
| `driver_import({params:{name, className, urlTemplate, defaultPort?, version?}})` | Custom JDBC driver (`driver:"custom"`). Rust opens a **native multi-select .jar dialog** (paths never come from the WebView), validates (1-20 files, regular non-symlink `.jar`, <= 200 MB each; `className` = Java identifier path; `urlTemplate` starts with `jdbc:` and only uses `{host}` `{port}` `{database}`), copies the JARs to `<app_data_dir>/drivers-custom/<id>__<name>.jar` (`id` = slug + 8 hex), computes SHA-256, updates `manifest.json` atomically under a mutex, then calls the sidecar's internal `drivers.reload`. Returns `{id, name, files:[{file,sha256}], loaded, error?}` (a driver that fails to load is kept so the UI can show the error and offer removal). Cancelled dialog -> `E_CANCELLED`. |
| `driver_list()` -> `{drivers:[…]}` | `type:"custom"` entries from the sidecar's `hello` (`id,name,version,className,urlTemplate,defaultPort,files,loaded,error?`). |
| `driver_remove(id)` | Removes the manifest entry + its files, reloads the sidecar. `E_NOT_FOUND` if unknown. |

Custom drivers: imported JARs are **copied to the user-writable app data dir** (`drivers-custom/`) and passed to the sidecar via `--custom-drivers <dir>`; the sidecar verifies each file's SHA-256 against the manifest at load time and refuses mismatches. The built-in `drivers/` directory beside the sidecar jar is never modified. `drivers.reload` is internal (`sidecar::INTERNAL_METHODS`): it is **not** in the WebView-facing `sidecar_request` allowlist. Capabilities: `capabilities/default.json` gains `allow-driver-import`, `allow-driver-list`, `allow-driver-remove` (the dialog plugin itself gets no permission: it is used only from Rust, so the JS side needs no `dialog:*` grant).

Events emitted to the SPA: `sidecar:event` (every sidecar event, payload `{event,seq,data}`), `sidecar:ready`,
`sidecar:auth-open-url`. For `auth.openUrl` with `purpose:"trino-sso"` the core additionally opens the (validated http/https)
URL in the system browser itself, so the SPA only needs to show a "waiting for SSO" state. `sidecar:event` with `event:"exit"` signals a crash.

Sidecar lifecycle: spawned lazily on the first request from `resources/jre/bin/java.exe -Xmx<maxHeapMb>m -jar resources/sidecar/tabledb-jdbc.jar --stdio`
(working dir = jar dir, so `drivers/` beside the jar is used). Crash -> pending requests fail with `E_SIDECAR_EXITED` (retryable), next request respawns;
3 crashes in 60 s -> `E_SIDECAR_CRASH_LOOP` for 30 s. Killed on app exit; closing stdin also ends it if the app dies. Oversized (>8 MiB) sidecar output kills it.
Timeouts: `query.execute` = `timeoutSec`(+15 s), `session.open/test` cover `externalAuthTimeoutSec`, others 30 s; a timed-out `query.execute` triggers a best-effort `query.cancel`.
Sidecar stderr is logged after redaction; params/rows/SQL are never logged.

Security posture: capability `default` grants only `core:event:allow-listen/unlisten`, the 10 app commands (each needs an explicit `allow-*` permission, enforced by `build.rs`),
and updater check/install. No shell, fs, general HTTP, or opener permission for the WebView. CSP is `default-src 'self'` + `connect-src 'self' ipc: http://ipc.localhost <API origin>`;
navigation of the main window is pinned to the app origin. Desktop API envelopes use a native HTTP bridge pinned to the configured API; the renderer cannot choose arbitrary destinations or plaintext routes. The SPA must not embed any login WebView.

## Configuration

`%APPDATA%\vn.vnpay.tabledb\config.json` and `config.sample.json` contain only:

```json
{ "env": "prod" }
```

The native binary embeds the API base URL and public signing key from `src-tauri/deployment.json` at build time (default API: `https://10.23.5.40:8080/c/`). Local files and environment variables cannot override bootstrap addresses, trust or environment. On startup, valid legacy local files are replaced with the minimal config above; malformed or unreadable files produce an explicit error. No config file is needed to reach the server. Moving from `test` to `prod` changes the credential-manager namespace, so users need to sign in again.

Rust retrieves desktop settings (SSO proxy/browser/origins, general proxy, Java heap and timeouts) from `/api/v1/desktop/config` through secure transport. Agent endpoints and runtime settings come from `/api/v1/agent/config` after sign-in. These settings remain in memory and are never written to local config.json. Restart the app to pick up server deployment changes. Embedded addresses can still be extracted from a binary; this prevents plaintext local configuration disclosure, not reverse engineering.

`apiBaseUrl` is the pinned API base. Rust sends the renderer's AES envelopes only to `/api/v1/secure/handshake` and `/api/v1/secure/request`; response chunks are read on demand so downloads remain streamed. API calls do not depend on WebView CORS, CSP exceptions, OS proxy settings, or `HTTP_PROXY`/`HTTPS_PROXY`. Without a configured API proxy, connections are direct. A configured proxy applies to remote API hosts; `localhost` and loopback IPs always connect directly.

`proxy.url` is exposed via `app_info` for the updater (`check({proxy})`); the sidecar's DB/Trino proxy is per-profile (`profile.options.proxy`). Rust fetches desktop and Agent settings from the pinned API origin, and performs LLM/MCP calls.

Logs: `%LOCALAPPDATA%\vn.vnpay.tabledb\logs\tabledb.log` (5 MB rotation, keep 5), every line passes through `redact.rs`
(bearer/JWT, `password|token|secret|code_verifier…=` pairs, `code`/`state` URL params, URL userinfo).

If startup shows "Không tải được cấu hình desktop", the error screen includes the actual API URL, local config path, error code and failed stage. `E_DESKTOP_BOOTSTRAP` means local configuration failed before network traffic; IPC permission errors also appear directly. Native logs record `desktop configuration fetch started` and `native secure API sending` with the URL and request ID. Match that ID with the API server's `request_id`. `E_CONFIG_NETWORK` distinguishes connection/build/timeout errors; `handshake_http` shows the HTTP status, and `handshake_signature` points to a mismatch between the trusted desktop public key and the API's desktop signing key. Native API requests do not appear in the WebView Network tab. The native startup migrates valid old config files to the minimal prod config.

## SSO proxy

Server defaults use the SSO-only proxy `http://10.23.5.189:3359` via
`genaiProxyUrl` in server `DESKTOP_CONFIG`. This setting
does not route the TableDB API or JDBC connections through that proxy. Change this setting on the server; desktop installations retrieve it at startup.

On the login screen, expand **SSO login proxy**, enter the proxy username/password,
and save them once. They are stored as `proxy.sso.credentials` in Windows Credential
Manager, macOS Keychain, or Linux Secret Service (an unlocked desktop keyring is
required on Linux). They are never included in config.json, source, CI logs or installers.

The login screen automatically checks the proxy TCP port with a three-second timeout.
The proxy indicator is an icon: green when reachable, orange while checking, and red
when unreachable or the check fails. It is hidden when no proxy is configured. Click
it to check again; its tooltip includes the result and latency. The status check
does not disable SSO. The native core checks the proxy before reading credentials:
if the proxy cannot be reached, login opens a direct connection without requiring
proxy credentials or falling back to the general API proxy. A successful TCP check does not verify the
proxy username/password or the remote SSO site.

The app runs a loopback CONNECT bridge only for the active login session. It sends
Basic proxy authentication to the upstream proxy, forwards TLS without decrypting
it, and restricts tunnels to the configured broker hosts, `sso.vnpay.vn`,
`genai.vnpay.vn`, and Google login/resource domains (`google.com`, `gstatic.com`,
`googleusercontent.com` and their subdomains). The bridge and its tunnels stop on
success, cancellation, timeout or error.

The deployment sample uses `genaiLoginBrowser: "system"`: a separate Chrome/Edge
process with an app-specific profile and proxy, so Google login uses a real browser.
Install Chrome/Edge (or Chromium on Linux). The app closes that login browser when
the flow ends; **Forget SSO** also clears its separate profile. Normal browser
profiles and OS proxy settings are unchanged. `"internal"` also supports the bridge,
but Google may refuse embedded browsers. See [Google's native-app OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app).

## Building on Windows

Prerequisites: Windows 10/11 x64, Visual Studio Build Tools (C++), Rust stable (MSVC), Node 24, JDK 21 (with jmods; `JAVA_HOME` set), Maven, WebView2 (installer bootstraps it),
NSIS is downloaded by Tauri automatically.

```powershell
mvn -f services/jdbc/pom.xml package                    # -> services/jdbc/target/tabledb-jdbc.jar
cd apps/desktop
./scripts/build-desktop.ps1 -ApiOrigin https://tabledb-api.vnpay.vn   # jlink JRE -> stage sidecar -> web build -> tauri build (NSIS)
```

Output: `src-tauri/target/release/bundle/nsis/VNPAY TableDB_<ver>_x64-setup.exe` (per-user install, no admin). Steps can be run/skipped separately:
`scripts/build-jre.ps1`, `scripts/stage-sidecar.ps1` (verifies each driver's SHA-256 against `drivers/manifest.json` before copying), flags `-SkipJre -SkipSidecar -SkipWeb`.

**JRE modules** (`build-jre.ps1`): base set `java.base, java.logging, java.sql, java.naming, java.net.http, java.management, java.security.jgss, java.security.sasl, java.xml,
jdk.unsupported, jdk.httpserver, jdk.crypto.ec, jdk.naming.dns` (modules missing in the chosen JDK are skipped). When `services/jdbc/target/tabledb-jdbc.jar` exists the
`jdeps --print-module-deps` result is merged in. Drivers are loaded reflectively so jdeps cannot see their needs – smoke-test each driver (PG, Oracle, Trino, Trino SSO) against the built installer.

### Signing
* **Installer (Authenticode):** import your code-signing cert into the Windows store and pass `-CertThumbprint <sha1>` (CI does this from secrets). Unsigned builds trigger SmartScreen warnings.
* **Updater:** `tauri signer generate -w tabledb-updater.key` once; keep the private key secret (`TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`), pass the public key with `-UpdaterPubkey` and the manifest URL
  with `-UpdaterEndpoint`. `tauri.conf.json` ships **placeholders** (`REPLACE_WITH_…`, `updates.example.invalid`) that are inert; without real values updater artifacts are not produced and `check()` fails.
  The SPA uses `@tauri-apps/plugin-updater` (`check`, `downloadAndInstall`); update manifest hosting (static `latest.json`) is up to infrastructure.

### CI
`.github/workflows/desktop-build.yml` builds the desktop app on five native environments:

| Artifact | Build environment | Packages |
|---|---|---|
| `tabledb-windows-x64` | Windows Server 2022, x64 | NSIS `*-setup.exe`, including the offline WebView2 installer |
| `tabledb-macos-arm64` | macOS 14, Apple Silicon | `.dmg` |
| `tabledb-macos-x64` | macOS 15, Intel | `.dmg` |
| `tabledb-ubuntu-x64` | Ubuntu 22.04 container, x64 | `.deb`, `.AppImage` |
| `tabledb-debian-x64` | Debian 12 container, x64 | `.deb` |

The default deployment API is `https://10.23.5.40:8080/c/`. To build for another deployment, choose **Actions → Desktop builds → Run workflow** and set the optional `api_origin` input. The default does not use the old `TABLEDB_API_ORIGIN` repository variable. HTTPS is accepted for any host; HTTP is accepted for localhost, loopback IPs and RFC1918 private IPv4 addresses. Pushes to `main`, tags matching `desktop-v*`, and relevant pull requests also trigger builds.

The shared assets job uses the root npm lockfile, builds the SPA with `VITE_TARGET=desktop`,
tests/builds the JDBC jar and fetches the pinned JDBC drivers with checksum verification.
Each platform creates its own JRE from Temurin JDK 21, smoke-tests the sidecar, runs Rust
tests and builds Tauri packages. The API origin is injected into the CSP while preserving
the Agent sandbox directive, and into the compiled `deployment.json`. Changing the API base or signing key requires rebuilding and installing the desktop binary.

Download packages from the run's **Artifacts** section. Each platform artifact includes
`SHA256SUMS.txt` and is retained for 30 days. The Linux builds need a desktop environment
and the relevant WebKitGTK runtime; Ubuntu/Debian packages are built separately against
their respective distributions. The Windows installer can bootstrap WebView2 without
internet; the app still needs access to its configured API and databases.

Builds of tags matching `desktop-v*` also publish installers to the matching GitHub
Release after all five platform builds succeed. This includes manual workflow runs
on those tags. Release asset filenames are prefixed with the platform artifact name
to avoid collisions, and `SHA256SUMS.txt` covers all release installers. Re-running
a tag build replaces assets with the same names in its existing release. Builds of
`main` and pull requests only upload workflow artifacts.

Windows installers are unsigned, macOS apps are ad-hoc signed without notarization, and updater
artifacts are disabled. Production certificate signing can be added separately; the
manual Windows script above still supports certificate/updater signing parameters.

## Development

```powershell
cd apps/web; npm run dev            # SPA on :5173
cd apps/desktop; npm install; npm run dev
# optional local sidecar without bundling (debug builds only):
$env:TABLEDB_DEV_JAVA="C:\jdk21\bin\java.exe"; $env:TABLEDB_DEV_JAR="C:\src\TableDB\services\jdbc\target\tabledb-jdbc.jar"
```

Tests: `cargo test --manifest-path src-tauri/Cargo.toml` (needs `apps/web/dist/index.html` to exist because `generate_context!` embeds it; an empty stub is enough).
Icons in `src-tauri/icons` are flat placeholders – replace with the brand icon set (`npx tauri icon <png>`).

## Limits
Secrets are protected at the Windows-account level only (see ARCHITECTURE section 9). Without a Job Object the sidecar can outlive a hard-killed app until it notices stdin EOF (it should exit on EOF).

Agent endpoint/model lists and OpenMetadata settings come from authenticated `GET /api/v1/agent/config`, configured centrally with the server `AGENT_CONFIG` JSON environment variable (see `services/api/README.md`). Rust fetches and validates this config before using it for LLM/MCP requests. The legacy local `agent` section and `TABLEDB_OPENMETADATA_MCP_URL` do not override server settings. User LLM/MCP tokens remain in the OS credential store.

`desktop_config()` loads and validates public deployment settings before login; `agent_config({accessToken})` fetches authenticated Agent settings through the Rust bridge. Full defaults and examples are in `services/api/README.md`. LLM sampling/token limits, mapping paths, request timeout, Agent budgets, HTTP byte/path/time limits, MCP tool list/protocol and memory thresholds are server-managed. Bootstrap origin/env, compiled CSP, app signing/identity and protocol validation bounds remain local.

AES application transport, independent web/desktop keys and deployment settings: [SECURE-TRANSPORT.md](../../docs/SECURE-TRANSPORT.md).
