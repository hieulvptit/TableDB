# TableDB API — bản Go (`services/api`)

Viết lại backend Node/Fastify `services/api` bằng Go (module `vnpay/tabledb-api`), **thay thế trực tiếp** (drop-in): cùng base path `/api/v1`, cùng route, cùng JSON, cùng mã trạng thái và dạng lỗi `{error:{code,message,details?}}`, cùng cookie/CSRF/bearer, cùng biến môi trường, cùng migration SQL (nhúng bằng `go:embed`).
SPA web (`apps/web`) và desktop gọi API này không cần đổi gì. Tài liệu hợp đồng: `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY-FINDINGS.md`.

> **Trạng thái: hoàn tất (giai đoạn 1 + 2).** Đã port toàn bộ. **Agent không còn chạy ở server**: harness, LLM, OpenMetadata MCP, token nằm trong app desktop; cấu hình triển khai lấy từ server (`apps/web/src/features/agent/`, cầu HTTP ở lõi Rust). Server cung cấp `GET /api/v1/agent/config` và `POST /api/v1/agent/audit` (sink audit metadata, `internal/agent/audit.go`).

## Chạy / build / test

```bash
cd services/api

# dev: không cần Postgres — tự khởi động PostgreSQL thật (embedded-postgres, tải binary lần đầu ~vài chục MB)
APP_ENV=dev ALLOW_DEV_LOGIN=1 DEV_LOG_MAIL=1 \
BOOTSTRAP_ADMINS=you@vnpay.vn DEV_SEED_LEADERS="leader1@vnpay.vn:A,leader2@vnpay.vn:B" \
PORT=8090 go run ./cmd/server

go build -o tabledb-api ./cmd/server      # binary tĩnh (CGO_ENABLED=0 cũng được)
GOOS=windows GOARCH=amd64 go build -o tabledb-api.exe ./cmd/server   # Windows (xem docs/OPERATIONS.md §2b, deploy/windows/)
go vet ./... && go test ./...             # test cần mạng lần đầu để tải PostgreSQL embedded
docker build -t tabledb-api .          # distroless/static, CGO off (prod: bắt buộc DATABASE_URL)
```

