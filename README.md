# VNPAY TableDB + SecureTransfer

Hai sản phẩm dùng chung API, mô hình phân quyền và design system:
1. **Desktop app (Tauri 2, Windows)** — TableDB (SQL client Oracle / Trino / PostgreSQL, JDBC sidecar cục bộ) + AI Agent (VNPAY LLM) + **upload file** cho quy trình chuyển file.
2. **Web BO** — **duyệt/từ chối**, **tải file** đã duyệt và quản trị. Không có truy cập database.

Quy trình chuyển file: upload (desktop) → kiểm tra PII/nội dung → email thông báo cho leader → leader duyệt (web, sau SSO) → tải (web).

Đọc theo thứ tự: `docs/ARCHITECTURE.md` (kiến trúc, ranh giới tin cậy, threat model, lộ trình) → `docs/VNPAY-INPUTS.md` (việc cần VNPAY xác nhận) → `docs/API.md` → `docs/OPERATIONS.md` → `docs/TEST-PLAN.md`.

| Thư mục | Nội dung |
|---|---|
| `packages/shared` | RBAC, state machine ticket, classifier SQL, context Agent, redact, DTO (TS, có test) |
| `services/api` | Backend Go (net/http + pgx): SSO, RBAC, danh mục DB + nhận audit từ desktop, Agent, upload/duyệt/tải, outbox (kiểm tra file, email), audit + migrations |
| `services/jdbc` | JDBC sidecar Java cho desktop (`--stdio`; chế độ `--http` không triển khai) |
| `services/web` | SPA React của web BO (office portal), build ra `services/web/dist` |
| `apps/web` | SPA React cho bản `desktop` (Tauri); `packages/ui` là design system |
| `apps/desktop` | Vỏ Tauri 2 (Rust): sidecar, Credential Manager, loopback OIDC, updater, đóng gói NSIS |
| `deploy` | env mẫu, nginx, systemd, compose, mapping mẫu LLM (minh họa, **không** phải API thật) |
| `docs` | tài liệu |

## Chạy nhanh (dev, không cần Postgres/IdP thật)
```bash
npm install
npm test                                  # shared + desktop SPA + web BO + api (Go)
npm run typecheck                         # tất cả workspace TypeScript
cd services/api
APP_ENV=dev ALLOW_DEV_LOGIN=1 BOOTSTRAP_ADMINS=you@vnpay.vn go run ./cmd/server   # Postgres nhúng (tải binary lần đầu), đăng nhập dev
```
`ALLOW_DEV_LOGIN` bị từ chối khi `APP_ENV=prod`.

## Build và phát hành

Workflow `.github/workflows/desktop-build.yml` build Desktop (Windows, macOS, Ubuntu, Debian), API service x64 (Linux và Windows) và web BO. Push tag `desktop-v<version>` để phát hành các gói cùng một GitHub Release, ví dụ `desktop-v0.1.1`. Version desktop trong `tauri.conf.json`, `Cargo.toml` và `apps/desktop/package.json` cần khớp với tag.

API được đóng gói cùng tài liệu vận hành; web BO gồm thư mục `dist` để phục vụ bằng web server. Các gói và release có SHA-256 checksums. Cấu hình triển khai và private keys được cung cấp riêng trên server; xem [SECURE-TRANSPORT.md](docs/SECURE-TRANSPORT.md) để đồng bộ public pins giữa API, desktop và web BO.

Nếu các build đã thành công nhưng bước xuất bản lỗi, chạy workflow `Publish built release` với `build_run_id` của lần build và `release_tag` tương ứng. Workflow kiểm tra commit của tag và kết quả từng build trước khi xác minh checksum và xuất bản các artifact có sẵn.

## Trạng thái
Xem mục "Đã kiểm chứng / chưa kiểm chứng" trong `docs/TEST-PLAN.md` §1. Các tích hợp ngoài (SMTP, VNPAY LLM, Trino SSO, KMS) chưa được kiểm với hệ thống thật.

Ứng dụng bỏ qua quét AV (`skipped:av_disabled`); AV trên server được vận hành riêng. Bước kiểm tra PII/nội dung và phê duyệt vẫn chạy.
