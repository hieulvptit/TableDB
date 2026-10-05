# VNPAY TableDB & SecureTransfer — Kiến trúc, ranh giới tin cậy, threat model

Trạng thái: thiết kế v1 (đi kèm mã nguồn trong repo). Mọi điểm đánh dấu **[ASSUMPTION]** là giả định chưa được VNPAY xác nhận — xem `VNPAY-INPUTS.md`.

## 1. Thành phần

| Thành phần | Công nghệ | Vai trò |
|---|---|---|
| `apps/web` | React + TS + Vite | Bản **desktop** (cài ở máy jump, `VITE_TARGET=desktop`) = TableDB + Agent + upload file jump → office + tải file office → jump. Dùng chung design system và mô hình phân quyền. |
| `services/web` | React + TS + Vite | **Web BO** (ở office, `@vnpay/web-bo`) = duyệt + tải file jump → office + upload file office → jump + audit. Codebase riêng chỉ cho web, build ra `services/web/dist` để nginx phục vụ. **Không** có phần database. |
| `apps/desktop` | Tauri 2 (Rust), Windows | Vỏ desktop: quản lý JDBC sidecar, kho bí mật (Windows Credential Manager), mở trình duyệt hệ thống, loopback OIDC callback, updater, log. |
| `services/jdbc` | Java 21 (JDK only + JDBC driver đã kiểm duyệt) | JDBC **sidecar chỉ của desktop** (`--stdio`). Chế độ `--http` còn trong mã nhưng **không triển khai** ở backend (quyết định: web không có DB). |
| `services/api` | Go (net/http + pgx) | Backend: SSO/phiên, RBAC, danh mục kết nối + nhận audit từ desktop (DB và Agent; **Agent không chạy ở server**), ticket, upload, phê duyệt, tải file, audit, outbox (kiểm tra PII/nội dung, email thông báo). |
| PostgreSQL | — | CSDL ứng dụng (users, tickets, audit, outbox…). Test/dev dùng Postgres nhúng (embedded-postgres). |
| Kho file | Local FS mã hóa (dev) / adapter S3-compatible (prod) **[ASSUMPTION]** | File mã hóa AES-256-GCM, khóa từ KMS/secret store. |
| AV | `DisabledScanner` | Bỏ qua AV trong ứng dụng (`skipped:av_disabled`); công cụ AV trên server được vận hành riêng. |
| SMTP relay | do VNPAY cung cấp | Gửi email thông báo cho leader/người gửi/người nhận qua `Mailer`; không có hệ thống ticket bên ngoài. |
| IdP | `s2o.vnpay.vn`, `accounts.google.com` | OIDC **[ASSUMPTION: s2o là OIDC-compliant]**. |

## 2. Phân chia sản phẩm và sơ đồ triển khai

| | **Desktop app (Windows)** | **Web BO** |
|---|---|---|
| Người dùng | nhân viên vận hành/phát triển | người gửi (xem trạng thái), leader, người nhận, admin |
| Chức năng | TableDB (kết nối DB, metadata, SQL editor), Agent, **upload file (jump → office)**, **tải file office → jump** (hộp thoại lưu trong Rust, ghi `.part` rồi kiểm size + SHA-256 mới đổi tên), xem/thu hồi lượt gửi của mình | **duyệt/từ chối**, **tải file jump → office**, **upload file (office → jump)**, quản trị (danh mục DB, leader, user, outbox, audit) |
| Truy cập database | **Có**, qua JDBC sidecar cục bộ | **Không** (không JDBC, không dịch vụ DB ở backend) |
| Xác thực | OIDC loopback + bearer | OIDC web + cookie + CSRF, step-up khi tải |

```
   MÁY NGƯỜI DÙNG (Windows) — desktop                                        MẠNG NỘI BỘ / DMZ VNPAY
 ┌────────────────────────────────────────────────────┐              ┌───────────────────────────────────────────────┐
 │ Tauri desktop                                      │ (1) HTTPS    │ Reverse proxy / WAF (TLS, rate-limit)         │
 │  ┌────────────┐ invoke ┌───────────────────────┐   │ ───────────► │     │                                         │
 │  │ WebView    │◄──────►│ Rust core             │   │ API+SSO      │     ▼                                         │
 │  │ React SPA  │        │ - keyring (Cred Mgr)  │   │ upload       │  ┌────────────┐ (5) HTTPS ┌────────────────┐  │
│  │ (desktop)  │        │ - loopback :random    │   │ audit        │  │ services/  │ ────────► │ SMTP relay     │  │
 │  └────────────┘        │ - open system browser │   │ agent audit  │  │ api        │           │ servicehub.vn  │  │
 │                        └──────┬────────────────┘   │              │  │ + worker   │ (6) PII   └────────────────┘  │
 │                        stdio  │ NDJSON             │              │  └──┬───┬─────┘ ────────► LLM PII              │
 │                        ┌──────▼────────────────┐   │              │     │   │ (4) SQL   ► PostgreSQL (app DB)     │
 │                        │ JRE + jdbc.jar        │   │              │     │   └────────► Kho file (mã hóa) / KMS   │
 │                        │ (sidecar --stdio)     │   │              │                                                  │
 │                        └──────┬────────────────┘   │              └───────────────────────────────────────────────┘
 └───────────────────────────────┼────────────────────┘
        (2) JDBC trực tiếp (qua proxy nếu cần)                       Web BO (trình duyệt) ── (1) HTTPS ──► proxy ──► API
        ▼                                                             IdP s2o / Google ◄── (3) trình duyệt (SSO BO & Trino)
   Oracle / Trino / PostgreSQL        Trino coordinator ◄── external auth ──► IdP (coordinator→IdP: phía hạ tầng Trino)
```

