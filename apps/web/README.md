# @vnpay/web — two build targets of one SPA codebase

One React + TypeScript (Vite) codebase, **two products**, selected at build time by `VITE_TARGET` (`web` default | `desktop`). Each bundle contains only its own product; the other target's pages, API bindings and i18n strings are removed by build-time constants (`import.meta.env.VITE_TARGET === 'desktop'` folds to a literal, so the dead branch and its dynamic `import()` disappear) — there is no runtime `isTauri()` switch any more.

| | **web** (BO portal, nginx) | **desktop** (Tauri shell) |
|---|---|---|
| Purpose | approve, download, administer | query databases, upload files |
| Pages | `/transfers` (sent = read-only + revoke, inbox), `/transfers/:id` (detail, timeline, download, revoke, approve/reject, admin approver change), `/approvals` (+ delegations), `/admin` (db-target catalog, transfer targets, leaders, users, outbox), `/audit`, `/login` | `/tabledb` (connections, tree, editor, results, **Agent panel**), `/transfers/new` (chunked, resumable upload wizard), `/transfers` ("Lượt gửi của tôi", view=sent), `/transfers/:id` (status, timeline, resume, abort, revoke), `/login` |
| Auth | cookie session + CSRF | OIDC via system browser, bearer tokens in the OS credential manager |
| Router | `BrowserRouter` | `HashRouter` |
| DB access | **none** (no TableDB, no gateway, no sidecar/`/db/sessions`) | `TauriGateway` only (local sidecar) |
| Not included | TableDB, Agent, upload wizard/uploader/hashing, Tauri bridge | approvals, delegations, download, admin, audit pages |

