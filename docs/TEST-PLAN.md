# Kiểm thử và nghiệm thu

## 1. Kiểm thử tự động (chạy được ngay, không cần hạ tầng VNPAY)

`npm test` chạy shared, desktop SPA, web BO và API. `npm run typecheck` kiểm tra tất cả workspace TypeScript. CI `Application checks` chạy các bộ frontend, build desktop SPA/web BO và `go test -race ./...`; workflow desktop kiểm tra JDBC và Rust khi đóng gói.

| Bộ | Lệnh | Bao phủ chính |
|---|---|---|
| shared | `npm test -w @vnpay/shared` | classifier SQL (vector dùng chung TS/Java), RBAC + trạng thái ticket, redact, **context Agent không vượt quyền** (chỉ bảng trong `accessible`, ngân sách, chống injection, dòng dữ liệu cần xác nhận) |
| api | `cd services/api && go test ./...` | SSO OIDC+PKCE qua **proxy theo chặng** (mock IdP ký RS256, kiểm PKCE/nonce/aud/iss/state dùng một lần/open-redirect/step-up/CSRF/desktop loopback + refresh rotation); **danh mục DB + audit desktop** (không còn route phiên DB trên server, audit che literal, cờ `policy_violation`); **Agent** (token mã hóa, verify trước khi lưu, context, SQL không tự chạy, audit không chứa prompt); **upload** (resume, part trùng/xung đột, hash sai, idempotent complete); **duyệt/tải** (người gửi không tự duyệt, leader không chỉ định, ủy quyền hiệu lực/thu hồi/hết hạn, đổi leader, token một lần, hết hạn, thu hồi, quyền kiểm tra lại lúc tải, giới hạn lượt tải); **AV bypass** (upload sang chờ duyệt, kết quả skipped:av_disabled, PII vẫn chạy, không ghi clean; adapter cũ vẫn có test cách ly/lỗi); **email** (SMTP lỗi → `notify_state=ERROR` rồi tự lành, không gửi trùng, dead-letter + retry admin, không gửi khi ticket đã được quyết định, người nhận đúng, escape HTML, chống chèn header, giao thức SMTP với stub); adapter clamd (khung INSTREAM), chế độ cấu hình prod |
| jdbc | `cd services/jdbc && mvn test` | xem `services/jdbc/README.md` |
| desktop | `cd apps/desktop/src-tauri && cargo test` | PKCE RFC 7636, loopback callback (state/lỗi/timeout), allowlist method sidecar, size cap, restart policy, redaction |
| web/desktop SPA | `npm test -w @vnpay/web` | hai bản build (web không có TableDB/upload, desktop không có duyệt/tải/admin), CSRF/bearer/step-up, chunker upload, disclosure context Agent, xác nhận ghi, hàng đợi audit DB, guard quyền |
| web BO | `npm test -w @vnpay/web-bo` | routes, guards, API client, upload và giao diện chuyển file/manifest |

**Chưa được kiểm thử tự động (cần môi trường thật):** kết nối Oracle/Trino/PG thật; Trino SSO end-to-end; SMTP relay thật (mới kiểm với SMTP stub); LLM thật; build/cài trên Windows; Credential Manager; updater; jump/PAM.

## 2. Nghiệm thu MVP (môi trường test của VNPAY)

| ID | Kịch bản | Kỳ vọng |
|---|---|---|
| A1 | Thêm profile Oracle/PG/Trino, "Kiểm tra kết nối" (đúng & sai mật khẩu) | thành công/lỗi dễ hiểu; password không xuất hiện trong log/audit |
| A2 | Duyệt catalog→schema→table/view→column, xem DDL/khóa/mô tả | chỉ thấy đối tượng tài khoản có quyền; đối chiếu với DBeaver cùng tài khoản |
| A3 | SQL editor: chạy, hủy truy vấn dài, giới hạn dòng/thời gian, phân trang, lỗi cú pháp | hủy hiệu lực trong vài giây; trần theo cấu hình |
| A4 | Thử `DELETE`/`DROP`/nhiều câu lệnh ở chế độ đọc; ghi bằng tài khoản có `db:write` trên target `allowWrite` | chế độ đọc từ chối; ghi cần hộp xác nhận + audit |
| A5 | Agent: nhập token, kiểm tra, chọn model; hỏi về bảng đang chọn | manifest hiển thị đúng bảng/cột đã đưa vào; SQL hiện trong khung, không tự chạy |
| A6 | Agent với bảng user không có quyền (chọn tay/nhắc tên) | không xuất hiện trong prompt (kiểm tra qua context-preview & log LLM proxy) |
| A7 | (desktop) Upload file lớn (≥1 GB), ngắt mạng giữa chừng, tiếp tục | tiếp tục từ phần còn thiếu; checksum khớp |
| A8 | Hoàn tất upload → sau khi kiểm tra PII/nội dung (AV bỏ qua), leader nhận **một** email đúng nội dung (mã, người gửi, tên file, kích thước, SHA-256, mục đích, link BO) | không có nội dung file, không có link duyệt trực tiếp; ticket hiện "Chờ duyệt", `notify_state=SENT` |
| A9 | Leader (đúng/sai/ủy quyền) duyệt-từ chối trên web BO | chỉ leader được chỉ định/ủy quyền; người gửi không duyệt được; lý do bắt buộc khi từ chối |
| A10 | Người gửi/người nhận đăng nhập lại và tải trên web BO | yêu cầu step-up; hash khớp; audit ghi ai/lúc nào/checksum |
| A11 | Thu hồi / hết hạn / file EICAR | quyền tải mất ngay; EICAR bị cách ly, không tới leader |
| A12 | Chặn SMTP rồi mở lại | ticket vẫn vào "Chờ duyệt", hiện "chưa gửi được email"; leader thấy ticket trong danh sách BO; sau khi mở SMTP thư tự được gửi (1 lần), không trùng |