Kết nối theo nguồn:

**Đi từ máy người dùng (desktop):** (1) SPA→API HTTPS (đăng nhập, danh mục target, upload, audit DB và audit Agent — chỉ metadata); (2) sidecar→Oracle/PG/Trino bằng JDBC, chỉ tới các target trong *danh mục admin* và bằng tài khoản của chính người dùng — **máy người dùng phải tới được DB/Trino**; nếu mạng không cho phép thì tính năng DB của desktop không dùng được (đã loại bỏ phương án DB qua backend); (3) trình duyệt hệ thống→IdP và Trino coordinator (SSO).
**Đi từ trình duyệt (web BO):** chỉ (1) HTTPS tới API, và (3) tới IdP.
**Đi từ backend:** (4) API→app DB; (5) API→SMTP relay (email thông báo); (6) API→LLM PII (nếu bật); API→KMS; **Trino coordinator→IdP** (không đi qua client). Backend **không** kết nối tới Oracle/Trino/PostgreSQL nghiệp vụ và **không** gọi LLM/OpenMetadata (Agent chạy trên desktop). **Đi từ máy người dùng thêm (7):** lõi Rust của desktop → LLM gateway (`agent.endpoints` trong `config.json`) và OpenMetadata MCP (`agent.openMetadataUrl`) qua HTTPS; máy người dùng phải tới được các endpoint này.

### Hệ quả của việc tách
- Backend không giữ credential DB nào của người dùng; bề mặt tấn công nhỏ hơn.
- **Server không chặn được SQL ở thời điểm chạy** (SQL chạy từ máy user tới DB). Hàng rào thực: quyền tài khoản DB + sidecar (read-only, classifier, allowlist driver). Server chỉ cấp danh mục target, nhận audit do desktop báo (kèm cờ `db.query.policy_violation` khi mâu thuẫn chính sách) — audit này là *tự khai báo*, không phải bằng chứng chống chối cãi; muốn bằng chứng phía DB cần bật audit của chính DB (Oracle Unified Auditing, pgaudit, Trino event listener).
- Metadata cho Agent: sidecar → SPA → harness cục bộ → LLM (không qua API); không tin được về bảo mật nhưng chỉ ảnh hưởng chính người đó (họ vốn có thể gửi bất kỳ nội dung nào lên LLM).
- Credential DB: Windows Credential Manager → sidecar qua stdio; không ghi đĩa/log. Trino SSO không cần password.
- Trino SSO chỉ còn chạy ở desktop (URL đăng nhập đi sidecar → Rust → trình duyệt hệ thống), nên không còn vấn đề sự kiện `auth.openUrl` ở web.


## 3. Ranh giới tin cậy

- **TB0 — WebView/SPA/máy user: không tin cậy.** Ẩn nút chỉ là UX. Mọi quyết định quyền thực thi ở API hoặc DB.
- **TB1 — API**: điểm quyết định RBAC theo tài nguyên + trạng thái ticket. Mọi route có `authorize(policy, resource)`.
- **TB2 — Service tích hợp** tách credential: `svc-mail`, `svc-file` (mỗi cái là "service principal" với scope riêng, secret riêng; secret SMTP chỉ ở module mailer/outbox). Token LLM/OpenMetadata của user **không** lên server: nằm trong kho credential của OS trên máy user, chỉ lõi Rust đọc lại (WebView chỉ ghi/xóa được).
- **TB3 — sidecar (trên máy user)**: không tự ra quyết định phân quyền người dùng; nhưng là **hàng rào cuối** cho SQL đọc/ghi (read-only connection + classifier) và allowlist driver.
- **TB4 — DB đích**: quyền thực sự của tài khoản người dùng. Không dùng tài khoản chung để nới quyền.
- **TB5 — SMTP / LLM / IdP**: bên ngoài; dữ liệu trả về coi là không tin cậy. **Email leader chứa capability duyệt**: link riêng cho phiếu và approver, một lần, tối đa 24 giờ. Người giữ toàn bộ link có thể duyệt mà không SSO; không chuyển tiếp email. Token chỉ cho phép approve phiếu đó, không cấp phiên đăng nhập hay quyền tải file; tải vẫn cần SSO.

## 4. Xác thực

