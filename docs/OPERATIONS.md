# Cài đặt, triển khai, vận hành

## 1. Desktop Windows

**Yêu cầu:** Windows 10/11 x64, WebView2 runtime (bộ cài NSIS đã cấu hình bootstrapper; môi trường offline cần WebView2 offline installer — xem VNPAY-INPUTS §10). Không cần cài Java: JRE tối giản (jlink) đi kèm bộ cài.

**Build bộ cài (trên Windows hoặc CI `.github/workflows/desktop-windows.yml`):**
```powershell
# 1) sidecar + driver
cd services\jdbc; mvn -q package; sh scripts/fetch-drivers.sh   # cần Git Bash/WSL; hoặc dùng job CI
# 2) SPA cho desktop
cd ..\..; npm ci; $env:VITE_TARGET="desktop"; npm run build -w @vnpay/web
# 3) JRE + đóng gói
cd apps\desktop; .\scripts\build-desktop.ps1 -ApiOrigin https://bo-test.example.vnpay.vn
```
Chi tiết, tham số ký mã (`-CertThumbprint`) và updater: `apps/desktop/README.md`. CSP `connect-src` được ghim vào bản build theo `-ApiOrigin`; mỗi môi trường (test/prod) build một bộ cài riêng.

**Cấu hình desktop**: API và khóa public nhúng trong `deployment.json`; chỉ có môi trường `prod`. Desktop không dùng file cấu hình local. SSO, proxy và Agent lấy từ server. Secret (mật khẩu DB, refresh token) nằm trong Windows Credential Manager.

**Cài hàng loạt:** `TableDB-Setup.exe /S` (NSIS silent); phân phối qua SCCM/Intune; cập nhật bằng updater Tauri (cần `pubkey` + endpoint thật, chưa có trong repo).

**Log:** `%LOCALAPPDATA%\vn.vnpay.tabledb\logs\` (xoay vòng, đã redact). Khi báo lỗi gửi file log này; không có mật khẩu/token trong đó.

## 2. Backend (test/prod)

### Thành phần
`services/api` (API + worker cùng process; có thể tách bằng cách chạy nhiều instance — outbox dùng `FOR UPDATE SKIP LOCKED`), PostgreSQL ≥ 14, kho file, reverse proxy (`deploy/nginx.conf`), SPA tĩnh (`apps/web/dist`).

Mỗi worker dành 2 slot cho scan/rescan, 4 cho email, 2 cho purge và 1 cho loại job khác; mỗi slot nhận một job rồi nhận tiếp ngay khi hoàn tất. Sweeper chạy độc lập. Lease job là 5 phút, gia hạn mỗi 100 giây; `attempts` là thế hệ sở hữu dùng để chặn worker cũ cập nhật kết quả sau khi job đã được nhận lại. Email vẫn có ngữ nghĩa at-least-once nếu process dừng sau khi SMTP nhận thư nhưng trước khi ghi kết quả.

Upload part giữ khóa dòng ticket trong lúc publish file và metadata, nên các part của cùng ticket được ghi lần lượt. Khi đo tải, theo dõi thời gian chờ pool/khóa ticket cùng tốc độ ghi kho file.

### Các bước
1. **DB:** tạo database + user riêng; `DATABASE_URL` trong secret store.
2. **Cấu hình:** sao chép `deploy/env.example` → `/etc/tabledb/api.env` (quyền 600; trên **Windows** xem §2b), điền theo `docs/VNPAY-INPUTS.md`. Prod bắt buộc: `APP_ENV=prod`, `PUBLIC_URL=https://…`, `DATABASE_URL`, `DATA_KEY`/KMS, `OIDC_PROVIDERS`; `ALLOW_DEV_LOGIN` phải là `0` (API từ chối khởi động nếu sai).
3. **Migration:** migration nhúng trong binary và tự chạy khi khởi động. Migration là tiến-lên; sao lưu trước khi nâng cấp.
4. **Không có dịch vụ JDBC ở backend.** JDBC chỉ chạy trong desktop (sidecar đóng gói cùng bộ cài). Nếu Trino/Oracle/PG dùng CA nội bộ, đưa truststore vào bản build desktop (`-Djavax.net.ssl.trustStore` trong tham số khởi chạy sidecar) — ghi vào VNPAY-INPUTS §2.
5. **AV:** ứng dụng bỏ qua AV và ghi `skipped:av_disabled`. AV trên server được vận hành riêng; không cần dịch vụ ClamAV cho API. Kiểm tra PII/nội dung vẫn chạy trước khi chờ duyệt.
6. **Web BO (duyệt/tải/quản trị):** `npm run build -w @vnpay/web`, copy `dist` vào `/srv/tabledb/web`; `nginx.conf` (giới hạn body 9 MB ≥ `PART_BYTES`).
7. **Dịch vụ:** `deploy/tabledb-api.service`. Kiểm tra `GET /healthz`, `GET /readyz` (có trường `disk`).
8. **Khởi tạo dữ liệu:** endpoint LLM nay nằm ở `agent.endpoints` trong `config.json` của desktop (không còn `PUT /agent/settings`). Không còn API admin: danh mục `db_targets` cho desktop (nếu dùng) nạp thẳng vào DB; người duyệt lấy từ HRM (`HRM_BASE_URL`, `HRM_SIGNATURE_SECRET`). Admin đầu tiên lấy từ `BOOTSTRAP_ADMINS` (email phải đến từ IdP với `email_verified=true`).