## 3. Giai đoạn 2–3

| ID | Kịch bản |
|---|---|
| B1 | Trino SSO qua proxy: mở trình duyệt hệ thống, đăng nhập s2o, JDBC tiếp tục; kiểm tra từng chặng bằng `diag.proxy` |
| B2 | Trino hết hạn token giữa chừng → tự yêu cầu đăng nhập lại, truy vấn tiếp tục/báo lỗi rõ |
| B3 | Đăng nhập Google qua s2o federate (nếu có): không thu thập mật khẩu Google trong app (kiểm tra bằng bắt gói/không có WebView nhập mật khẩu) |
| B4 | Kiểm tra email thật: SPF/DKIM/DMARC pass, không vào spam, hiển thị đúng tiếng Việt/HTML trên Outlook và mobile; link BO đúng môi trường |
| B5 | Admin retry outbox sau sự cố SMTP |
| B6 | Ủy quyền leader theo thời hạn; đổi leader khi ticket đang chờ |
| B7 | Cập nhật desktop (updater) và driver mới; bản chữ ký sai bị từ chối |
| B8 | Kiểm tra checksum driver: sửa 1 byte JAR → sidecar từ chối nạp |
| B9 | SSH tunnel qua bastion thật (mật khẩu, rồi khóa ed25519/RSA có passphrase): lần đầu hiện vân tay, so với vân tay quản trị cung cấp (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), kết nối Oracle/PG/Trino; đổi host key trên máy test → cảnh báo "khóa đã thay đổi" |
| B10 | Jump 2 chặng (bastion → jump nội bộ → DB) và SSH qua proxy công ty; bastion `AllowTcpForwarding no` → lỗi rõ "port forwarding disabled"; ngắt mạng giữa chừng → `E_CONN`, kết nối lại được |
| B11 | Proxy SOCKS5/HTTP có tài khoản tới Oracle/PG; sai mật khẩu → `E_PROXY_AUTH`; audit `db.custom.session.open` có `route`, không có mật khẩu; file export kết nối không có mật khẩu/passphrase/keyId |
| B12 | Editor: Ctrl+Enter chạy đúng câu tại con trỏ; script 3 câu (đọc/ghi/đọc) ở chế độ ghi: câu ghi hỏi riêng, Bỏ qua/Dừng hoạt động; khối PL/SQL `BEGIN … END;` và `CREATE PROCEDURE … /` chạy nguyên khối (Oracle thật) |
| B13 | Commit thủ công trên PG/Oracle thật: ghi → phiên khác không thấy → Commit → thấy; Rollback; ngắt kết nối khi còn thay đổi → hộp thoại; idle 30 phút → rollback |
| B14 | `query.plan` trên PG/Oracle/Trino thật (Oracle cần PLAN_TABLE), kể cả DELETE — xác nhận dữ liệu không đổi; `DBMS_OUTPUT` hiện trong kết quả |
| B15 | Sửa ô / thêm / xóa dòng trên bảng có khóa chính → câu lệnh duyệt trước → lưu trong một transaction; lỗi giữa chừng → không dòng nào bị ghi. Import CSV/XLSX: ánh xạ cột, upsert (PG `ON CONFLICT`, Oracle `MERGE`), "xóa rồi nạp" |
| B16 | Cây đối tượng (procedure/function/package/sequence/synonym/trigger/mview), source qua DBMS_METADATA/ALL_SOURCE; tìm đối tượng toàn CSDL; giám sát phiên/khóa và kill (cần quyền DB); sơ đồ ER; so sánh schema UAT ↔ PROD |
| C1–C5 | Agent bảng liên quan (FK); luồng kết quả lớn; S3+KMS; quét lại định kỳ; thông báo |

## 4. Kiểm thử hạ tầng jump (đội hạ tầng/đỏ) — xem `JUMP-POLICY.md`
J1 SCP/SFTP bị chặn · J2 port-forward bị chặn · J3 clipboard RDP · J4 drive mapping · J5 tải/upload qua trình duyệt trên jump · J6 rz/sz · J7 remote khác (AnyDesk…) · J8 luồng thay thế BO hoạt động và có audit.

## 5. Tiêu chí hoàn thành MVP
Tất cả A1–A12 đạt trên môi trường test; test tự động xanh; không có secret trong log (rà soát mẫu log các luồng A1–A12); audit chain `GET /audit/verify` = ok; tài liệu triển khai được đội vận hành chạy lại từ đầu thành công.