1. **Web BO**: OIDC Authorization Code + PKCE, backend là confidential client (BFF). Cookie phiên `__Host-` httpOnly, SameSite=Lax, CSRF token cho request thay đổi trạng thái. Đăng nhập lại (step-up) trước khi tải file: `max_age` / `prompt=login` và kiểm tra `auth_time` trong ID token ≤ `DOWNLOAD_REAUTH_MAX_AGE_SEC`.
2. **Desktop→API (mặc định)**: đăng nhập qua broker SSO nội bộ `genai.vnpay.vn`: app mở trình duyệt hệ thống tới `create-jwt-token?connectid=<cổng>` (đúng như ứng dụng `antisw`), broker làm SSO (s2o/Google) rồi chuyển JWT về `http://localhost:<cổng>/sso-callback?token=…` trên listener loopback (chỉ nhận một callback, kiểm tra Host; tùy chọn `genaiSecretPath` thêm đường dẫn bí mật khi genai đã kiểm tra `connectid`); app gửi JWT cho `POST /auth/desktop/genai`, API hỏi broker qua HTTPS. Rủi ro còn lại ở genai (F1/F3 trong `SECURITY-FINDINGS.md`) thuộc chủ sở hữu genai; không chặn việc dùng luồng này. Web BO dùng OIDC trực tiếp. *Phương án dự phòng*: system browser + loopback redirect `http://127.0.0.1:<port>/cb` (RFC 8252) với PKCE; Rust core nhận `code`, gọi `POST /auth/desktop/exchange` (API đổi code với IdP, trả access token ngắn hạn + refresh token; lưu trong Credential Manager). Không có WebView đăng nhập Google (Google cấm và không thu thập mật khẩu).
3. **Trino SSO** (khác với đăng nhập BO): dùng `externalAuthentication=true` của Trino JDBC. Coordinator tự làm OAuth2 với IdP; JDBC nhận URL đăng nhập → sidecar phát sự kiện `auth.openUrl` → Rust/SPA mở trình duyệt hệ thống → JDBC poll token endpoint của Trino → tiếp tục. Trino tự cấp cookie/JWT; khi hết hạn JDBC kích hoạt lại luồng (sự kiện `auth.openUrl` lần nữa). **[ASSUMPTION: Trino đang cấu hình `http-server.authentication.type=oauth2`; cần xác nhận thực tế — VNPAY-INPUTS §3]**.
4. **Proxy theo từng chặng** (không giả định một proxy giải quyết tất cả):

| Chặng | Ai thực hiện | Cấu hình |
|---|---|---|
| Trình duyệt → IdP (s2o/google) | Trình duyệt hệ thống của user | Proxy hệ thống/PAC của Windows; app không can thiệp, chỉ kiểm tra khả năng tới được (`diag.proxy`). |
| JDBC client → Trino coordinator | Sidecar (desktop) | `httpProxy` / `socksProxy` trong `profile.options.proxy` (thuộc tính Trino JDBC). |
| JDBC client → Oracle/PG/driver custom, hoặc bất kỳ DB qua bastion | Sidecar (desktop) | Người dùng bật "Kết nối nâng cao": proxy HTTP CONNECT/SOCKS5 (có thể có tài khoản) và/hoặc chuỗi 1–4 máy SSH (mật khẩu hoặc khóa riêng import vào app-data, host key ghim theo vân tay SHA-256, xác nhận lần đầu). Sidecar mở relay `127.0.0.1:<ngẫu nhiên>` cho phiên; xem `SIDECAR-PROTOCOL.md` "Tunnel". Audit phiên ghi `route` (vd. `SSH bastion:22 → jump:22`, không có bí mật). |
| Trino coordinator → IdP | Server Trino | Phía hạ tầng Trino (`http-server.authentication.oauth2.*` + JVM proxy); ứng dụng không điều khiển được. |
| SPA/Rust → API | Rust `reqwest` / trình duyệt | Proxy Windows/`HTTPS_PROXY`; cấu hình `proxy.url` trong config desktop. |
| API → OIDC token/JWKS | Node (`undici ProxyAgent`) | `OUTBOUND_PROXIES` riêng từng đích (`oidc`). SMTP là TCP thẳng tới relay nội bộ (không qua proxy HTTP). |

5. **RBAC**: `user`, `leader`, `admin`, `service`. Chi tiết `packages/shared/src/rbac.ts`. Leader được chỉ định theo ticket (`approver_id`) + ủy quyền có thời hạn (`delegations`). Người gửi không bao giờ duyệt được ticket của mình (kiểm tra ở service + ràng buộc CHECK ở DB).

## 5. TableDB & Agent

- **Nơi chạy Agent: hoàn toàn trên desktop.** Harness (vòng lặp tool, sub-agent, skills, sanitize/redact) là TypeScript trong `apps/web/src/features/agent/harness/` (chạy trong WebView, test bằng vitest); `features/agent/service.ts` ghép cấu hình, token, chat và audit. Mạng đi qua **một cầu HTTP duy nhất trong lõi Rust** (`agent_http`, `src-tauri/src/agent_http.rs`): WebView chỉ nêu *đích* (id endpoint LLM hoặc "om"); Rust tra URL gốc từ `config.json` đã kiểm (https; http chỉ loopback ngoài prod), gắn credential lấy từ kho OS (hoặc token đang được kiểm tra trước khi lưu), không theo redirect, giới hạn kích thước body, cho phép hủy. Nhờ vậy không cần mở CSP `connect-src` cho LLM và WebView không đọc lại được token (`secret_get` từ chối khóa `agent:token:*`). Cấu hình ở mục `agent` của `config.json` (`endpoints`, `defaultEndpointId`, `defaultModel`, `budgetChars`, `openMetadataUrl`, `authHeader`/`authScheme`; env `TABLEDB_OPENMETADATA_MCP_URL`). Server chỉ còn `POST /agent/audit` (xem Audit).