* **Dev/test không có `DATABASE_URL`**: dùng [`fergusstrange/embedded-postgres`](https://github.com/fergusstrange/embedded-postgres) (PostgreSQL 16 thật, cổng ngẫu nhiên, tắt sạch khi thoát) — thay cho PGlite. `PGLITE_DIR` (tên giữ nguyên để tương thích) là **thư mục dữ liệu**; để trống = thư mục tạm bị xoá khi tắt. Thư mục PGlite cũ **không** dùng lại được.
* **Prod** bắt buộc `DATABASE_URL`; image Docker không chứa PostgreSQL embedded.
* Test: một PostgreSQL embedded cho cả binary test (`internal/apitest`), mỗi test một database nhân bản từ template đã migrate (nhanh, cô lập).
* Khởi động giống `main.ts`: đọc cấu hình → migrate (có `pg_advisory_lock` chống chạy song song) → `DEV_SEED_LEADERS` (từ chối ở prod) → khoá `DATA_KEY` tạm ở dev → worker outbox + sweeper hết hạn → `HOST:PORT` → tắt êm khi SIGINT/SIGTERM (dừng worker, `http.Server.Shutdown`, đóng DB, dừng PG embedded).

## Biến môi trường (giống `services/api/src/config.ts`, `deploy/env.example`)

Chuỗi rỗng được coi như chưa đặt. Ở `APP_ENV=prod` cấu hình bị từ chối (liệt kê hết lỗi) nếu vi phạm các ràng buộc ghi ở cột cuối.

| Biến | Mặc định | Ghi chú / ràng buộc prod |
|---|---|---|
| `APP_ENV` | `dev` | `dev`\|`test`\|`prod` |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | |
| `PUBLIC_URL` | `http://localhost:8080` | prod: https. https ⇒ cookie `__Host-sid` + Secure + HSTS |
| `TRUST_PROXY` | `0` | `1` ⇒ IP client = phần tử trái nhất của `X-Forwarded-For` |
| `CORS_ORIGINS` | rỗng | danh sách phân tách bằng dấu phẩy; prod cấm `*` và `http://` không phải localhost/tauri.localhost |
| `DATABASE_URL` | – | **bắt buộc ở prod**; vắng ⇒ PostgreSQL embedded |
| `PGLITE_DIR` | tạm | thư mục dữ liệu PG embedded (dev/test) |
| `DATA_KEY` | – | base64 32 byte; prod bắt buộc; dev vắng ⇒ khoá tạm (dữ liệu mã hoá mất khi restart) |
| `STORAGE_DIR` | `<thư mục exe>/data/files` | kho ciphertext cục bộ. Mặc định và đường dẫn tương đối **neo theo thư mục chứa exe**, không theo CWD (Windows deploy trong Documents); `go run` dùng CWD; `APP_BASE_DIR` ghi đè gốc |
| `LOG_DIR` | `<thư mục exe>/logs` | `app.log` (slog JSON) + `audit.jsonl` + mảnh `.gz` xoay vòng. Không ghi được ⇒ cảnh báo và chỉ log stdout |
| `LOG_STDOUT` / `LOG_FILE_ENABLED` / `LOG_ROTATE_DAILY` | 1 / 1 / 1 | |
| `LOG_LEVEL` | `info` | Zap JSON: `debug`, `info`, `warn`, `error`; lỗi 5xx có stack trace, mọi log có caller |
| `LOG_MAX_SIZE_MB` / `LOG_MAX_AGE_DAYS` / `LOG_MAX_BACKUPS` | 50 / 30 / 20 | xoay theo dung lượng (+ hằng ngày), nén gzip; age/backups áp cho `app.log` |
| `AUDIT_FILE_ENABLED` / `AUDIT_FILE_MIN_RETAIN_DAYS` | 1 / 90 | bản sao JSONL của audit (DB vẫn là nguồn sự thật); tuổi tối thiểu trước khi janitor được xóa mảnh cũ (cần thêm `/audit/verify` hoặc export đầy đủ) |
| `DISK_MAX_USED_PCT` | 90 | 50..95; tổng % đã dùng của ổ chứa kho/log. Vượt ⇒ janitor dọn, vẫn vượt ⇒ 507 `INSUFFICIENT_STORAGE` |
| `DISK_CHECK_INTERVAL_SEC` / `DISK_RESERVE_MB` | 60 / 256 | admission: dùng + size×1.1 + reserve ≤ giới hạn |
| `INSPECT_ENABLED` | 1 | quét metadata nội dung → manifest bất biến (xem `docs/AUDIT-TRAIL.md`) |
| `INSPECT_MAX_DEPTH` / `INSPECT_MAX_ENTRIES` | 2 / 10000 | zip lồng / số entry liệt kê |
| `INSPECT_MAX_BYTES` / `INSPECT_MAX_RATIO` / `INSPECT_TIMEOUT_SEC` | 1 GiB / 200 / 120 | chặn zip-bomb: byte giải nén đọc, tỉ lệ nén mỗi entry, thời gian. Vượt ⇒ `truncated:true` + lý do |
| `INSPECT_ENTRY_HASH_MAX_BYTES` / `INSPECT_NESTED_MAX_BYTES` | 64 MiB / 64 MiB | SHA-256 từng entry / zip lồng được mở |
| `MAX_UPLOAD_BYTES` / `PART_BYTES` | 2 GiB / 8 MiB | |
| `ALLOWED_EXTENSIONS` | rỗng (mọi loại) | |
| `TICKET_TTL_HOURS` / `APPROVAL_WINDOW_HOURS` | 72 / 168 | |
| `MAX_DOWNLOADS` / `DOWNLOAD_REAUTH_MAX_AGE_SEC` | 3 / 300 | |
| `SESSION_TTL_HOURS` | 12 | phiên desktop luôn 15 phút + refresh 7 ngày |
| `OIDC_PROVIDERS` | `[]` | JSON; prod: ≥1 provider |
| `BOOTSTRAP_ADMINS` | rỗng | admin đầu tiên (email phải `email_verified`) |
| `ALLOW_DEV_LOGIN` | `0` | prod cấm |
| `DEV_LOG_MAIL` | `0` | chỉ dev; prod cấm |
| `RATE_LIMIT_LOGIN_PER_MIN` | 10 | `POST /auth/desktop/genai` |
| `GENAI_LOGIN_URL`, `GENAI_VERIFY_URL` | – | prod: https |
| `GENAI_JWT_KEY` | – | base64, HS256 (ưu tiên hơn verify URL) |
| `GENAI_DEV_TRUST_UNVERIFIED` | `0` | chỉ dev, **không kiểm chữ ký**; prod cấm |
| `GENAI_EMAIL_PATH` / `GENAI_NAME_PATH` | `email` / `userFullName` | đường dẫn chấm trong JSON/claims |
| `ALLOWED_EMAIL_DOMAINS` | rỗng | prod: bắt buộc khi bật genai (key hoặc verify URL) |
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | – / 587 | thiếu host/from ⇒ gửi lỗi (ticket `notifyState=ERROR`) |
| `SMTP_TLS` | `starttls` | `starttls` (bắt buộc nâng cấp)\|`implicit`\|`none` (prod cấm) |
| `OUTBOUND_PROXIES` | `{}` | JSON `{ "oidc":"…","genai":"…","hrm":"…" }` — proxy riêng từng chặng, **không** dùng `HTTP(S)_PROXY` |
| `HRM_BASE_URL`, `HRM_SIGNATURE_SECRET` | – | prod: bắt buộc, https. Danh sách người duyệt = cấp trên từ `GET {HRM_BASE_URL}/hrm/v1/api/managers?email=…` |
| `DEV_SEED_LEADERS` | – | `"a@vnpay.vn:Tên A,b@vnpay.vn:Tên B"`; chỉ dev, prod ⇒ từ chối khởi động |

**Chẩn đoán đăng nhập GenAI:** xem `<LOG_DIR>/app.log` (mặc định `logs/app.log` cạnh binary). Khi khởi động, `genai.verifier configured` cho biết `mode=local_hs256` dùng `GENAI_JWT_KEY`, hoặc `mode=http_verify` gọi broker qua `GENAI_VERIFY_URL` và không dùng khóa JWT cục bộ. `genai.outbound configured` cho biết đi trực tiếp hay qua proxy trong `OUTBOUND_PROXIES.genai`. Lỗi `genai.verify failed` ghi `stage`, địa chỉ broker, thời gian chờ và `cause` như `dns_error`, `connection refused`, `deadline_exceeded`, `tls_unknown_certificate_authority` hoặc `proxy_authentication_required`. Broker trả 401/403 được ghi riêng dưới `genai.verify rejected`. Mỗi lần xác minh ghi `genai.verify request` với method, URL gồm đường dẫn và query đã che secret, headers, body gửi đi (GET không có body), route và proxy URL; `genai.verify response` ghi URL cuối, HTTP status, content type, server, location và toàn bộ headers (che Authorization/cookie/secret) và body phản hồi tối đa 1 MiB (đã che token và secret). Lỗi kết nối ghi `response_received=false` cùng lỗi transport chi tiết. Các dòng request/response/transport có `request_id` để đối chiếu request API. Không ghi Authorization, khóa JWT hay mật khẩu proxy. Cần triển khai binary mới và khởi động lại API để có các log này.

## Cấu trúc

```
cmd/server/main.go        khởi động, tắt êm
internal/config           parse env + kiểm tra prod (cả HRM_*)
internal/apperr           ErrorCode → HTTP status
internal/app              Deps, Router (xác thực, CSRF, rate limit, map lỗi), helper request/response
internal/server           middleware (request-id, log, security headers, CORS), health, BuildDeps/NewWorker/SeedLeaders,
                          agent.go (nối RegisterAgentRoutes → agent.Register)
internal/routes           handler: auth, transfers (+delegations), db, audit
internal/auth             session, OIDC (discovery/PKCE/JWKS), genai (HTTP/HS256/dev), user provisioning
internal/tickets          workflow ticket + handler outbox (scan, email, purge, rescan), sweeper
internal/audit            audit log hash-chain (cùng định dạng với audit.ts) + truy vấn/xuất/xác minh offline
internal/inspect          phân tích metadata file (zip/csv/json/text/nhị phân) → manifest; không lưu nội dung
internal/logsink          log file xoay vòng (lumberjack, Windows-safe) + sink audit.jsonl + marker xác minh
internal/diskguard        % đĩa (statfs / GetDiskFreeSpaceEx), admission 507, janitor dọn theo thứ tự
internal/reqmeta          IP/XFF/UA/request-id/session-ref đi cùng context vào mọi bản ghi audit
cmd/auditverify           xác minh file export audit (JSONL) offline
internal/outbox           hàng đợi + worker (retry mũ + jitter, dead-letter, dedupe)
internal/hrm              client HRM có chữ ký + cấp user leader cục bộ
internal/crypto           AES-256-GCM (AAD), KeyProvider + StaticKeyProvider, EncryptSecret/DecryptSecret
internal/store            kho ciphertext (interface + Local FS)
internal/scan             AV bypass (skipped:av_disabled); adapters cũ chỉ dùng trong test
internal/mail             Mailer (SMTP/not-configured/dev-log/fake) + template email
internal/httpx            HTTP ra ngoài với proxy theo chặng
internal/db, migrate      pgx/v5 pool + tx helper, PG embedded, migration (`internal/migrate/sql/*.sql`)
internal/shared           port packages/shared: rbac, state machine, redact, validation, sql-classify,
                          agent-context (+ AgentChatBody), template (renderTemplate/getPath), helper UTF-16/JS-string
internal/agent            GET /agent/config + POST /agent/audit (Agent chạy trên desktop)
internal/apitest          test tích hợp (PG embedded + fake)
```

## Khác biệt có chủ đích so với bản Node

Hành vi/bảo mật giữ nguyên (so sánh hằng thời gian, cờ cookie, CSRF, step-up, token dùng một lần, ràng buộc AAD, redaction). Các điểm khác:

1. **Hash-chain audit**: cùng định dạng (`canon()` + SHA-256); test đối chiếu với vector sinh từ Node. Khác: trường tuỳ chọn vắng (`rows`, `ms`, `errorCode` của `/db/audit`) bị **bỏ khỏi `detail`** thay vì `undefined` — bản Node băm `"rows":null` lúc ghi nhưng lúc verify đọc từ DB không có khoá ⇒ chuỗi hỏng; bản Go nhất quán. Dữ liệu cũ do Node ghi vẫn verify được (trừ các dòng gặp lỗi `undefined` nói trên).
2. **Mã hoá part/DEK**: định dạng byte y hệt (`iv12|tag16|ct`, AAD `part:<ticket>:<n>`, `wrap`) — dữ liệu và khoá do Node tạo đọc được (có test với ciphertext từ Node).
3. **404 route không tồn tại / sai method** trả `{error:{code:"NOT_FOUND",…}}` (Fastify trả `{message,error,statusCode}`), vẫn 404.
4. **Rate limit** bộ nhớ trong tiến trình, cửa sổ cố định 1 phút, khoá theo `route + IP` (mặc định 300/phút; `/auth/*` công khai 30/phút; genai = `RATE_LIMIT_LOGIN_PER_MIN`; part 600; download-token & download 20). Request preflight CORS không bị đếm. Quá hạn: 429 `RATE_LIMITED` + `Retry-After`.
5. **Request ID**: nhận `X-Request-ID` hợp lệ (`[A-Za-z0-9._-]{1,64}`) hoặc tự sinh, trả lại trong header và log. Log JSON (`log/slog`) một dòng/request, không log header/body/query (token tải nằm trong query); khoá nhạy cảm bị che, Bearer/JWT trong giá trị bị lược.
6. **`seq` (audit) và `id` (ticket event)** luôn là số JSON (Node + `pg` thật trả chuỗi cho `bigserial`; SPA khai báo `number | string` nên không ảnh hưởng).
7. **ID token OIDC phải có `exp`** (Node chỉ kiểm khi có). Thuật toán chấp nhận: RS/PS/ES 256-512 trong JWKS (không HS*, không `none`). Lỗi tải JWKS khi xác minh ⇒ 401 `invalid id_token` (giống jose).
8. **Refresh desktop** xoay vòng bằng một câu `DELETE … RETURNING` nguyên tử (hai request song song không thể cùng dùng một refresh token).
9. **Cấu hình**: chuỗi rỗng = chưa đặt (Node: `HRM_BASE_URL=""` làm parse lỗi). URL hợp lệ = có scheme (như `new URL`). Số lỗi ⇒ báo lỗi cấu hình, không im lặng.
10. **`DEV_SEED_LEADERS`** dùng lại user đã có cùng email (khác provider) thay vì nổ vi phạm unique index.
11. **Migration** thêm `pg_advisory_lock` để nhiều instance khởi động cùng lúc không đua nhau.
12. **SMTP** dùng `wneessen/go-mail` (không phải nodemailer): cùng ba chế độ TLS; nội dung MIME (multipart text+html) khác chi tiết ở mức byte nhưng header `Subject` luôn được loại CR/LF và `starttls` bắt buộc nâng cấp, từ chối gửi rõ nếu máy chủ không hỗ trợ.
13. **`X-Forwarded-For`** chỉ tin khi `TRUST_PROXY=1`, lấy phần tử trái nhất (như Fastify `trustProxy:true`).
14. **Redaction**: RE2 không có look-behind/ahead nên regex số điện thoại được viết tay (kiểm bằng vector sinh từ Node); `\s` chỉ ASCII.
15. Header tên-chuẩn-hoá theo Go (`X-Content-Sha256`); HTTP không phân biệt hoa thường.
16. `GENAI_JWT_KEY` HS256 yêu cầu `exp` (như Node `requiredClaims`), dung sai 30 s.
17. **Agent**: không chạy ở server nữa. `internal/server/agent.go` chỉ gán `server.RegisterAgentRoutes = agent.Register` (cấu hình `GET /agent/config` và sink audit `POST /agent/audit`: danh sách action cố định, giữ `question`/`answer` đã redact và `sqlMasked`, bỏ khóa prompt/reply/token/sql, giới hạn độ sâu/độ dài, gắn `reportedBy=desktop`). Migration 006 xóa các bảng `agent_settings`, `agent_tokens`, `openmetadata_tokens` (token LLM/OpenMetadata nay nằm trong kho credential của máy người dùng).

## Dấu vết kiểm toán, xoay vòng log, ngân sách đĩa
Danh mục action/trường audit, manifest nội dung file, API truy vết (`/transfers/:id/manifest|trace`, `/audit/export`) và chính sách dọn đĩa: `docs/AUDIT-TRAIL.md`. Windows: `docs/OPERATIONS.md` §2b–2c, `deploy/windows/`. Migration `007_audit_trace_manifest.sql` (cột trace trên `tickets`, bảng `ticket_manifests` + `ticket_manifest_entries` bất biến). Hai thay đổi hành vi nhỏ: `actor_label` giữ email (trước bị che), tên file có ký tự điều khiển bị từ chối (400).

## Test

`go test ./...` chạy: shared (vector `packages/shared/testdata/sql-classify.json`, redact, RBAC, state machine, validation, agent-context + vector Node, template, UTF-16), audit (vector hash từ Node), crypto, config (prod), scan (clamd giả), mail (SMTP giả, template), store, auth (unit), migrate và bộ tích hợp `internal/apitest` (transfers, auth/OIDC + proxy theo chặng, CSRF, desktop loopback, CORS, genai HTTP/HS256/dev, HRM có kiểm chữ ký 10 phút, db routes, outbox, worker, rate limit và `TestAgentAudit`). Phần Agent (harness, orchestrator, skills, adapter LLM, client MCP, prompt khớp vector Node) được test ở phía desktop: `npm test -w @vnpay/web` (`features/agent/**`).

## Agent

Chạy hoàn toàn trong app desktop (xem `docs/ARCHITECTURE.md` §5). Server cung cấp cấu hình và nhận audit: `POST /api/v1/agent/audit` (quyền `agent:use`), test ở `internal/apitest/agent_audit_test.go` (route cũ trả 404, không lưu prompt/reply/token/sql, giới hạn kích thước).

Quét AV trong ứng dụng đã bỏ qua. Không cần CLAMD_HOST/CLAMD_PORT/DEV_SCAN_CLEAN; các biến cũ không còn tác dụng. Worker vẫn kiểm tra PII/nội dung rồi chuyển sang chờ duyệt, ghi kết quả AV là `skipped:av_disabled`, không phải `clean`.

### Cấu hình Agent tập trung

`GET /api/v1/agent/config` yêu cầu session/bearer và quyền `agent:use`; trả `endpoints` (id, label, baseUrl, models, description), `defaultEndpointId`, `defaultModel`, `budgetChars`, `openMetadataUrl`, `authHeader`, `authScheme`. Không chứa token hay mật khẩu. Cấu hình được đọc khi server khởi động từ `AGENT_CONFIG` (JSON), mặc định gồm VNPAY Kimi và MiniMax. Ví dụ:

```sh
AGENT_CONFIG='{"endpoints":[{"id":"vnpay-kimi","label":"VNPAY Kimi","baseUrl":"https://genai.vnpay.vn/aigateway/llm_kimi/v1","models":["v_kimi"]}],"defaultEndpointId":"vnpay-kimi","defaultModel":"v_kimi","budgetChars":12000,"openMetadataUrl":null,"authHeader":"Authorization","authScheme":"Bearer"}'
```

Khởi động lại server sau khi đổi biến này. Desktop tải lại cấu hình khi đọc settings/thực hiện thao tác Agent; Rust tự gọi URL API đã cấu hình, kiểm tra URL và lưu cấu hình trong bộ nhớ để gọi LLM/MCP. Không dùng `agent` trong config.json làm fallback. Token LLM/OpenMetadata vẫn lưu tại OS credential store. Lỗi tải cấu hình được hiển thị cho người dùng; luồng API giữ cơ chế refresh phiên đăng nhập.

### Tham số DB và chuyển file trên server

Server là nguồn cấu hình cho desktop và portal. Thay đổi biến môi trường rồi khởi động lại API; mở lại màn hình DB/upload để nhận giá trị mới. Triển khai API trước các client dùng cấu hình mới.

| Nhóm | Cấu hình server | Client nhận qua |
| --- | --- | --- |
| DB đích | `db_targets`: host, port, database, driver, auth_modes, allow_write, proxy, options | `GET /api/v1/db/targets` |
| DB runtime | `DB_CONFIG` JSON: `defaultMaxRows=1000`, `maxRows=100000`, `defaultTimeoutSec=60`, `maxTimeoutSec=600`, `pageSize=500`, `tablePageSize=200`, `connectTimeoutSec=15`, `externalAuthTimeoutSec=180` | `GET /api/v1/db/config`, quyền `db:connect` |
| Upload | `MAX_UPLOAD_BYTES`, `PART_BYTES`, `ALLOWED_EXTENSIONS`; `UPLOAD_CLIENT_CONFIG` JSON: `parallelism=3`, `maxRetries=3`, `retryBaseMs=500` | `GET /api/v1/transfers/options`; part size từng ticket theo response tạo ticket |
| Duyệt | `APPROVAL_WINDOW_HOURS=168`, `DELEGATION_MAX_DAYS=30`; danh sách quản lý từ HRM, quyền duyệt từ RBAC/ủy quyền | `transfers/options`: `approval`; server kiểm tra khi quyết định/ủy quyền |
| Tải | `TICKET_TTL_HOURS=72`, `MAX_DOWNLOADS=3`, `DOWNLOAD_REAUTH_MAX_AGE_SEC=300`, `DOWNLOAD_TOKEN_TTL_SEC=60`, `DOWNLOAD_RATE_LIMIT_PER_MIN=20` | `transfers/options`: `limits`, `download`; response `download-token` trả TTL thực tế |

Ví dụ:

```sh
DB_CONFIG='{"defaultMaxRows":500,"maxRows":10000,"defaultTimeoutSec":30,"maxTimeoutSec":120,"pageSize":250,"tablePageSize":100}'
UPLOAD_CLIENT_CONFIG='{"parallelism":2,"maxRetries":4,"retryBaseMs":1000}'
DELEGATION_MAX_DAYS=14
DOWNLOAD_TOKEN_TTL_SEC=120
```

Các JSON cho phép ghi đè từng trường; server kiểm tra giới hạn trước khi khởi động. Desktop tải cấu hình DB trước khi tạo workspace, báo lỗi và cho thử lại nếu tải thất bại. Gateway chặn giá trị truy vấn vượt giới hạn cấu hình, kể cả tab khôi phục từ máy người dùng. Giới hạn tuyệt đối trong JDBC vẫn giữ để bảo vệ bộ nhớ/giao thức.

JDBC vẫn thực thi tại desktop. Cấu hình runtime không thay thế quyền của tài khoản DB: server không thể cưỡng chế truy vấn trên một desktop đã sửa đổi. Mật khẩu DB, SSH key và token riêng của người dùng vẫn thuộc OS credential store; các API cấu hình chỉ trả tham số vận hành. File upload, lưu trữ, kiểm tra nội dung, duyệt và kiểm tra quyền tải chạy trên API server.

### Cấu hình vận hành desktop

Desktop chỉ cần `apiBaseUrl` và `env` trong config.json để khởi tạo; `proxy.url` cục bộ được phép dùng riêng cho kết nối tải cấu hình ban đầu khi mạng yêu cầu proxy. Cấu hình từ server có ưu tiên sau bước bootstrap. Token và credential proxy của người dùng vẫn nằm trong OS credential store.

- `GET /api/v1/desktop/config` là API công khai phục vụ trước đăng nhập. Biến `DESKTOP_CONFIG` chứa JSON cho proxy chung, SSO proxy, origin SSO, chế độ browser, giữ cookie, callback secret, timeout đăng nhập, cổng CONNECT nội bộ, timeout tải cấu hình và heap Java. Không chứa credential. Desktop tải một lần mỗi lần khởi động và báo lỗi có nút thử lại nếu không tải được.
- `GET /api/v1/agent/config` yêu cầu `agent:use`. `AGENT_CONFIG.runtime` chứa mapping request/response LLM, `max_tokens`/`temperature` trong `llm.chat.body`, timeout, giới hạn harness, giới hạn HTTP, tool allow-list và phiên bản MCP, bộ nhớ/tóm tắt hội thoại. Cấu hình runtime được dùng cho từng thao tác/lượt Agent, không sửa biến global khi các lượt chạy song song.
- `GET /api/v1/db/config` yêu cầu `db:connect`. `DB_CONFIG` quản lý số dòng tối đa/mặc định, thời gian query/connect/SSO và kích thước trang kết quả.
- `/transfers/options` cung cấp giới hạn file, retry/parallelism upload, cửa sổ phê duyệt/delegation và thời hạn download. Biến `UPLOAD_CLIENT_CONFIG` quản lý `parallelism`, `maxRetries`, `retryBaseMs`.

Các cấu hình JSON hỗ trợ ghi đè từng trường; thay `endpoints` sẽ thay toàn bộ danh sách và cần chỉ rõ defaults tương ứng. File mặc định đầy đủ: `internal/config/agent-defaults.json`, `internal/config/desktop-defaults.json`. Ví dụ ghi đè timeout/ngân sách mà giữ danh sách model mặc định:

```sh
AGENT_CONFIG='{"runtime":{"llm":{"timeoutSec":90},"harness":{"maxLlmCalls":10,"maxParallel":2}}}'
DESKTOP_CONFIG='{"genaiProxyUrl":null,"genaiLoginBrowser":"internal","genaiTimeoutSec":240,"sidecar":{"maxHeapMb":1024}}'
```

Khởi động lại server để áp dụng thay đổi. Cấu hình desktop/SSO/heap được tải lại ở lần mở app tiếp theo; cấu hình Agent được tải lại ở thao tác kế tiếp. Các giới hạn giao thức và trần kiểm tra hợp lệ vẫn nằm trong desktop để từ chối cấu hình sai. CSP/API origin của installer và danh tính/chữ ký ứng dụng vẫn là cấu hình build.

AES application transport, independent web/desktop keys and deployment settings: [SECURE-TRANSPORT.md](../../docs/SECURE-TRANSPORT.md).