### 2b. Backend chạy trên Windows (thư mục Documents của người dùng)
Server là binary Go tĩnh, cross-compile từ bất kỳ máy nào: `cd services/api && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o tabledb-api.exe ./cmd/server` (và `./cmd/auditverify` cho công cụ xác minh audit offline). Không dùng đường dẫn cứng kiểu `/var/lib` hay `/etc`, không cần syscall POSIX.

**Thư mục.** Mọi đường dẫn mặc định **neo theo thư mục chứa `tabledb-api.exe`** (không theo CWD — dịch vụ/Task Scheduler hay chạy với CWD là `C:\Windows\System32`):
```
C:\Users\<bạn>\Documents\TableDB\
  tabledb-api.exe  run.cmd  install.ps1  api.env      (api.env: DATABASE_URL, DATA_KEY… — ACL chỉ SYSTEM/Administrators/người cài)
  data\files\    STORAGE_DIR mặc định: ciphertext (AES-GCM)
  logs\          LOG_DIR mặc định: app.log, audit.jsonl, *.gz đã xoay vòng, audit.verified.json, audit.cursor
```
`STORAGE_DIR`/`LOG_DIR` có thể đặt đường dẫn tuyệt đối (`D:\TableDB\files`) hoặc tương đối (tính từ thư mục exe). Khi chạy bằng `go run`, thư mục build tạm bị bỏ qua và dùng CWD. Nếu `LOG_DIR` không ghi được, server vẫn chạy (chỉ log stdout) và in cảnh báo.

**Chạy như dịch vụ** (không có secret trong script; `deploy/windows/`): chép `tabledb-api.exe`, `run.cmd`, `install.ps1`, `api.env.example` vào cùng một thư mục, đổi tên `api.env.example` → `api.env` và điền, rồi trong PowerShell **Administrator**:
```powershell
cd $env:USERPROFILE\Documents\TableDB
.\install.ps1 -Mode Task        # Task Scheduler "At startup", chạy lại khi lỗi, không cần phần mềm thêm
.\install.ps1 -Mode Nssm        # hoặc dịch vụ Windows qua NSSM (nssm.exe trong PATH): tự khởi động lại, xoay vòng console log
.\install.ps1 -Mode Task -Uninstall
```
`run.cmd` nạp `api.env` (mỗi dòng `KEY=VALUE`, không nháy, không chú thích cuối dòng) rồi chạy exe. Giá trị JSON phức tạp (`OIDC_PROVIDERS`) hoạt động nhưng nếu gặp vấn đề với ký tự đặc biệt của cmd, đặt biến đó ở mức Machine (`setx /M`). Thủ công: `.\run.cmd` trong cửa sổ cmd. Nếu chạy dưới tài khoản người dùng (`-RunAs`), thư mục Documents phải cho tài khoản đó quyền ghi; **không** đặt Documents trong OneDrive Known Folder Move (OneDrive khóa/đồng bộ file ciphertext và log — dùng `STORAGE_DIR`/`LOG_DIR` ngoài OneDrive nếu máy bật KFM).