- **JDBC**: JRE đóng gói bằng `jlink` cùng app (không phụ thuộc JRE máy user), JAR sidecar + driver trong `resources/`, `drivers/manifest.json` chứa SHA-256 + phiên bản khóa; sidecar từ chối nạp driver sai checksum, nạp qua `URLClassLoader` riêng + `DriverShim`. Không có UI/tham số nhập JAR tùy ý ở bản đầu. Cập nhật driver = phát hành bản app/sidecar mới đã ký (updater Tauri xác thực chữ ký).
- **Vì sao sidecar chứ không nạp JAR vào WebView**: WebView không chạy JVM/JDBC; sidecar là tiến trình riêng, giao thức stdio giới hạn (method allowlist, kích thước message tối đa, không có "exec"), quyền tối thiểu.
- **Read/write**: mặc định session read-only (`Connection.setReadOnly(true)` + classifier từ chối không phải SELECT/WITH/EXPLAIN/SHOW/DESCRIBE). Ghi/DDL cần: quyền `db:write` (lấy từ `/auth/me`) + target `allowWrite` (admin bật trong danh mục) + xác nhận rõ ràng từng lệnh. Vì SQL chạy từ máy người dùng, các điều kiện này do desktop/sidecar áp dụng và **không** được server cưỡng chế; server chỉ ghi nhận và gắn cờ vi phạm (xem §2). SQL do Agent sinh **không bao giờ tự chạy**.
- **Agent context** (`packages/shared/src/agent-context.ts`): ưu tiên theo mức (đối tượng đang chọn → bảng liên quan qua FK → còn lại), ngân sách ký tự/token, cache theo `(userId, connectionId, metadataVersion)`, invalidate khi quyền/schema đổi (fingerprint metadata). UI luôn hiển thị *manifest* những gì đưa vào prompt. Không có dữ liệu hàng trừ khi user chọn và xác nhận từng lần (`rowsConsent`).
- **Báo cáo / Dashboard (desktop, local)** (`apps/web/src/features/report`): kết quả query có thêm kiểu hiển thị *Biểu đồ* (cột/đường/tròn/KPI, vẽ SVG, không thêm thư viện). Agent **vẫn không có tool**: nó chỉ có thể đề xuất một khối ```chart (JSON); UI kiểm tra khối đó với các cột thật của kết quả hiện tại (`parseChartSpec`, whitelist) và chỉ áp dụng khi người dùng bấm. "Ghim vào Dashboard" chỉ nhận một câu SELECT đơn không bind; widget lưu **SQL + cấu hình biểu đồ** trong workspace mã hóa trên máy (không lưu dòng dữ liệu, không lên server) và chạy lại qua `runAudited(..., 'read')` nên vẫn qua classifier/sidecar read-only và audit như editor.
- **Phiên chat & bộ nhớ Agent (desktop, local)**: mỗi cuộc trò chuyện là một `ChatSession` (chỉ văn bản; không lưu dòng dữ liệu hay manifest) trong workspace mã hóa; có danh sách (tìm kiếm, ghim, đổi tên, xuất Markdown, xóa). Ngữ cảnh gửi LLM = các tin chưa được tóm tắt + `summary` cuốn chiếu (khi >24 tin chưa tóm tắt, một lời gọi LLM phụ gộp phần cũ, giữ 12 tin gần nhất) + các *ghi nhớ* người dùng đang bật. Ghi nhớ và tóm tắt được đặt trong lượt user đầu tiên, gắn nhãn là dữ liệu tham khảo, **không** vào system prompt; UI nói rõ số ghi nhớ đang được gửi và mỗi ghi nhớ tắt/xóa được.
- **Agent harness (`apps/web/src/features/agent/harness/`)** — vòng lặp tool có kiểm soát trên giao thức văn bản (khối ```tool JSON, không phụ thuộc function-calling của gateway). Tham khảo deepagents (planning, sub-agent, offload, middleware), supabase/td-skills (skill nạp dần), knowledge-work `data` (các chế độ làm việc):
  - **Orchestrator** (`orchestrator.ts`): system prompt cố định = luật dữ liệu không tin cậy + quy trình (phân loại EXPLORE/WRITE/REVIEW/FIX/ANALYZE/CHART/CHAT → nền tảng hóa theo metadata → nạp skill → lập kế hoạch → ủy quyền → tự kiểm → trả lời) + dialect essentials theo profile + danh mục skill + danh sách tool. Câu hỏi đơn giản trả lời thẳng, không tốn vòng lặp.
  - **Vòng lặp** (`harness.ts`): ngân sách dùng chung toàn run (14 lần gọi LLM, 24 tool call, 150 s) và luôn **dành sẵn 1 lượt cho câu trả lời cuối** (hết ngân sách → chế độ "trả lời ngay, không tool"); tối đa 4 tool call song song/lượt; khối tool sai JSON được phản hồi lại cho LLM; chặn gọi lặp y hệt (lần 3 bị từ chối) và nhắc "dừng cách cũ" sau 3 lượt thất bại liên tiếp.
  - **Offload & nén ngữ cảnh**: kết quả tool >3500 ký tự được ghi vào *virtual FS* của run, LLM chỉ nhận đường dẫn + preview và đọc từng lát bằng `read_file`/`grep`; khi transcript >48k ký tự, kết quả cũ bị thay bằng con trỏ (giữ 2 kết quả mới nhất, không tốn thêm lượt LLM).
  - **Kế hoạch**: tool `write_todos`; LLM không được kết thúc khi còn mục `pending/in_progress` (nhắc tối đa 2 lần).
  - **Sub-agent** (`task`): `sql-reviewer` (rà SQL tĩnh theo skill `sql-review`, ngữ cảnh độc lập, chỉ trả báo cáo cuối) và `metadata-researcher` (tra OpenMetadata hàng loạt; chỉ có khi có OpenMetadata). Sub-agent không ủy quyền tiếp (tool vẫn có nhưng trả lỗi), luôn chừa lượt cho agent cha.
  - **Skill đóng gói sẵn** (`skills/`): `sql-authoring`, `sql-review`, `query-performance`, `data-profiling`, `chart-selection`, `analysis-stats`, `error-fixing`, `dialect-oracle|postgresql|trino`. System prompt chỉ chứa `name: description`; thân skill nạp bằng `load_skill` (mỗi skill một lần), danh mục lọc theo dialect của profile. Skill là văn bản tin cậy của app, không nhận skill do người dùng cung cấp.
  - **OpenMetadata MCP**: `agent.openMetadataUrl` trong `config.json` (https ở prod); mỗi user lưu token riêng trong kho credential của OS (xóa/thay trong panel Agent) và MCP được gọi bằng token của chính user, từ máy user. **Allow-list chỉ đọc** (`search_metadata`, `get_entity_details`, `get_entity_lineage`); tool ghi/sửa không bao giờ được đưa cho LLM hay thực thi. Lỗi MCP → harness chạy tiếp không có OpenMetadata.
  - **An toàn**: kết quả tool và báo cáo sub-agent là dữ liệu không tin cậy — sanitize từng dòng (neutralize chỉ thị, bỏ ký tự điều khiển, vô hiệu hóa fence), redact PII, bọc trong `<<TOOL-RESULT-nonce …>>`; không có tool nào chạy SQL; SQL đề xuất vẫn không bao giờ tự chạy. Audit chỉ ghi số lượt LLM/tool và vết `độ sâu:loại:tên:ok|fail`, không ghi nội dung.
  - **Tiến trình trực tiếp**: harness phát từng bước (suy nghĩ / tool bắt đầu / tool xong / sub-agent / nhắc kế hoạch / nén ngữ cảnh) qua callback `onEvent`, UI hiện bước hiện tại khi đang chạy và "Các bước Agent đã thực hiện" (thu gọn) dưới mỗi câu trả lời. Nút dừng hủy run: ngừng gọi LLM tiếp **và** hủy request đang bay trong Rust (`agent_http_cancel`). Không còn SSE (không có server ở giữa).
  - **Điểm dừng hỏi lại (`ask_user`)**: khi yêu cầu mơ hồ theo cách làm thay đổi SQL mà metadata/bối cảnh không giải quyết được, Agent dừng vòng lặp và trả một câu hỏi + 2-4 lựa chọn; UI hiện nút trả lời nhanh, câu trả lời đi tiếp như tin nhắn thường (không cần lưu trạng thái run ở server). Không có tool nào chạy SQL nên không cần cổng duyệt thao tác.
  - **Bối cảnh nghiệp vụ theo profile ("Learn context")**: skill `data-context` hướng dẫn Agent chỉ hỏi phần còn thiếu rồi gọi `propose_context_note` (tối đa 5/lượt, chỉ cho sự kiện người dùng đã nêu hoặc OpenMetadata xác nhận). Đề xuất trả về cho UI; **người dùng bấm Lưu mới lưu**, trong workspace mã hóa trên máy, gắn với `profileId` (theo khi gộp profile như tab) và tắt/xóa được. Ghi chú đang bật (tối đa 30/profile, 4000 ký tự/lượt) được gửi theo `dataContext`, server sanitize từng dòng và đặt trong `<<BUSINESS-CONTEXT-nonce>>` ở lượt user đầu — dữ liệu tham khảo, không vào system prompt.
  - **Tóm tắt hội thoại** dùng `plain: true`: một lần gọi LLM, không metadata, không harness.
  - **Test mô tả skill** (`test/skill-triggers.test.ts`): bộ xếp hạng từ vựng offline bảo đảm mô tả mang đúng từ khóa kích hoạt và không skill nào "cướp" yêu cầu của skill khác; không thay thế đánh giá bằng LLM thật.
  - **Chưa làm (bước sau)**: hủy run giữa chừng ở phía LLM (hiện chỉ ngừng gọi lượt tiếp theo); đo chất lượng trigger với LLM thật; trigger tiếng Việt cho skill (mô tả đang bằng tiếng Anh, LLM tự ghép nghĩa).
