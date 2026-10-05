# Thông tin cần VNPAY cung cấp / xác nhận

Mã nguồn **không** tự suy đoán các mục dưới đây; mỗi mục có adapter/cấu hình tương ứng và sẽ báo lỗi rõ ràng khi thiếu. Cột "Ảnh hưởng" cho biết phần nào bị chặn nếu chưa có.

## 1. VNPAY LLM Agent
| Cần | Chi tiết | Ảnh hưởng / nơi cấu hình |
|---|---|---|
| Base URL, đường dẫn chat/completions, đường dẫn kiểm tra token | có tương thích OpenAI không? | mục `agent.endpoints` trong `config.json` của desktop (mẫu: `apps/desktop/src-tauri/config.sample.json`; `agent.authHeader`/`agent.authScheme` nếu gateway không dùng `Authorization: Bearer`) |
| Cách xác thực | header nào (Authorization: Bearer / khác), định dạng token, thời hạn, cách thu hồi | mapping `authHeader/authScheme` |
| Danh sách model được phép | id, giới hạn context (token), giới hạn tốc độ | `PUT /agent/settings` |
| Hỗ trợ streaming? | SSE hay không | hiện chỉ non-streaming |
| Chính sách dữ liệu | metadata schema (tên bảng/cột) có được gửi lên LLM nội bộ không; có lưu prompt không | quyết định `budgetChars`, có bật gửi DDL |
| Mạng | **máy người dùng (desktop)** có tới được endpoint LLM / OpenMetadata không; cần proxy? | `proxy.url` trong `config.json` (http/https) hoặc proxy hệ thống |

## 2. Database & driver
| Cần | Ghi chú |
|---|---|
| Phiên bản Oracle (12c/19c/21c), Trino, PostgreSQL và driver đã được phê duyệt | pin trong `services/jdbc/scripts/fetch-drivers.sh`; xác nhận điều khoản phân phối ojdbc |
| Danh sách connection được phép (host, port, service/database, SSL/TLS, truststore nội bộ) | nhập qua `POST /admin/db-targets`; nếu dùng CA nội bộ cần truststore cho JRE sidecar |
| DB nào cho phép ghi/DDL, ai được `db:write` | mặc định chỉ đọc |
| **Máy user có tới được DB/Trino trực tiếp không?** | bắt buộc với kiến trúc hiện tại (không có DB qua backend). Nếu VNPAY chỉ cho DB truy cập từ jump/mạng riêng thì tính năng DB của desktop không dùng được — cần quyết định lại |
| Audit phía DB (Oracle Unified Auditing, pgaudit, Trino event listener) có bật không | audit của desktop là tự khai báo; cần audit phía DB để có bằng chứng độc lập |
| Truststore CA nội bộ cho JDBC | đóng gói cùng bản build desktop |
| Tài khoản DB: mỗi user tự có, hay dùng SSO/Kerberos? | thiết kế hiện tại dùng tài khoản của chính user; không dùng tài khoản chung |

## 3. Trino SSO (khảo sát thực tế)
Cần xác nhận trên hạ tầng thật (chưa thể khẳng định từ xa):
1. `http-server.authentication.type` của Trino có gồm `oauth2` không; `web-ui.authentication.type`?
2. Issuer/`authorization-url`/`token-url` cấu hình trên Trino trỏ tới `s2o.vnpay.vn` hay `accounts.google.com` (hay s2o federate Google)?
3. Trino JDBC client đi thẳng tới coordinator hay qua load balancer/ingress; có cần `externalAuthentication` hay dùng JWT/`accessToken`?
4. Thời hạn token/cookie do Trino cấp; có refresh không (nếu không, mỗi lần hết hạn user đăng nhập lại trong trình duyệt).
5. Coordinator có ra được IdP qua proxy không (chặng "coordinator → IdP" thuộc phía Trino, ứng dụng không điều khiển).
6. Phiên bản Trino JDBC tương thích với phiên bản Trino server.

## 4. Proxy theo từng chặng
Điền bảng sau cho mỗi môi trường (test/prod):

| Chặng | Có cần proxy? | Địa chỉ / PAC | Xác thực proxy | Ghi chú |
|---|---|---|---|---|
| Trình duyệt user → s2o / google | | | | trình duyệt hệ thống dùng proxy Windows |
| SPA/Rust → API | | | | `proxy.url` trong `config.json` desktop |
| Sidecar JDBC → Trino coordinator / Oracle / PG | | | | `db-targets.proxy` (HTTP/SOCKS) — Oracle/PG thin driver không có proxy HTTP: cần mạng trực tiếp |
| Backend → IdP (JWKS/token) | | | | `OUTBOUND_PROXIES.oidc` |
| Backend → SMTP relay | | | | TCP trực tiếp tới relay (không qua proxy HTTP) |
| Desktop → LLM / OpenMetadata | | | | `proxy.url` / proxy hệ thống |
| Coordinator → IdP | | | | phía hạ tầng Trino |

