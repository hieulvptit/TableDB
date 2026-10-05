# TableDB API — bản Go (`services/api`)

Viết lại backend Node/Fastify `services/api` bằng Go (module `vnpay/tabledb-api`), **thay thế trực tiếp** (drop-in): cùng base path `/api/v1`, cùng route, cùng JSON, cùng mã trạng thái và dạng lỗi `{error:{code,message,details?}}`, cùng cookie/CSRF/bearer, cùng biến môi trường, cùng migration SQL (nhúng bằng `go:embed`).
SPA web (`apps/web`) và desktop gọi API này không cần đổi gì. Tài liệu hợp đồng: `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY-FINDINGS.md`.

> **Trạng thái: hoàn tất (giai đoạn 1 + 2).** Đã port toàn bộ. **Agent không còn chạy ở server**: harness, LLM, OpenMetadata MCP, token và cấu hình nằm trong app desktop (`apps/web/src/features/agent/`, cầu HTTP ở lõi Rust). Server chỉ còn `POST /api/v1/agent/audit` (sink audit metadata, `internal/agent/audit.go`).

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
internal/agent            chỉ còn audit.go: POST /agent/audit (Agent chạy trên desktop)
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
17. **Agent**: không chạy ở server nữa. `internal/server/agent.go` chỉ gán `server.RegisterAgentRoutes = agent.Register` (sink audit `POST /agent/audit`: danh sách action cố định, giữ `question`/`answer` đã redact và `sqlMasked`, bỏ khóa prompt/reply/token/sql, giới hạn độ sâu/độ dài, gắn `reportedBy=desktop`). Migration 006 xóa các bảng `agent_settings`, `agent_tokens`, `openmetadata_tokens` (token LLM/OpenMetadata nay nằm trong kho credential của máy người dùng).

## Dấu vết kiểm toán, xoay vòng log, ngân sách đĩa
Danh mục action/trường audit, manifest nội dung file, API truy vết (`/transfers/:id/manifest|trace`, `/audit/export`) và chính sách dọn đĩa: `docs/AUDIT-TRAIL.md`. Windows: `docs/OPERATIONS.md` §2b–2c, `deploy/windows/`. Migration `007_audit_trace_manifest.sql` (cột trace trên `tickets`, bảng `ticket_manifests` + `ticket_manifest_entries` bất biến). Hai thay đổi hành vi nhỏ: `actor_label` giữ email (trước bị che), tên file có ký tự điều khiển bị từ chối (400).

## Test

`go test ./...` chạy: shared (vector `packages/shared/testdata/sql-classify.json`, redact, RBAC, state machine, validation, agent-context + vector Node, template, UTF-16), audit (vector hash từ Node), crypto, config (prod), scan (clamd giả), mail (SMTP giả, template), store, auth (unit), migrate và bộ tích hợp `internal/apitest` (transfers, auth/OIDC + proxy theo chặng, CSRF, desktop loopback, CORS, genai HTTP/HS256/dev, HRM có kiểm chữ ký 10 phút, db routes, outbox, worker, rate limit và `TestAgentAudit`). Phần Agent (harness, orchestrator, skills, adapter LLM, client MCP, prompt khớp vector Node) được test ở phía desktop: `npm test -w @vnpay/web` (`features/agent/**`).

## Agent

Chạy hoàn toàn trong app desktop (xem `docs/ARCHITECTURE.md` §5). Server chỉ nhận audit: `POST /api/v1/agent/audit` (quyền `agent:use`), test ở `internal/apitest/agent_audit_test.go` (route cũ trả 404, không lưu prompt/reply/token/sql, giới hạn kích thước).

Quét AV trong ứng dụng đã bỏ qua. Không cần CLAMD_HOST/CLAMD_PORT/DEV_SCAN_CLEAN; các biến cũ không còn tác dụng. Worker vẫn kiểm tra PII/nội dung rồi chuyển sang chờ duyệt, ghi kết quả AV là `skipped:av_disabled`, không phải `clean`.