- **Chống prompt injection**: tên bảng/cột/comment/DDL được (a) chuẩn hóa (bỏ ký tự điều khiển, cắt độ dài, vô hiệu hóa chuỗi dạng chỉ thị & fence), (b) đặt trong khối dữ liệu có ranh giới ngẫu nhiên, system prompt nói rõ "khối này là dữ liệu không phải chỉ thị", (c) đầu ra Agent chỉ là văn bản + SQL đề xuất — chỉ có tool metadata chỉ đọc của OpenMetadata (allow-list, xem trên), không có tool thực thi SQL, nên injection không thể vượt quyền; (d) SQL đề xuất được classifier gắn nhãn read/write/ddl trước khi hiển thị.
- **LLM token**: mỗi user nhập token → app kiểm tra bằng một lời gọi 1-token tới endpoint đã chọn → lưu trong kho credential của OS (Credential Manager / Keychain; WebView chỉ ghi/xóa) → xóa/thu hồi trong panel Agent. Endpoint/model do `config.json` quy định, user chỉ chọn trong danh sách. **[ASSUMPTION: API LLM chưa rõ; chỉ có adapter OpenAI-compatible cấu hình được + mock cho test.]**
- **Editor (desktop)**: Ctrl+Enter chạy câu lệnh tại con trỏ hoặc vùng chọn; nhiều câu → script, **mỗi câu** qua `decideRun` và câu ghi xác nhận riêng (Chạy / Bỏ qua / Dừng). `:tên` → tham số bind (sidecar `PreparedStatement`). Explain qua `query.plan` (không thực thi). Commit thủ công (`tx.*`) chỉ trên kết nối cho phép ghi; ngắt kết nối khi còn thay đổi chưa commit phải chọn Commit/Rollback. Sửa dữ liệu trên lưới (bảng có khóa chính) và import sinh câu lệnh hiển thị cho người dùng duyệt, chạy trong một transaction, audit từng câu như editor.
- **Dữ liệu cục bộ của editor**: nội dung tab SQL, lịch sử câu lệnh và snippet là một tài liệu JSON do lõi Rust mã hóa AES-256-GCM (nonce ngẫu nhiên mỗi lần ghi, MAGIC làm AAD, ghi nguyên tử) vào `<app_data>/workspace.bin`; khóa 256-bit ngẫu nhiên nằm trong Credential Manager dưới tên dành riêng `internal:workspace.key` mà lệnh `secret_*` của WebView không đọc/ghi được. Không ghi vào `localStorage` của WebView (bản đầu tiên ghi `tdb.ws.*` dạng rõ: được chuyển sang file mã hóa rồi xóa). File bị sửa/sai khóa → không đọc được, bắt đầu rỗng. "Xóa mọi dữ liệu editor" xóa file **và** khóa nên bản sao/backup cũ cũng vô dụng. Không có mật khẩu hay dòng kết quả, nhưng SQL có thể chứa literal; người dùng tắt được việc ghi lịch sử / giữ tab. Giới hạn: như mật khẩu DB, không chống malware chạy dưới chính tài khoản Windows của người dùng. Hàng đợi audit vẫn chỉ ở bộ nhớ.
- **Audit**: yêu cầu Agent do desktop báo qua `POST /agent/audit` (metadata manifest, độ dài prompt, model, số lượt LLM/tool và vết `độ sâu:loại:tên:ok|fail`; kèm **câu hỏi/câu trả lời đã redact** (thẻ/email/điện thoại/token → `[REDACTED]`, ≤2000 ký tự) và SQL Agent đề xuất đã che literal; desktop redact trước, server redact/che lại lần nữa; không lưu dòng dữ liệu, ảnh hay token; server bỏ các khóa kiểu prompt/reply/token/sql, giới hạn độ sâu/độ dài, gắn `reportedBy=desktop` vì không kiểm chứng được) và SQL (hash + SQL đã che literal). Che dữ liệu: literal → `?`, pattern (số thẻ, email, số điện thoại, token) → `[REDACTED]`.