UI language is Vietnamese; strings are split per target: `src/i18n/vi.common.ts` (both), `vi.web.ts`, `vi.desktop.ts` (`src/i18n/index.ts` bundles common + the target's dictionary; under vitest both are loaded). The design system is `@vnpay/ui` (`packages/ui`).

## Commands

```bash
npm install                        # at the monorepo root (workspaces)
npm run dev -w @vnpay/web            # web target, http://localhost:5173, /api proxied to http://localhost:8080 (override: VITE_DEV_API)
npm run dev:desktop -w @vnpay/web    # desktop target in a browser tab (Tauri commands unavailable)
npm run build -w @vnpay/web          # web target: tsc --noEmit + vite build -> apps/web/dist (base "/")
npm run build:desktop -w @vnpay/web  # desktop target: VITE_TARGET=desktop, base "./" for Tauri -> apps/web/dist (same folder; build one at a time)
npm test -w @vnpay/web             # vitest (jsdom, Testing Library)
cd apps/web && npx tsc --noEmit    # type check (also covers packages/ui sources)
```

Environment (`import.meta.env`): `VITE_TARGET` (`web`|`desktop`), `VITE_API_BASE` (default `/api/v1`), `VITE_ENV` (env badge on web: `test|prod|dev`), `VITE_PART_BASE` (desktop upload part numbering, default `1`, see "API notes").
On desktop the API base and env come from `app_info()` (`apiBaseUrl` from the desktop `config.json`; `/api/v1` is appended if missing).

### nginx (web)
Serve `dist/` and fall back to `index.html` (BrowserRouter), proxy `/api/` to the API:
```
location /api/ { proxy_pass http://api:8080; }
location /      { try_files $uri /index.html; }
```
The SPA only needs `connect-src 'self'` (+ the API origin on desktop) and no inline scripts.

## Structure

```
src/
  main.tsx      picks web/boot or desktop/boot through a build-time constant, then renders <App/>
  target.ts     TARGET constant; AppShell.tsx providers + router (browser | hash)
  web/          boot.ts, WebApp.tsx, routes.tsx (WebRoutes)          <- only imported by the web bundle
  desktop/      boot.ts (app_info, secret token store), DesktopApp.tsx, routes.tsx (DesktopRoutes)   <- desktop bundle only
  api/          client.ts (ApiClient/apiClient), errors.ts, tokens.ts (memory store), types.ts,
                services.ts (calls both targets use), services.web.ts (approvals/download/delegations), services.desktop.ts (upload)
  auth/         AuthContext (session, permissions, RequireAuth guard), login.ts (web redirect, step-up wiring), desktopLogin.ts (oidc; desktop only), LoginPage
  gateway/      DbGateway interface, TauriGateway (the only implementation), DbApi          <- desktop only
  runtime/      tauri.ts (bridge + command wrappers), secretTokenStore.ts, RuntimeContext    <- tauri/secretTokenStore desktop only
  features/
    tabledb/    catalog.ts (GET /db/targets filter + sidecar profile), profiles.ts (local profiles), audit.ts (audit reporter), connect panel, schema tree, CodeMirror editor, query tabs, write gate   <- desktop
    agent/      token setup, chat, context disclosure, sql block, rows consent                <- desktop
    transfers/  shared: TicketBadges, TicketList, TicketInfo (fields/timeline/revoke)
                web: MyTransfersPage, TicketDetailPage, ApprovalsPage, DecisionPanel, download.ts
                desktop: NewTransferPage, DesktopMyTransfersPage, DesktopTicketDetailPage, uploader.ts, uploadFlow.ts, hash.ts
    admin/      ResourceManager + Admin (db-target catalog, transfer targets, leaders, users/roles, outbox) and Audit pages   <- web
  i18n/         index.ts (t, errorMessage), vi.common.ts / vi.web.ts / vi.desktop.ts (vi.ts = union, tests only)
```

`src/routes.test.tsx` enforces the split: per-target router tests (web has no `/tabledb`, `/transfers/new`; desktop has no `/approvals`, `/download`, `/admin`, `/audit`) and an import-graph test (web boot must not reach tabledb/agent/gateway/tauri/uploader; desktop boot must not reach admin/approvals/download).

## Runtime abstraction

* **`apiClient`** (one instance, `src/api/client.ts`)
  * web: cookie session (`credentials: include`) + `X-CSRF-Token` on every non-GET; token comes from `GET /auth/me` (fetched lazily if unknown, re-fetched once if the server reports a stale token).
  * desktop: `Authorization: Bearer <accessToken>`, no CSRF, no cookies; tokens are stored through `secret_set/get/delete` (`auth.accessToken`, `auth.refreshToken`, `auth.expiresAt`), proactively refreshed 30 s before expiry and on 401 via `POST /auth/desktop/refresh` (single-flight).
  * errors: `{error:{code,message,details}}` -> `ApiError` (`code`, `status`, `details`); `NETWORK`/`ABORTED` synthesised; `X-Stepup: required` is recognised even without a body.
  * `STEPUP_REQUIRED`: web -> navigate to `/api/v1/auth/login?provider=<last>&returnTo=…&stepup=1` (or SPA `/login?stepup=1` if no provider is remembered); desktop -> `oidc_begin` again (`prompt=login&max_age=0`) + `/auth/desktop/exchange`, then the original request is retried once.
* **`DbGateway`** (desktop only; `open/test/close`, `rpc(method, params)`, `cancel`, `subscribe`, `subscribePending`)
  * `TauriGateway` is the only implementation (there is no `HttpGateway`, and nothing in the SPA calls `/db/sessions`, `/db/profiles` or `/db/events`): `sidecar_request({method, params})`, `sidecar_cancel({queryId})`, event `sidecar:event`. Sends `session.open` with `options.readOnly=true` by default; cursor methods (`query.fetch/cancel/closeCursor`) are sent without `sessionId`, everything else with it.

### Desktop command contract (what the SPA calls — apps/desktop must match)
| Command | Args (single object) | Returns |
|---|---|---|
| `app_info` | – | `{ version?, env?, apiBaseUrl? }` |
| `open_external` | `{ url }` | – (SPA only sends http/https URLs) |
| `secret_set` / `secret_get` / `secret_delete` | `{ key, value }` / `{ key }` / `{ key }` | – / `string \| null` / – |
| `oidc_begin` | `{ params: { authorizeEndpoint, clientId, scope?, extraParams?, timeoutSec? } }` | `{ code, redirectUri, codeVerifier }` (camelCase, as `oidc.rs`) |
| `genai_login_begin` | `{ params: { loginUrl, timeoutSec? } }` | `{ token }` (VNPAY SSO broker JWT; sent to `POST /auth/desktop/genai`, never logged) |
| `genai_login_forget` | – | – (deletes the login window's SSO cookie profile; called on logout after `/auth/logout`) |
| `genai_login_cancel` | – | – (aborts the pending `genai_login_begin` -> `E_GENAI_CANCELLED`) |
| `sidecar_request` | `{ method, params }` | protocol result; errors as `{code,message,sqlState?,retryable?}` or string |
| `sidecar_cancel` | `{ queryId }` | `{cancelled}` or bool |
| `workspace_load` / `workspace_save` / `workspace_clear` | – / `{ data }` / – | `string \| null` / – / – (editor tabs/history/snippets as one JSON document, AES-256-GCM file in app data; clear also deletes the key) |
| `transfer_save_begin` / `transfer_save_chunk` / `transfer_save_finish` / `transfer_save_abort` | `{ params:{fileName,size,sha256} }` / raw bytes + header `x-save-handle` / `{ handle }` / `{ handle }` | handle (E_CANCELLED if the save dialog is cancelled) / – / saved file name (E_INTEGRITY on size/SHA-256 mismatch; nothing is left under the chosen name) / – |
| event `sidecar:event` | payload `{event, seq, data}` | – |

Secret keys used: `auth.*` and `db.profile.<id>.password` (allowed by `secrets.rs::validate_key`). Keys starting with `internal:` (e.g. the workspace key) are reserved for the Rust core and refused from the WebView.

## What the pages do

### Desktop
* **Login**: `GET /auth/config` returns `desktopLoginUrl`. If set (and target is desktop) the login page shows a single **"Đăng nhập VNPAY SSO"** button (`auth/GenaiLoginPanel.tsx`): `genai_login_begin` -> `POST /auth/desktop/genai {token}` -> tokens into the credential store (same as the OIDC flow; refresh via `/auth/desktop/refresh`), with a waiting state + cancel and friendly errors. API failures show the HTTP status/code with a specific message (401 token invalid/expired, 403 email domain not allowed, 502 VNPAY auth server invalid response); the generic network/proxy message is only used when no HTTP response arrived. After the token exchange the session is re-read strictly (`refresh({strict:true})`), so a failing `/auth/me` is shown instead of silently bouncing back to the login page. If `null`, the existing per-provider OIDC flow (`oidc_begin`) is used. The broker panel is lazy-loaded only when `VITE_TARGET=desktop`. Logout (desktop, broker session) always forgets the SSO login: the API session is revoked first, then `genai_login_forget` runs. On start the stored tokens are used silently: an expired access token with a valid refresh token is refreshed (`/auth/desktop/refresh`, rotated tokens stored) before the login page is considered; only a 4xx refresh rejection drops the stored session (a network failure keeps it for the next start). Step-up for a broker session re-runs the broker round-trip (no forced re-auth available).
**TableDB** (`/tabledb`, permission `db:connect`): layout = schema tree | editor+results | Agent.
* **Connection catalog**: the list of connectable databases is `GET /api/v1/db/targets` (admin-defined; fields `id,name,driver,host,port,database,allowWrite,authModes,requiresProxy`, optionally `proxy`/`options`). `filterCatalog()` drops entries the app cannot use (unknown driver, bad host/port, no valid auth mode, duplicate ids). The user only supplies their **own credentials** (username/password, or Trino SSO); host/port/driver/database, proxy and options (`ssl`, `connectTimeoutSec`) are taken **only from the catalog entry** (`profileFromTarget`). If `requiresProxy` is true but the catalog gives no `proxy`, the app refuses to connect (no silent direct connection).
* **Local profiles** (`profiles.ts`): saved sign-in preferences per catalog target (name, target id, auth mode, username, default schema, "save password") in localStorage under `tabledb.localProfiles.v2` — non-secret only; the password (opt-in) is stored with `secret_set` (`db.profile.<id>.password`). Profiles whose target left the catalog (or no longer offers the auth mode) are hidden.
* Trino SSO keeps the waiting UX: "Đang chờ đăng nhập SSO trong trình duyệt…", `auth.openUrl` (http/https only) opened via `open_external`, with a re-open link; the URL event arrives while `session.open` is pending (`subscribePending`).
* **Write mode** needs all of: `db:write` in `/auth/me` permissions, `target.allowWrite`, and the confirmation dialog per statement (`decideRun` -> `WriteConfirmDialog` with the exact statement + acknowledgement; only then `query.execute` with `mode:"write", confirmWrite:true` of the *shown* statement). The sidecar session is opened with `allowWrite = db:write && target.allowWrite`.
* **Audit reporting** (`audit.ts`): after each executed statement (success, failure or cancel) the app posts `POST /api/v1/db/audit` `{targetId, mode:'read'|'write', kind:'read'|'write'|'ddl'|'other', sql, ok, rows?, ms?, errorCode?}` (raw SQL — the server masks literals; `rows` is a count, never row data). Session lifecycle uses the same endpoint: `{targetId, event:'open'|'open_failed'|'close', authType}` (connection tests are not reported). `AuditReporter` is fire-and-forget: `report()` returns immediately and never throws, records are sent in order, failures are retried with exponential backoff (2 s doubling, capped at 60 s, 8 attempts), permanent refusals (400/404/405/409/413/422) are dropped, the queue is bounded (500, oldest dropped) and memory-only (SQL text is not persisted on the workstation). The body is built through an explicit whitelist so result rows cannot leak even by mistake. Client-side rejections (multi-statement, not-a-read in read mode…) never reach the sidecar and are not reported.
* Tree: catalogs -> schemas -> tables/views -> columns, every level lazy; details pane shows types, PK/FK, remarks, and DDL on demand (`meta.ddl`); double-click inserts `SELECT … LIMIT 100`/`FETCH FIRST`.
* Editor: CodeMirror 6, dialect per driver, **completion is `schemaCompletionSource` only**. Multi-tab, Ctrl+Enter, run/cancel (`query.cancel`), max rows (≤100000) and timeout (≤600 s), paginated grid with `query.fetch`, client-side CSV export.

**Agent panel** (runs locally, server provides `/agent/config` and receives audit; see `features/agent/service.ts`): token setup (endpoints/models from server `GET /agent/config` via Rust `agent_config`, paste token, verified with a 1-token call and stored in the OS credential store, re-verify, delete with confirm); chat through the local harness (`features/agent/harness/`, network via the Rust `agent_http` bridge); `ContextDisclosure` shows the manifest built locally **before** sending and the manifest of the run **after**. Only a metadata-only audit record goes to `POST /agent/audit`. Selected tables are the default context; related tables (FK, one level) are an unchecked opt-in. Rows: only selected in the grid (≤20) **and** confirmed in a dialog; attached to the next message only. Replies are plain text; ```sql blocks get a read/write/ddl/other badge and "Chèn vào editor" / copy — there is no run button.

**Upload** (`/transfers/new`, `/transfers`, `/transfers/:id`, permission `transfer:create`): wizard (limits from `/transfers/options`, purpose ≥5, target, leader, incremental SHA-256 with `@noble/hashes` in 4 MiB slices, part size from the server, 3 parallel parts, per-part SHA-256 header, exponential-backoff retry for network/5xx/429, no retry for 409/4xx, abort/cancel calls `/abort`, `Idempotency-Key` on complete). Detail page: status + approver-email notify badge, timeline, resume (asks `GET /transfers/:id` for `receivedParts`, requires re-selecting the same file: size + SHA-256 verified), abort, revoke. No approvals, no download, no admin.

### Web (BO portal)
**Personal skills and specialist agents:** in the Agent panel, open **Skills & agents cá nhân / Personal skills & agents**. Create a skill with its identifier, display name, usage description and Markdown instructions; create an agent and assign up to 12 bundled or personal skills. Three editable templates cover transaction reconciliation, business reporting and data analysis. Add templates explicitly; existing definitions are never overwritten. Choose the specialist from the chat selector, or leave **Automatic** for the orchestrator to delegate when relevant. Changing the specialist starts a new chat; saved sessions retain the selection. Disabled/deleted selected agents produce a validation error rather than silently changing roles.

Definitions are kept in the same encrypted desktop workspace as chat history (up to 20 skills / 10 agents). Active catalogs and the selected specialist's instructions are sent to the configured LLM; personal skill bodies load on demand via `load_personal_skill`. User-authored content stays at user/tool priority and cannot replace bundled skills, execute SQL, add tools or bypass the shared call/time budget. OpenMetadata is off for new specialists and templates; it can be enabled in the agent editor, subject to the configured read-only tools and the user's credential. Deleting a personal skill removes its agent bindings. Plain conversation summaries do not use specialist profiles.

**Custom connections (`db:custom`)** (`features/tabledb/CustomConnect.tsx`, `custom.ts`, `DriverManager.tsx`): every user (`db:custom` is in the default `user`/`leader`/`admin` roles; profiles are stored locally only, never shared) gets a "Kết nối tùy chỉnh" tab next to the admin catalog. They type host/IP, port, Oracle **Service name or SID** (`options.connectType`), user/password, default schema, SSL, connect timeout and up to 20 extra driver properties (`options.props`; key regex `^[A-Za-z][A-Za-z0-9_.$-]{0,79}$`, `user`/`password`/`javax.net.ssl.*`/`java.*` denied, values ≤256 chars). A quick-paste box parses `host:port/service`, `//host:port/service`, `host:port:SID` (`parseEndpoint`). Host is validated with the sidecar's HOST rule. Write mode = `db:write` AND the form's "Cho phép ghi" checkbox (`allowWrite` in the sidecar profile) AND the per-statement confirmation. Other databases: the driver manager (desktop only) calls the Rust commands `driver_import` (native multi-file `.jar` picker; JARs copied to app data + sha256 in the manifest), `driver_list`, `driver_remove` (`desktopCommands.driverImport/driverList/driverRemove`); an imported driver is selected as `driver:"custom"` + `driverId`, with `host/port/database` substituted into its URL template `{host}/{port}/{database}` by the sidecar. Imported drivers use the generic PostgreSQL-style dialect in the editor/agent context. Local saved profiles for custom connections keep only non-secret fields (`LocalProfile.custom`), the password stays opt-in in the OS credential manager. The `Connection` has `custom` (endpoint) and a synthetic `targetId = custom:<session>`; audit reports (`/db/audit`) then carry `custom:{driver,driverName?,host,port,database?,connectType?,allowWrite}` **instead of** `targetId`. Admin users page: `db:custom` is a grantable permission next to `db:write`.

**Transfers** (`/transfers`, `/transfers/:id`): the sender's own list ("Đã gửi", read-only; revoke on the detail page) and the inbox ("Hộp nhận"); detail = fields, status/notify badges, timeline, **download** (`POST download-token` then browser navigation, step-up handled centrally), revoke, approve/reject (mandatory reject reason, `DecisionBody`) and admin approver change. **Approvals** (`/approvals`): master/detail + delegation management (≤30 days, delegates must be leaders). **Admin** (`/admin`, `admin:manage`): db targets (this is the catalog the desktop reads from `/db/targets`), transfer targets, leaders, users/roles/grants/active, outbox monitor (+retry). **Audit** (`/audit`, `audit:read`): filters, load-more, hash-chain verify.

Controls are hidden by `/auth/me` permissions, but every call can still return 403, which is rendered as a normal "no access" state / inline message (never a crash). `ErrorBoundary` wraps the app and each route.

Layout is designed for widths >= 1100 px (shell `min-width: 1100px`); skip link, labelled fields, focus-trapped dialogs, roving-tabindex tabs/tree, keyboard-resizable split panes, live regions for status.

## Tests (Vitest + Testing Library, `src/**/*.test.ts(x)`)
Per-target routers (web has no `/tabledb`/`/transfers/new`; desktop has no `/approvals`/`/download`/`/admin`) + import-graph boundaries (`routes.test.tsx`); audit reporter (whitelist/no row data, ordered delivery, queue + exponential backoff retry, permanent-error drop, bounded queue) and audit hooks in the store (`audit.test.ts`, `writeGate.test.tsx`); catalog filtering, local-profile filtering, catalog-only session profile, write gating inputs (`catalog.test.ts`); TauriGateway; apiClient (CSRF, bearer, refresh, step-up web/desktop, error mapping, no retry loops); desktop login & step-up; upload chunker (incremental hash = node crypto, parallelism, resume, retry/backoff, 409 fatal, abort); `ContextDisclosure`, context body builders, `SqlBlock`/`parseReply`; write gate (`decideRun`, `WriteConfirmDialog`, the store never executes a write before confirmation and runs the shown SQL); route guard; TableDB page smoke (catalog -> connect through a stubbed `sidecar_request` -> lazy tree -> run -> grid -> audit posts, real CodeMirror in jsdom); ticket list/decision panel; i18n key completeness **per target** (each source file's keys must exist in common + its target dictionary; dictionaries do not overlap). MSW is not used (plain `fetch` stubs).

### Bundle checks (run after both builds; build one target at a time, both write `dist/`)
```bash
npm run build -w @vnpay/web && cd apps/web/dist
! grep -rliE "sidecar_request|cm-editor|X-Part-SHA256|db/sessions|db/profiles|db/events|db/audit|oidc_begin|genai_login|create-jwt-token" .    # web: no output
cd ../../.. && npm run build:desktop -w @vnpay/web && cd apps/web/dist
! grep -rliE "download-token|/delegations|/decision|change-approver|/admin/|outbox" .                              # desktop: no output
```

## API notes / mismatches found (and how they were handled)
1. **HTTP DB sessions are gone from the SPA.** The web target has no DB code at all; the desktop connects through the local sidecar only, so the earlier "Trino SSO over HTTP gateway" mismatch (`/db/events` polling) no longer applies. `services/api` routes `/db/sessions*` are unused by this SPA.
2. **Desktop-facing API contract** (implemented on the SPA side; must exist in `services/api`): `GET /db/targets` -> catalog (bare array or `{targets}`; fields `id,name,driver,host,port,database,allowWrite,authModes,requiresProxy`, optional `proxy {type,host,port}` and `options {ssl,connectTimeoutSec}` — the SPA uses `proxy`/`options` only if present; **if the API withholds the proxy config and only sets `requiresProxy`, the desktop refuses to connect**), and `POST /db/audit` with either the query body or the `{targetId,event,authType}` session body (see above); the SPA ignores the response and treats 400/404/405/409/413/422 as "do not retry".
3. `/transfers*`, `/delegations`, `/admin/*`, `/audit*` were added to `services/api` while this was being built; the SPA was then aligned with the real code: list envelopes (`{tickets}`, `{targets}`, `{leaders}`, `{users}`, `{jobs}`, `{delegations}`, `{entries}`; `asList` also accepts bare arrays), ticket events are raw rows `{id, at, actor_id, kind, data}`, `GET /admin/db-targets` returns raw snake_case rows (`allow_write`, `auth_modes`, plus `proxy`/`options` which are round-tripped on edit because `PUT` validates the full object), audit rows use `seq` (`before=<seq>`; `actor` filter must be a UUID; `action` is a prefix match; verify returns `brokenAtSeq`), user grants only accept `db:write` in the UI, delegations are capped at 30 days and delegates must be leaders. Not covered by the API: admin "delete" of db/transfer targets is a soft-disable (`enabled=false`) so they stay in the list.
4. **Upload part numbering** is 1-based in the API (`PUT /transfers/:id/parts/:n`, `1..totalParts`), which is the SPA default; `VITE_PART_BASE=0` exists only as an escape hatch. The API also requires each part to be exactly `partBytes` (last part = remainder) and the `X-Part-SHA256` of the part — both satisfied by the chunker.
5. **Download**: `POST download-token` returns an absolute URL built from the API's `PUBLIC_URL`, and `GET …/download` additionally requires an authenticated caller (`transfer:download`). The SPA therefore keeps only path+query of the URL and re-anchors it to the page origin; the web target navigates (session cookie). There is no download on the desktop target.
6. Desktop command argument shapes (table above) are my reading of the docs and `apps/desktop/src-tauri/src/*.rs` (commands themselves were not present yet). `oidc_begin` takes `{params}` — adjust in `src/runtime/tauri.ts` only if the command signature differs.
7. `rpc` returns the sidecar result directly (verified in `routes/db.ts`); the gateway also tolerates a `{result}` wrapper. `query.cancel` uses the caller's `queryId` (the API prefixes it with the session id itself).
8. Nothing needed to change in `packages/shared`. (Nice-to-have: export a `PreviewBody` type / make `AgentChatBody.messages` optional for `context-preview`; the SPA sends no `messages` for previews and relies on the API's `partial`.)

## Not verified
Real API/DB/JDBC/Tauri/IdP were not available: everything above is tested against stubs/jsdom only. No real browser run (layout at 1100 px, CodeMirror popup interaction, focus visuals, dark-mode contrast) and no automated a11y audit. Large-file hashing throughput/memory was not measured (pure-JS SHA-256, O(4 MiB) memory). `apps/desktop` integration (command names/shapes, `withGlobalTauri`, `tauri://` CSP) is untested.