**TLS.** Server nghe HTTP (`HOST=127.0.0.1`); kết thúc TLS ở **IIS + Application Request Routing (URL Rewrite reverse proxy)** hoặc **nginx for Windows** (mẫu `deploy/nginx.conf`: `client_max_body_size` ≥ `PART_BYTES` + 1 KiB). Đặt `TRUST_PROXY=1` và proxy phải đặt `X-Forwarded-For` (ghi đè giá trị client gửi) — IP trong audit lấy phần tử trái nhất. `PUBLIC_URL=https://…` (cookie `__Host-sid`, HSTS). IIS: bật WebSocket không cần; tăng `maxAllowedContentLength` ≥ kích thước part.

**PostgreSQL** có thể chạy trên cùng máy hoặc máy khác (`DATABASE_URL`); prod bắt buộc `DATABASE_URL` (PostgreSQL nhúng chỉ cho dev/test). Kho `data\files` chứa file mã hóa; ứng dụng không gửi plaintext tới AV trên server.

### 2c. Log, xoay vòng và ngân sách đĩa (≤ 90%)
| Biến | Mặc định | |
|---|---|---|
| `LOG_DIR` | `<exe>\logs` | |
| `LOG_STDOUT` / `LOG_FILE_ENABLED` | `1` / `1` | log JSON ra stdout và/hoặc `app.log` (đã redact) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`; áp dụng sau khi restart |
| `LOG_MAX_SIZE_MB` | `50` | xoay khi đạt dung lượng; `LOG_ROTATE_DAILY=1` xoay thêm mỗi nửa đêm; mảnh cũ nén gzip |
| `LOG_MAX_AGE_DAYS` / `LOG_MAX_BACKUPS` | `30` / `20` | chỉ áp cho `app.log` |
| `AUDIT_FILE_ENABLED` | `1` | `audit.jsonl`: bản sao JSONL của audit (mỗi dòng đủ `seq/prevHash/hash`); **DB vẫn là nguồn sự thật** |
| `AUDIT_FILE_MIN_RETAIN_DAYS` | `90` | tuổi tối thiểu trước khi mảnh audit có thể bị janitor xóa |
| `DISK_MAX_USED_PCT` | `90` (50..95) | tổng dung lượng đã dùng của **ổ chứa STORAGE_DIR/LOG_DIR** (kể cả dữ liệu khác trên ổ đó) |
| `DISK_CHECK_INTERVAL_SEC` / `DISK_RESERVE_MB` | `60` / `256` | |

API dùng Zap để ghi JSON đồng bộ, không sampling; mỗi dòng có `time`, `level`, `msg`, `caller`. Lỗi server ở mức ERROR có `stacktrace`; panic có thêm `panic_stack` tại vị trí panic. Mật khẩu, token, cookie, khóa riêng và session ID trong các trường log được che, kể cả trường lồng nhau. Log không ghi body hay query string. `audit.jsonl` vẫn giữ định dạng chuỗi audit riêng.

Khi xử lý sự cố, lấy `X-Request-ID` từ response trong Network rồi tìm `request_id` tương ứng trong `app.log`:

```sh
rg '55f0e270917808f3' logs/app.log
```

Lỗi API có `code`, `error`, `error_type`, `status`, `method`, `route` (mẫu route), `ip`. Validation có `validation_fields`; lỗi PostgreSQL có `sqlstate` nếu lỗi gốc cung cấp mã này. Lỗi 4xx ghi WARN, lỗi 5xx ghi ERROR. Với Secure API, dòng `request` ghi status của HTTP bên ngoài; dòng `secure API request` ghi status thật của API bên trong cùng `request_id`, nên ngoài 200 vẫn có thể là trong 400/403/500.

Lỗi transport ghi `secure transport rejected request` với `code`, `reason` và `stage` khi lỗi frame. Các trường `record_index`, `expected_bytes`, `received_bytes` chỉ vị trí và kích thước lỗi; không chứa nội dung gói. Ví dụ lỗi do tiền tố `/c/` còn nằm trong metadata:

```json
{"level":"WARN","msg":"secure transport rejected request","request_id":"55f0e270917808f3","status":400,"code":"SECURE_REQUEST","reason":"invalid_api_path","expected_path_prefix":"/api/v1/","received_path_prefix":"/c/api/v1/"}
```

| `reason` | Kiểm tra |
|---|---|
| `invalid_content_type` | Proxy có giữ `Content-Type: application/vnd.tabledb.aesgcm` không |
| `invalid_api_path` | Web đã cập nhật để metadata dùng `/api/v1/`; proxy chỉ bỏ prefix URL ngoài |
| `frame_prefix_read_failed` / `frame_ciphertext_read_failed` | Body bị cắt, đọc timeout hoặc thiếu frame cuối; xem `stage`, số byte và `error` |
| `frame_authentication_failed` | Frame không xác thực được với session/sequence hiện tại; kiểm tra phiên bản client và việc thay đổi gói/header trên đường truyền |
| `invalid_sequence_header` | Proxy/client có gửi header `X-TableDB-Sequence` là số nguyên không |
| `session_not_found` | API vừa restart, thiếu header session hoặc các request tới nhiều instance không có sticky routing |
| `session_expired` | Session hết hạn; xem `expired_at`, reload để tạo phiên mới |
| `replayed_or_invalid_sequence` | Request dùng lại sequence hoặc ngoài cửa sổ chấp nhận; không tự replay mutation |
| `request_body_too_large` | So sánh `body_bytes` với `body_limit_bytes` |
| `response_write_failed` / `response_length_mismatch` | Client ngắt kết nối, lỗi ghi response hoặc số byte khác Content-Length |

Worker ghi `outbox job retry scheduled` / `outbox job exhausted retries` với `job_id`, `job_type`, `attempt`, `max_attempts`, `error`; lần thử lại có `retry_in_sec`. Dùng các trường này để tìm job và nguyên nhân adapter/SMTP/scan, không cần đọc payload.

Chính sách khi dùng ≥ giới hạn (dừng ngay khi < giới hạn − 2): (1) xóa mảnh log ứng dụng cũ nhất → (2) xóa ciphertext của ticket đã REJECTED/REVOKED/QUARANTINED/EXPIRED/ABORTED còn sót (`storage.purge`, `reason=disk-pressure`) → (3) xóa mảnh **bản sao** audit cũ nhất, chỉ khi ≥ `AUDIT_FILE_MIN_RETAIN_DAYS` ngày **và** đã có `GET /audit/verify` thành công hoặc `GET /audit/export` đầy đủ sau khi mảnh đóng (vì DB giữ chuỗi gốc nên không mất dữ liệu audit) → (4) không xóa dữ liệu sống/DB. Vẫn vượt: `POST /transfers` và upload part trả **507 `INSUFFICIENT_STORAGE`**, ghi audit `storage.pressure` + WARN, `/healthz` có `disk.state=blocked`. Trước khi nhận upload còn có admission control: dùng + `size×1.1` + `DISK_RESERVE_MB` không được vượt giới hạn. **Hãy chạy `/audit/verify` định kỳ (hoặc xuất audit hằng tuần ra kho ngoài)** — nếu không, mảnh audit không bao giờ bị xóa và đĩa có thể đầy hơn.
Cảnh báo: PostgreSQL trên cùng máy cũng tính vào % đĩa; janitor không đụng vào DB. Dev trên macOS/Linux đã dùng >90% đĩa sẽ bị 507 ngay — đặt `DISK_MAX_USED_PCT=95`.

### Khác biệt test / prod
| | test | prod |
|---|---|---|
| `APP_ENV` | `test` (cho phép `ALLOW_DEV_LOGIN=1` nếu cần cho QA nội bộ, **không** mở ra Internet) | `prod` (bắt buộc cấu hình an toàn) |
| Khóa dữ liệu | `DATA_KEY` tĩnh | KMS/HSM (`KeyProvider` chưa có bản KMS — việc cần làm, VNPAY-INPUTS §7) |
| IdP | client test | client prod (client id/redirect khác) |
| SMTP relay | relay test/hộp thư thử | relay prod, `MAIL_FROM` có SPF/DKIM/DMARC |
| Bộ cài desktop | `apiBaseUrl`/CSP test | riêng |

### Quản lý khóa & bí mật
- `DATA_KEY` bọc khóa DEK của từng file (envelope). **Mất khóa = mất file.** Xoay khóa: giới thiệu KEK mới, unwrap/wrap lại `tickets.dek_wrapped` (chưa có script — làm cùng KMS).
- Secret (mật khẩu SMTP, client secret OIDC) lấy từ secret manager, không commit, không log.

### Sao lưu, retention
- DB: sao lưu thường xuyên (chứa audit, ticket). File: sao lưu ciphertext + đảm bảo sao lưu khóa riêng. `audit_log` nên đẩy sang kho tập trung/WORM (hash-chain chỉ phát hiện sửa, không ngăn DBA xóa cả chuỗi).
- Nội dung file bị xóa khi: từ chối, thu hồi, cách ly, hết hạn (job `purge`); `sweepExpired` chạy mỗi phút. Chưa có retention riêng cho bản ghi ticket/audit — theo chính sách VNPAY.

## 3. Vận hành hằng ngày

| Tình huống | Dấu hiệu | Xử lý |
|---|---|---|
| Email không gửi được | tickets `notify_state=ERROR`, bảng `outbox` (state=dead) | sửa SMTP (host/TLS/tài khoản) → đặt lại `state='pending'` trong bảng `outbox`. Leader vẫn duyệt được trên BO (danh sách *Chờ tôi duyệt*); người gửi có thể báo trực tiếp |
| Đọc/giải mã file lỗi | job `scan` retry, ticket còn "Chờ kiểm tra" | kiểm tra kho file/khóa; retry job sau khi xử lý |
| AV trong ứng dụng | Bỏ qua | `rescan` trả `skipped`; không tự cách ly theo công cụ AV bên ngoài |
| Nhân sự nghỉ/đổi quyền | — | đặt `users.active=false` trong DB; đổi leader: `POST /transfers/:id/change-approver` |
| Kiểm tra toàn vẹn audit | — | `GET /audit/verify` (định kỳ, cảnh báo nếu `ok=false`) |
| Lộ token LLM | — | user xóa token trong panel Agent (xóa khỏi kho credential của máy) và thu hồi ở phía LLM; đổi endpoint ở `config.json` nếu cần |
| Driver JAR nghi ngờ | sidecar báo `E_DRIVER_UNAVAILABLE` | không sửa tay: build/phát hành lại từ script pin phiên bản |
| `db.query.policy_violation` trong audit | desktop báo truy vấn mâu thuẫn chính sách | điều tra máy/người dùng (client bị sửa?); nhớ audit này do client tự khai báo — đối chiếu audit phía DB |

**Giám sát khuyến nghị:** tỉ lệ 5xx, `outbox` dead/pending age, tickets `SCANNING` > 15 phút, `notify_state=ERROR` > 0, lỗi đăng nhập OIDC, số lần `db.session.open_failed` và `db.query.policy_violation`, dung lượng kho file, `healthz.disk.state` (`warn`/`blocked`), audit `storage.pressure`, `audit/verify`, `transfer.inspected` có `inspectError`, `typeMismatch`, `executable`, `containsSensitivePatterns` (xem `AUDIT-TRAIL.md`). Log JSON của API đã redact `authorization`/`cookie`; SQL, body và secret không được ghi vào log (audit lưu SQL đã che literal).

## 4. Nâng cấp
API: triển khai bản mới → migration tự chạy → kiểm `readyz`. Web: thay `dist`. Desktop: phát hành bản mới qua updater; driver cập nhật cùng bản sidecar (checksum khóa trong `manifest.json` đóng gói).

Tham số DB/query, upload/retry, duyệt/ủy quyền và tải file được quản lý tại API server. Xem bảng biến và thứ tự triển khai trong [services/api/README.md](../services/api/README.md#tham-số-db-và-chuyển-file-trên-server). Cần triển khai API có `/db/config` trước desktop mới; mở lại màn hình để tải cấu hình sau khi khởi động lại API.