## 6. Luồng chuyển file

```
UPLOADING ─complete(idempotency)→ SCANNING(chờ kiểm tra) ─clean→ PENDING_APPROVAL ─leader approve→ APPROVED ─download→ (DOWNLOADED*)
    │                                   │ infected → QUARANTINED                 │ reject → REJECTED
    └ abort → ABORTED                   │ lỗi đọc file → SCANNING + retry         │ ttl → EXPIRED    │ sender cancel/admin → REVOKED
```
`DOWNLOADED*`: trạng thái phản ánh "đã tải ≥1 lần" (cờ `first_downloaded_at` + đếm `download_count`; ticket vẫn tải được đến khi hết `max_downloads`/hết hạn, sau đó `EXPIRED`). `notify_state ∈ {PENDING, SENT, ERROR}` là trục riêng cho email gửi người duyệt ("chưa gửi được email" không làm mất workflow: leader vẫn thấy ticket ở danh sách *Chờ tôi duyệt* trên BO).

- **Chiều chuyển** (`tickets.direction`): server tự gán theo loại phiên của người upload, client không chọn được — phiên desktop → `JUMP_TO_OFFICE`, phiên web → `OFFICE_TO_JUMP`. Chỉ phía đích được tải: `JUMP_TO_OFFICE` chỉ tải trên web, `OFFICE_TO_JUMP` chỉ tải trên desktop (`canDownload(..., clientKind)`, kiểm cả lúc cấp token và lúc tải). Chiều hiển thị ở danh sách, trang duyệt, email và audit (`transfer.create`, `transfer.download`).
- Upload theo phần (part-size cố định, checksum SHA-256 từng phần + toàn file, resume qua `GET /uploads/:id`), giới hạn size/định dạng/magic bytes. Lưu ở vùng cách ly, không có URL công khai.
- `complete` là idempotent (`Idempotency-Key`). Kiểm tra PII/nội dung và email chạy qua **outbox** (ghi cùng transaction với đổi trạng thái), worker retry lũy thừa + jitter, dedupe theo ticket, job chết → `notify_state=ERROR` + audit, admin retry được.
- **Email**: người duyệt nhận thư sau khi bước kiểm tra file hoàn tất (AV bỏ qua) (mã yêu cầu, người gửi, tên file, kích thước, SHA-256, mục đích, link BO); người gửi (và người nhận được chỉ định) nhận thư khi duyệt/từ chối; người gửi nhận thư khi bị cách ly mã độc. Email leader có nút duyệt qua link bearer riêng cho phiếu và approver: dùng một lần, tối đa 24 giờ và không vượt hạn phiếu; không cần phiên SSO. GET chỉ hiển thị trang kết quả, JavaScript gửi POST để duyệt. Secret nằm trong fragment và DB chỉ lưu hash. Server kiểm lại quyền hiện tại, leader được chỉ định, trạng thái và hạn phiếu; đổi leader hoặc quyết định qua BO làm link cũ hết hiệu lực. Audit ghi rõ kênh single_use_email_link. Người có toàn bộ link có khả năng duyệt, nên không chuyển tiếp email. Nội dung được escape HTML, CR/LF bị loại khỏi header. Địa chỉ người nhận lấy từ hồ sơ SSO trong DB, không từ dữ liệu người dùng nhập.
- Tải: endpoint kiểm tra tại thời điểm tải: session hợp lệ + step-up + `ticket.status=APPROVED` + chưa hết hạn + người tải là người gửi hoặc người nhận được chỉ định + không bị REVOKED. Truyền qua backend (stream, giải mã), hoặc token một lần TTL ≤ 60 s. Ghi `downloads` (ai, khi nào, IP, sha256).
- Trường hợp biên: upload OK nhưng SMTP lỗi (ticket vẫn sang chờ duyệt, `notify_state=ERROR`, retry + cảnh báo; người gửi có thể báo trực tiếp); đổi leader (admin, có audit, email gửi cho leader mới); ủy quyền hết hạn/thu hồi; AV bên ngoài không tự cập nhật trạng thái ticket; user mất quyền (kiểm tra role tại thời điểm tải, `users.active=false` chặn). Email không được gửi nếu lúc job chạy ticket không còn ở trạng thái chờ duyệt.

