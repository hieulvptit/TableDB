# API v1 (services/api) — binding contract

Base: `https://<host>/api/v1`. JSON UTF-8. Errors: `{ "error": { "code": "FORBIDDEN|UNAUTHENTICATED|NOT_FOUND|VALIDATION|CONFLICT|RATE_LIMITED|UPSTREAM|INTERNAL|STEPUP_REQUIRED|INSUFFICIENT_STORAGE", "message": "…", "details"?: any } }` with matching HTTP status (401/403/404/400/409/429/502/500, STEPUP_REQUIRED=401 with header `X-Stepup: required`, INSUFFICIENT_STORAGE=**507**: server disk budget `DISK_MAX_USED_PCT` exhausted or the declared size would exceed it — returned by `POST /transfers` and `PUT /transfers/:id/parts/:n`; `details:{usedPct,limitPct}`; retry later).

Auth: web = cookie `__Host-sid` (httpOnly, Secure, SameSite=Lax) **+** header `X-CSRF-Token` on every non-GET (value from `GET /auth/me`). Desktop = `Authorization: Bearer <accessToken>` (no CSRF). Every route below requires auth unless marked *public*. Authorization is enforced server-side per route (permission and/or resource policy from `packages/shared/src/rbac.ts`).

## Auth
| Route | Notes |
|---|---|
| `GET /auth/config` *public* | `{ providers:[{id,label}], devLogin:boolean }` |
| `GET /auth/login?provider=<id>&returnTo=/path[&stepup=1]` *public* | 302 to IdP (Authorization Code + PKCE). `stepup=1` → `prompt=login&max_age=0`. `returnTo` must be a same-origin path. |
| `GET /auth/callback` *public* | IdP redirect target. Creates session, 302 to returnTo. |
| `POST /auth/logout` | Destroys session. |
| `GET /auth/me` | `{ user:{id,email,name,roles,permissions:[…]}, csrfToken, authTime, kind:"web"|"desktop" }` |
| `GET /auth/desktop/config?provider=<id>` *public* | `{ authorizeEndpoint, clientId, scopes:[…], redirectUriTemplate:"http://127.0.0.1:{port}/cb" }` |
| `POST /auth/desktop/exchange` *public* | `{ provider, code, codeVerifier, redirectUri }` → `{ accessToken, expiresAt, refreshToken, user }` |
| `POST /auth/desktop/genai` *public, rate-limited* | `{ token }` — JWT the desktop received from the SSO broker on its loopback listener. API verifies it either locally (HS256 signature + `exp`, key in `GENAI_JWT_KEY`, preferred) or via a broker verify endpoint that must answer `application/json`, applies `ALLOWED_EMAIL_DOMAINS`, provisions/links the user by email → `{ accessToken, expiresAt, refreshToken, user }`. `GET /auth/config` returns `desktopLoginUrl` when configured. |
| `POST /auth/desktop/refresh` *public* | `{ refreshToken }` → same shape (rotates refresh token). |

## Database (desktop only) — permission `db:connect`
Web BO has **no** database access and there is no JDBC service on the backend. Database connections are opened only by the desktop app through its local JDBC sidecar (`SIDECAR-PROTOCOL.md`). The API offers just:

| Route | Notes |
|---|---|
| `GET /db/targets` | Admin-approved catalog: `[{id,name,driver,host,port,database,allowWrite,authModes,requiresProxy,proxy,options}]` (no secrets). Desktop offers only these targets; the user supplies their own credentials (kept in Windows Credential Manager). |
| `POST /db/audit` | Desktop-reported audit. Body either `{targetId,event:"open"|"open_failed"|"close",authType?,route?}` (`route` ≤ 300 ký tự: mô tả đường SSH/proxy, vd. `SSH bastion:22 → jump:22`, không có bí mật; lưu vào `detail.route`) or `{targetId,mode:"read"|"write",sql,ok,rows?,ms?,errorCode?}`. Server masks literals, never stores rows, records `reportedBy:"desktop"`, and logs `db.query.policy_violation` when the report contradicts policy (write without `db:write`/target `allowWrite`, or DML in read mode). **The server cannot block execution** — enforcement is DB account privileges + sidecar read-only + classifier. |
| `POST /db/audit` (custom) | Kết nối tùy chỉnh (không thuộc danh mục): thay `targetId` bằng `custom:{driver:"postgresql"|"oracle"|"trino"|"custom",driverName?,host,port,database?,connectType?:"serviceName"|"sid",allowWrite}`, cùng hai dạng body (`event…` hoặc `mode,sql,ok,…`). `targetId` và `custom` loại trừ nhau, phải có đúng một. Cần quyền **`db:custom`** (403 nếu thiếu; thuộc mọi role mặc định). Action: `db.custom.session.<event>`, `db.custom.query`, `db.custom.query.policy_violation` (ghi khi write mà thiếu `db:write`/`custom.allowWrite`, hoặc DML ở chế độ read). `resource_type=db_custom`, `detail.endpoint` chỉ chứa thông tin đầu cuối (không credential). Server vẫn **không chặn được** thực thi. |

## Agent — permission `agent:use`
The Agent runs in the desktop app (harness, LLM and OpenMetadata calls, tokens, settings from the local `config.json`). The server has **no** chat/settings/token routes any more (they answer 404); it only keeps an audit sink.