## 5. Email thông báo (SMTP)
Cần: host/port SMTP relay nội bộ, chế độ TLS (STARTTLS/implicit) và chứng chỉ (CA nội bộ?), tài khoản gửi (hoặc relay theo IP), địa chỉ `MAIL_FROM` và **SPF/DKIM/DMARC** cho domain gửi (chống giả mạo), giới hạn tốc độ/kích thước, có cần mailbox chung để nhận bounce không, chuẩn tên hiển thị. Xác nhận địa chỉ email trong hồ sơ SSO (`email` claim) là địa chỉ nhận thư thật của leader. Ngoài ra: có cần nhắc duyệt/leo thang khi leader không phản hồi (P2)?

## 6. SSO cho BO/API
**Desktop** đăng nhập qua broker `genai.vnpay.vn` (luồng đã có sẵn ở các ứng dụng nội bộ khác): app mở `…/create-jwt-token?connectid=<cổng>` (như `antisw`), genai làm SSO rồi chuyển JWT về loopback; API hỏi broker qua HTTPS để biết email. Cần từ VNPAY: (a) **cách xác minh JWT** — một trong hai: **khóa `SharingKey`** (base64, HS256) để API kiểm chữ ký cục bộ (`GENAI_JWT_KEY`, *ưu tiên*, cần xin từ chủ sở hữu genai và cất ở secret store; ai giữ khóa đều tạo được token cho bất kỳ ai nên chỉ cấp cho dịch vụ này), hoặc **URL verify** `GET https://genai.vnpay.vn/verify/me` (`GENAI_VERIFY_URL`) — đã viết `VerifyMeHandler` trong `VNE-GO/llm/main.go` + `verifyJWTStrict` trong `verichain.go` (kèm test); **cần deploy bản này lên genai** trước khi dùng. Đây là cách khuyến nghị (API không giữ khóa). Đã thử từ máy dev: `https://genai.vnpay.vn/verify/me` → 404; `gravityland.vnoffice.io.vn/verify/me` → trang HTML 200 dù token giả (xem F7). Tên claim qua `GENAI_EMAIL_PATH`/`GENAI_NAME_PATH` (mặc định `email`/`userFullName` theo mã broker); (b) domain email được phép (`ALLOWED_EMAIL_DOMAINS`, bắt buộc ở prod); (c) khuyến nghị (không chặn): xử lý F1/F3 trong `SECURITY-FINDINGS.md` ở phía genai; khi genai kiểm tra `connectid`, có thể bật `genaiSecretPath` ở desktop; (d) `GENAI_LOGIN_URL` (`https://genai.vnpay.vn/create-jwt-token`); (e) proxy cho chặng API → genai (`OUTBOUND_PROXIES.genai`).
**Web BO** (truy cập từ Internet) dùng OIDC trực tiếp như dưới đây.
issuer, client id/secret (web, confidential), client id native/public cho desktop loopback (`http://127.0.0.1:{port}/cb` phải được đăng ký/cho phép dải cổng), scopes, claim `email`/`email_verified`/`auth_time`, hỗ trợ `prompt=login`+`max_age`, thời hạn phiên, logout endpoint, MFA. Nếu IdP không cho redirect loopback động → cần phương án môi giới (broker) qua backend.

## 7. Lưu trữ, khóa, bí mật
Kho file (S3-compatible/NFS/khác), dung lượng, retention, sao lưu; KMS/HSM để bọc khóa (`KeyProvider` hiện có `StaticKeyProvider` chỉ cho dev/test); secret manager (Vault…); yêu cầu mã hóa lưu trữ; chuẩn log tập trung/SIEM (định dạng, kênh); AV do server vận hành riêng; ứng dụng không tích hợp scanner.

## 8. Chính sách nghiệp vụ
Danh sách leader; định dạng file cho phép, dung lượng tối đa, TTL duyệt/tải, số lần tải tối đa, ai được là người nhận, có cho ủy quyền không và tối đa bao lâu; chính sách xóa/lưu giữ; nội dung audit phải lưu bao lâu; DLP.

## 9. Hạ tầng (jump/PAM)
Xem `JUMP-POLICY.md` — cần danh sách kênh đang bật thực tế và sản phẩm PAM/jump đang dùng.

## 10. Phân phối desktop
Chứng chỉ ký mã Windows, kênh cập nhật (URL host `latest.json`), cặp khóa updater Tauri, chính sách cài (per-user/all-users, GPO/SCCM), kích hoạt WebView2 offline installer hay không, CSP `connect-src` cho origin API từng môi trường.