## 7. Mô hình dữ liệu (tóm tắt — DDL ở `services/api/migrations`)

`users`, `role_assignments`, `delegations`, `sessions`, `db_targets` (danh mục admin cho phép), `leaders`, `tickets`, `upload_parts`, `ticket_events`, `approvals` (bất biến), `download_tokens`, `downloads`, `outbox`, `idempotency_keys`, `audit_log` (hash chain, trigger cấm UPDATE/DELETE). Cache metadata nằm ở desktop (theo kết nối, xóa khi `meta.fingerprint` đổi).

## 8. Threat model ngắn gọn (STRIDE trọng yếu)

| # | Đe dọa | Biện pháp | Giới hạn còn lại |
|---|---|---|---|
| T1 | User dùng API trực tiếp để bỏ qua UI | RBAC server-side, kiểm tra ở service | — |
| T2 | Người gửi tự duyệt | Check service + CHECK DB `approver_id <> requester_id` | Leader thông đồng: ngoài phạm vi kỹ thuật; audit + báo cáo |
| T3 | SQL ghi lén qua Agent/nhiều câu lệnh | classifier chống multi-statement, read-only connection, không auto-run | Hàm/procedure có side effect gọi trong SELECT: cần quyền DB tối thiểu (DB là hàng rào cuối) |
| T4 | Prompt injection qua metadata | sanitize + ranh giới dữ liệu + Agent chỉ có tool metadata chỉ đọc (allow-list, giới hạn vòng) | Nội dung Agent vẫn có thể sai → user phải xem SQL |
| T5 | Lộ credential trong log | redaction logger ở cả API/Rust/Java, secret trong Credential Manager | Máy user bị chiếm quyền: ngoài phạm vi |
| T6 | Driver/JAR độc hại | allowlist + checksum + bản phát hành ký | Chuỗi cung ứng upstream: cần SBOM/kiểm duyệt |
| T7 | File độc hại | AV trên server + giới hạn định dạng; ứng dụng bỏ qua AV | Không có kết quả AV cho plaintext upload trong ứng dụng |
| T8 | Replay webhook/complete | HMAC, event dedupe, idempotency key | — |
| T9 | Truy cập file sau khi thu hồi | kiểm tra quyền lúc tải, không URL dài hạn | Người đã tải file rồi: không thu hồi được bản đã tải |
| T10 | Chỉnh sửa audit | hash chain + trigger + đẩy sang kho tập trung | DBA lạm quyền: cần WORM/SIEM ngoài |
| T11 | SSRF qua cấu hình LLM | endpoint chỉ lấy từ cấu hình admin | — |
| T13 | Email giả mạo/phishing giả làm yêu cầu duyệt | thư không có nút duyệt, chỉ link tới BO (cần SSO); SPF/DKIM/DMARC cho `MAIL_FROM` là việc hạ tầng mail | Người dùng vẫn có thể bị lừa mở link giả: cần đào tạo; domain BO cố định |
| T12 | Phiên bị đánh cắp | cookie httpOnly, TTL ngắn, step-up khi tải, rate limit | — |
| T14 | Kết nối tùy chỉnh (`db:custom`): user nhập host/port/SID hoặc Service name, hoặc import JAR driver riêng | Quyền `db:custom` chỉ cấp bằng grant cho người tin cậy; desktop báo về audit `db.custom.*` (kèm cờ vi phạm); JAR import vào thư mục app-data, tính sha256, ghi manifest, sidecar chỉ nạp file đúng checksum; ghi vẫn cần `db:write` + xác nhận từng lệnh | Server không chặn được (SQL chạy từ máy user). JAR tùy ý = chạy code với quyền user trong tiến trình sidecar, nên `db:custom` chỉ cấp cho người tin cậy; hàng rào cuối vẫn là quyền tài khoản DB |
| T15 | SSH tunnel / proxy do người dùng cấu hình: MITM ở bastion, lộ mật khẩu/khóa SSH, dùng tunnel để vòng qua phân vùng mạng | Host key ghim theo vân tay, lần đầu phải xác nhận, khóa đổi → cảnh báo đỏ + xác nhận riêng (không tự chấp nhận); mật khẩu/passphrase chỉ trong Credential Manager, không vào localStorage/file export/log; khóa riêng chỉ đọc theo id từ thư mục app-data (`--ssh-keys`), không bao giờ gửi lên WebView/server; relay chỉ bind loopback, đóng cùng phiên; audit có `route` | Máy user bị chiếm quyền: ngoài phạm vi. Tunnel chỉ đi được nơi tài khoản SSH của user đi được — kiểm soát phân vùng là việc của bastion (`AllowTcpForwarding`, `PermitOpen`, xem `JUMP-POLICY.md`). Tiến trình khác cùng máy có thể dùng relay loopback khi phiên đang mở (vẫn cần tài khoản DB). Qua tunnel, TLS của PG/Oracle không kiểm hostname (vẫn kiểm chuỗi) |