| Route | Notes |
|---|---|
| `POST /agent/audit` | `{ action, connectionId?, …metadata }` with `action` ∈ `agent.chat`, `agent.token.set`, `agent.token.delete`, `agent.openmetadata.token.set`, `agent.openmetadata.token.delete`. Stored as an audit entry with `reportedBy:"desktop"` (not verifiable by the server). `question` and `answer` (the Q&A, redacted for card/email/phone/token patterns, 2000 chars each) and `sqlMasked` (≤5 SQL statements the Agent proposed, literals masked) are kept; both are redacted/masked again by the server. Keys named like `prompt`/`reply`/`content`/`text`/`sql`/`token`/`secret`/`password`/`messages`/`body` are dropped (no rows, images or tokens); at most 3 levels, 32 keys, 64 array items, 200 chars per string, 8 KiB body. `201 { ok:true }`; `400` on an unknown action. |

## Transfers — permission `transfer:create` / `transfer:approve` / `transfer:download`
| Route | Notes |
|---|---|
| `GET /transfers/options` | `{ leaders:[{id,name,email}], limits:{maxBytes,partBytes,allowedExtensions:[…],defaultTtlHours,maxDownloads} }` |
| `POST /transfers` | `UploadInit` → `201 { ticket: TicketView, partBytes, totalParts }` (status UPLOADING). `approverId` must be an active leader ≠ caller. `ticket.direction` is set by the server from the session kind (desktop → `JUMP_TO_OFFICE`, web → `OFFICE_TO_JUMP`); a `direction` in the body is ignored. |
| `GET /transfers/:id` | ticket (must be requester/approver/recipient/delegate/auditor) `{ ticket, events:[…], receivedParts:[n…], totalParts, uploader:{id,name,email}, upload:{startedAt,completedAt,durationMs,parts,throughputBps,clientKind,clientIp?,userAgent?}, fileType:{declaredExt,detected,label,mismatch,mismatchNote?,executable}\|null, scan:{result,signature?,scannedAt?,engine?,ms?}\|null, manifest:ManifestView\|null }`. `clientIp`/`userAgent` only with `audit:read`; `fileType`/`manifest` only for requester, approver, active delegate, `audit:read` (see `AUDIT-TRAIL.md`). |
| `GET /transfers/:id/manifest?offset=&limit=&verify=1` | same visibility as above. `ManifestView = { status:"ok"\|"error", inspectError?, inspectedAt, durationMs, manifestHash, summary:Manifest, entries:{offset,limit,total,items:[Entry]}, hashVerified? }`. `limit` ≤ 500 (default 100). Metadata only — never file content or cell values. |
| `GET /transfers/:id/trace` | `audit:read`, or requester/approver/delegate of the ticket → `{ ticket:{id,code}, entries:[audit rows ascending], redacted }` (network fields removed for non-auditors). |
| `PUT /transfers/:id/parts/:n` | body `application/octet-stream`, header `X-Part-SHA256`. Idempotent per part (same hash → 200, different → 409). Requester only, UPLOADING only. |
| `POST /transfers/:id/complete` | header `Idempotency-Key` required. Verifies all parts + whole-file SHA-256 → SCANNING and enqueues scan; repeated key returns the same result. `409` lists missing parts. |
| `POST /transfers/:id/abort` | requester, UPLOADING → ABORTED (parts deleted). |
| `GET /transfers?view=sent|inbox|approvals|all&status=` | lists. `approvals` = tickets where caller is approver or active delegate. `all` needs `audit:read`. |
| `POST /transfers/:id/decision` | `{decision:"approve"|"reject", reason?}` — only designated approver/delegate; never the requester. Writes immutable audit + `approvals` row and queues the decision email to the requester (and recipients on approve). Approval only ever happens here, after SSO login — never via an email link. |
| `POST /transfers/:id/revoke` | requester or admin; revokes download rights. |
| `POST /transfers/:id/download-token` | Re-checks policy + step-up (`auth_time` age ≤ configured) → `{ url, expiresInSec }` (single-use, TTL ≤ 60 s) — or `401 STEPUP_REQUIRED`. Only the destination side may download: `403` for a web session on an `OFFICE_TO_JUMP` ticket and for a desktop session on a `JUMP_TO_OFFICE` ticket (checked again at download). |
| `GET /transfers/:id/download?t=<token>` | Streams decrypted file after re-checking policy at that moment; records download (user, time, ip, sha256). `Content-Disposition: attachment`, `X-Content-SHA256`. |
| `POST /transfers/:id/change-approver` | admin `{approverId}` (audited; a new approval-request email goes to the new approver). |
| `GET/POST /delegations`, `DELETE /delegations/:id` | leader creates time-boxed delegation `{toUserId, validFrom, validTo}`. |

## Admin — permission `admin:manage` (`audit:read` for audit)
Không còn route `/admin/*` (đã bỏ; danh sách người duyệt lấy từ HRM `/hrm/v1/api/managers`). `GET /audit?actor=&actorEmail=|q=&action=&resourceId=&ticket=<code>&from=&to=&limit=&before=` (rows include `prevHash`,`hash`), `GET /audit/verify` (hash-chain check; success also writes the marker that allows old file copies to be pruned), `GET /audit/export?from=&to=&format=csv|jsonl` (`audit:read`, streamed, audited as `audit.export`, 10/min; JSONL verifies offline with `cmd/auditverify`). Catalogue of actions and fields: `AUDIT-TRAIL.md`.

## Integrations
There are no inbound integrations; the only outbound integrations are SMTP (notification), the LLM endpoint and the OIDC IdP.
`GET /healthz` *public* (liveness; `{ok, disk:{usedPct,limitPct,state:"ok"|"warn"|"blocked"}}`), `GET /readyz` (db + storage + the same `disk` field). `state=blocked` means new uploads are refused with 507 until space is freed.

## TicketView
See `packages/shared/src/schemas.ts` (`TicketView`). Status labels VI: `STATUS_LABEL_VI` in `ticket-state.ts`. `notifyState` = `PENDING|SENT|ERROR` (delivery of the approval-request email, independent of `status`).