## 9. Giới hạn (phải nói rõ)

- **Desktop**: bảo vệ bí mật ở mức tài khoản Windows của user; không chống được malware chạy cùng quyền user. Kết nối DB trực tiếp từ máy user phụ thuộc mạng.
- **Web BO**: duyệt/tải/quản trị và upload chiều office → jump; không có JDBC, không đọc file hệ thống (upload chỉ đọc file người dùng tự chọn). Người dùng tải file về sẽ nằm trên máy họ ngoài tầm kiểm soát của hệ thống.
- **Jump server**: cài ứng dụng **không** chặn được việc copy từ jump. Cần chính sách hạ tầng riêng (`JUMP-POLICY.md`); ứng dụng chỉ cung cấp luồng thay thế được duyệt.

### Rủi ro kỹ thuật đã biết (từ quá trình triển khai)
- **Chế độ chỉ đọc không được máy chủ bảo đảm trên mọi DB.** PostgreSQL dùng `readOnlyMode`/`setReadOnly`; với **Oracle và Trino chỉ có classifier + quyền của tài khoản DB** là hàng rào (JDBC `setReadOnly` không có hiệu lực cứng). Vì vậy tài khoản DB của người dùng phải được cấp quyền tối thiểu; hàm/procedure có side-effect gọi trong `SELECT` chỉ bị chặn nếu DB không cấp quyền thực thi.
- **Trino SSO dùng `io.trino.jdbc.TestingRedirectHandlerInjector`** để bắt URL đăng nhập và phát sự kiện `auth.openUrl` (lớp public trong trino-jdbc 483 nhưng tên "Testing", có thể bị đổi/xóa ở phiên bản sau). Phiên bản driver được khóa; mỗi lần nâng cấp phải chạy lại kịch bản B1/B2. Phương án dự phòng: để driver tự mở trình duyệt (`Desktop.browse`).
- Phát hiện hết thời gian SSO của Trino JDBC dựa trên thời gian trôi qua (~90% timeout) vì driver không báo lỗi riêng.
- Sidecar xử lý request đồng thời để `query.cancel` chen ngang được; phản hồi có thể đến sai thứ tự → luôn ghép theo `id`.
- Oracle `DBMS_METADATA`, Trino `SHOW CREATE`, proxy Trino và TLS `verify-full` mới được kiểm với driver thật ở mức nạp/URL/thuộc tính, chưa với máy chủ thật.

## 10. Lộ trình

| Giai đoạn | Nội dung | Tiêu chí hoàn thành |
|---|---|---|
| **MVP** | Kết nối PG/Oracle/Trino, duyệt metadata, SQL editor, Agent dùng bảng đang chọn, upload (desktop) → email → duyệt → tải trên web BO | Kịch bản nghiệm thu A1–A12 (`TEST-PLAN.md`) đạt trên môi trường test; test tự động xanh |
| P2 | Trino SSO đầy đủ qua proxy thực tế, nhắc duyệt (reminder) và leo thang khi quá hạn, ủy quyền leader | Kịch bản B1–B8 |
| P3 | Agent mở rộng (bảng liên quan), streaming kết quả lớn, S3+KMS prod, thông báo | Kịch bản C1–C5 |
| P4 | Đóng gói driver ký số/tự cập nhật driver, SIEM, DLP tích hợp, báo cáo | Kiểm toán bảo mật đạt |
