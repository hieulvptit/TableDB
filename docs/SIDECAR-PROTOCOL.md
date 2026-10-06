# JDBC sidecar / service protocol v1

Một JAR (`services/jdbc`), hai transport, cùng message:

- `--stdio`: mỗi dòng là một JSON UTF-8 (NDJSON). Request từ parent→stdin, response/event từ stdout. **stdout chỉ chứa NDJSON**; log ra stderr (đã redact). Tối đa 8 MiB/dòng.
- Tham số khởi động tùy chọn `--custom-drivers <dir>`: thư mục driver do người dùng import (app-data), do desktop truyền khi spawn — **không bao giờ lấy từ request**. Không có tham số này thì không có driver `custom`.
- Rust core chỉ chuyển tiếp các method trong allowlist (`ALLOWED_METHODS`, `apps/desktop/src-tauri/src/sidecar.rs`): hello, session.*, meta.*, query.execute/fetch/cancel/closeCursor/plan, session.setSchema, tx.setAutoCommit/commit/rollback, diag.proxy.
- Tham số khởi động tùy chọn `--ssh-keys <dir>`: thư mục khóa riêng SSH do desktop import (app-data, file `<id>.key`); request chỉ mang `keyId`, **không bao giờ mang đường dẫn hay nội dung khóa**.
- `--http --bind 127.0.0.1 --port N`: `POST /rpc` body = một request, trả response; `GET /events?after=<seq>&wait=25` long-poll trả `{events:[{seq,...}]}`. Bắt buộc header `Authorization: Bearer <service token>` (env `JDBC_SERVICE_TOKEN`, so sánh constant-time). Bind mặc định loopback; mTLS/TLS do reverse proxy hoặc `--tls-keystore`.

## Khung message

```json
// request
{"id": 12, "method": "query.execute", "params": {...}}
// response OK / lỗi
{"id": 12, "result": {...}}
{"id": 12, "error": {"code": "E_SQL", "message": "…", "sqlState": "42P01", "vendorCode": 0, "retryable": false}}
// event (không có id)
{"event": "auth.openUrl", "seq": 3, "data": {"sessionId": "s1", "url": "https://…", "purpose": "trino-sso"}}
```
Khi khởi động stdio: in `{"event":"ready","seq":0,"data":{"protocol":1,"version":"…","drivers":[{"type":"postgresql","version":"42.7.x","sha256":"…","loaded":true}, {"type":"custom","id":"my-mysql","name":"MySQL","version":"8.4","className":"com.mysql.cj.jdbc.Driver","urlTemplate":"jdbc:mysql://{host}:{port}/{database}","defaultPort":3306,"files":[{"file":"mysql.jar","sha256":"…"}],"loaded":true}]}}`. Driver custom lỗi có `loaded:false` và `error`.

Mã lỗi: `E_BAD_REQUEST`, `E_DRIVER_UNAVAILABLE` (thiếu/sai checksum), `E_AUTH_FAILED`, `E_AUTH_INTERACTIVE_TIMEOUT`, `E_CONN`, `E_TIMEOUT`, `E_CANCELLED`, `E_READONLY_VIOLATION`, `E_POLICY`, `E_SQL`, `E_LIMIT`, `E_NOT_FOUND`, `E_INTERNAL`, `E_SSH_HOSTKEY` (khóa máy chủ SSH chưa xác nhận/đã đổi — có `details`), `E_SSH_AUTH` (xác thực SSH hỏng — `details.reason`: `auth`\|`passphrase`), `E_PROXY_AUTH` (proxy từ chối xác thực). Message không bao giờ chứa password/token/passphrase. Lỗi có thể kèm `details` (object, không chứa bí mật).

## Phương thức

### `hello` → `{protocol:1, version, drivers:[…]}`

### `session.open`
```json
{"profile": {
  "driver": "postgresql" | "oracle" | "trino" | "custom",
  "driverId": "my-mysql",       // BẮT BUỘC khi driver="custom" (id trong custom manifest), cấm với driver khác
  "host": "db.internal", "port": 5432,
  "database": "app",            // PG: database; Oracle: service name hoặc SID (theo options.connectType); Trino: catalog (tùy chọn); custom: thay {database}
  "schema": "public",           // tùy chọn
  "auth": {"type":"password","username":"u","password":"p"}      // PG/Oracle/Trino(password)
        | {"type":"trino-external"}                              // Trino SSO (externalAuthentication)
        | {"type":"trino-jwt","token":"…"},
  "options": {
    "ssl": true, "readOnly": true, "allowWrite": false,
    "connectTimeoutSec": 15,
    "proxy": {"type":"http"|"socks","host":"proxy","port":8080, "username":"u?", "password":"p?"},  // tới DB (không có ssh) hoặc tới máy SSH đầu tiên
    "externalAuthTimeoutSec": 180,
    "connectType": "serviceName" | "sid",     // chỉ Oracle, mặc định serviceName; driver khác → E_BAD_REQUEST
    "props": {"oracle.jdbc.ReadTimeout": "5000"}  // thuộc tính driver bổ sung (mọi driver)
  },
  "ssh": {                        // tùy chọn: SSH tunnel qua 1..4 máy (bastion/jump), máy cuối forward tới host:port
    "keepAliveSec": 30,           // 0..600, 0 = tắt
    "hops": [{"host":"bastion","port":22,"username":"ops",
              "auth": {"type":"password","password":"…"} | {"type":"publicKey","keyId":"k0123…","passphrase":"…?"},
              "hostKey": "SHA256:<43 ký tự base64>"}]   // vân tay đã tin cậy; thiếu = hỏi (E_SSH_HOSTKEY)
  }}}
```
→ `{sessionId, serverVersion, user, readOnly, schema, autoCommit:true}` (`schema` = `Connection.getSchema()`, có thể null). Chỉ các key `options` trong allowlist được chấp nhận (khác → `E_BAD_REQUEST`); không có tham số JDBC URL tùy ý, không có đường dẫn driver.
- **Oracle**: `connectType:"serviceName"` → `jdbc:oracle:thin:@[tcps:]//host:port/service`; `"sid"` → `jdbc:oracle:thin:@host:port:SID` (khi `ssl` hoặc host IPv6 dùng dạng `(DESCRIPTION=(ADDRESS=(PROTOCOL=tcp|tcps)(HOST=…)(PORT=…))(CONNECT_DATA=(SID=…)))`). `database` bắt buộc ở cả hai dạng.
- **`options.props`**: tối đa 20 mục; key `^[A-Za-z][A-Za-z0-9_.$-]{0,79}$`; value chuỗi ≤ 512 ký tự, không NUL. Cấm (không phân biệt hoa thường): `user`, `password`, mọi key bắt đầu `javax.net.ssl.` hoặc `java.`, `oracle.net.wallet_location`, `oracle.jdbc.libraryPath`. Áp qua `Properties`; thuộc tính do vendor đặt (vd. PG `readOnlyMode`) **luôn thắng**, props chỉ bổ sung. Value được coi là bí mật khi redact log/lỗi.
- **Driver `custom`**: cổng vào là `driverId` (id trong custom manifest). URL = `urlTemplate` của manifest, chỉ thay `{host}`, `{port}`, `{database}` bằng giá trị đã validate; `user`/`password` qua `Properties`. `port` mặc định = `defaultPort` của manifest, nếu không có thì bắt buộc. Driver thiếu/không nạp được → `E_DRIVER_UNAVAILABLE`. DDL được synthesize.
- `readOnly` mặc định `true`. `allowWrite=true` chỉ có nghĩa là *cho phép* `mode:"write"` khi request có `confirmWrite:true`.
- Trino SSO: thêm `externalAuthentication=true`, `externalAuthenticationTimeout`, redirect handler phát event `auth.openUrl`; khi token hết hạn, JDBC gọi lại handler → event lần nữa. Nếu quá timeout → `E_AUTH_INTERACTIVE_TIMEOUT`.

### Tunnel (SSH / proxy)
- Có `ssh`, hoặc có `proxy` với driver khác Trino (hoặc proxy có tài khoản) → sidecar mở một **relay loopback** `127.0.0.1:<cổng ngẫu nhiên>` sống đúng bằng phiên; URL JDBC dùng địa chỉ này. Mỗi kết nối vào relay được chuyển: qua proxy (HTTP CONNECT / SOCKS5 RFC 1928/1929, tên đích gửi nguyên văn để proxy phân giải) hoặc qua kênh `direct-tcpip` của máy SSH cuối. Máy SSH thứ *n+1* được tới qua `direct-tcpip` của máy *n* (như OpenSSH ProxyJump); máy đầu tiên đi qua `proxy` nếu có. Trino + proxy không tài khoản vẫn dùng `httpProxy`/`socksProxy` của driver (giữ kiểm tra hostname TLS).
- **Host key**: mỗi hop ghim theo vân tay SHA-256 (dạng OpenSSH). Chưa có → `E_SSH_HOSTKEY` `details:{hop, host, port, keyType, fingerprint, reason:"unknown"}`; khác → cùng mã với `reason:"mismatch"`, `expected`. Client hiển thị để người dùng xác nhận rồi gửi lại với `hostKey`. Không bao giờ tự chấp nhận.
- Xác thực: `password` (cả keyboard-interactive một prompt ẩn, chỉ trả lời một lần; OTP/nhiều prompt bị từ chối) hoặc `publicKey` (OpenSSH, PEM, PuTTY .ppk; khóa mã hóa cần `passphrase`). Không có SSH agent, không GSSAPI.
- TLS qua tunnel: host URL là `127.0.0.1` nên PG dùng `sslmode=verify-ca` (vẫn kiểm chuỗi chứng chỉ), Oracle `oracle.net.ssl_server_dn_match=false`, Trino `hostnameInCertificate=<host thật>`.
- Lỗi mạng trên đường đi được báo theo chặng (`E_CONN` "SSH hop 2 (ops@jump:22): …", "SSH server … could not open a connection to db:5432 (port forwarding disabled…)", "proxy …"). Đóng phiên / `session.test` xong / lỗi mở phiên → đóng relay và mọi phiên SSH.
- Giới hạn: Oracle RAC/SCAN redirect tới node khác không đi qua tunnel được (kết nối thẳng service của node); relay loopback có thể được tiến trình khác cùng máy dùng trong lúc phiên mở (vẫn cần tài khoản DB); mất SSH giữa chừng → truy vấn lỗi `E_CONN`, cần kết nối lại.

### `drivers.reload` `{}` → `{drivers:[…]}`
Đọc lại custom manifest (driver mới import hiện ra, driver bị xóa biến mất). Session đang mở giữ nguyên driver của nó. Không nhận tham số nào.

### `session.test` — cùng params như open; mở, đo latency, đóng → `{ok:true, latencyMs, serverVersion, user}`
### `session.close` `{sessionId}` → `{}` (transaction thủ công còn mở bị **rollback**, không bao giờ commit ngầm — Oracle mặc định commit khi đóng)
### `session.setSchema` `{sessionId, schema}` → `{schema}` — `Connection.setSchema` (Oracle `CURRENT_SCHEMA`, PG `search_path`, Trino schema phía client). Không phải lệnh ghi, không qua classifier.

### Transaction thủ công
- `tx.setAutoCommit` `{sessionId, autoCommit:bool}` → `{autoCommit, txPending}`. Bật thủ công chỉ được trên phiên `allowWrite` (khác → `E_POLICY`). Bật lại tự động khi còn thay đổi chưa commit → `E_POLICY` (JDBC sẽ commit ngầm).
- `tx.commit` / `tx.rollback` `{sessionId}` → `{autoCommit, txPending:false}`; ở chế độ tự động → `E_POLICY`.
- Ở chế độ thủ công, lệnh `mode:"write"` đầu tiên của transaction kết thúc transaction chỉ-đọc đang mở (rollback — chưa có thay đổi nào) rồi chuyển kết nối sang read-write cho tới commit/rollback; lệnh `mode:"read"` vẫn qua classifier như cũ. `txPending` = đã có lệnh ghi/DDL/khác từ lần commit/rollback trước (kể cả lệnh lỗi, vì có thể đã ghi một phần). Oracle: DDL tự commit phía máy chủ.
### `session.closeAll` `{}` → `{closed}` — đóng mọi session (SPA gọi khi webview khởi động: sidecar sống qua reload, các session cũ đã mồ côi)

### Metadata (chỉ thấy những gì tài khoản của session thấy được — dùng `DatabaseMetaData` của chính session, không có tài khoản phụ)
- `meta.catalogs` `{sessionId}` → `{catalogs:[string]}` (PG: database hiện tại; Oracle: rỗng, dùng schema)
- `meta.schemas` `{sessionId, catalog?}` → `{schemas:[string]}`
- `meta.tables` `{sessionId, catalog?, schema, types?:["TABLE","VIEW"]}` → `{tables:[{name,type,remarks}]}`
- `meta.columns` `{sessionId, catalog?, schema, table}` → `{columns:[{name,typeName,jdbcType,size,scale,nullable,position,remarks,default}], primaryKey:[name], foreignKeys:[{columns:[..],refCatalog,refSchema,refTable,refColumns:[..],name}]}`
- `meta.ddl` `{sessionId, catalog?, schema, table}` → `{ddl:string, source:"native"|"synthesized"}` (PG: dựng từ columns+PK+FK; Oracle: `DBMS_METADATA.GET_DDL` nếu được phép, nếu lỗi quyền thì synthesize; Trino: `SHOW CREATE TABLE`/`SHOW CREATE VIEW`.) Lỗi quyền → `E_POLICY` không fallback sang tài khoản khác.
- `meta.fingerprint` `{sessionId, catalog?, schema}` → `{fingerprint: sha256 hex}` của danh sách bảng+cột (để cache agent invalidate).

### Query
- `query.execute` `{sessionId, queryId, sql, mode:"read"|"write", confirmWrite?:bool, maxRows?:int (mặc định 1000, trần 100000), timeoutSec?:int (mặc định 60, trần 600), pageSize?:int (mặc định 500), params?:[{type, value?}], serverOutput?:bool, lobLimit?:int}`
  - `params`: giá trị cho placeholder `?` theo vị trí (`PreparedStatement`), tối đa 200, tổng ≤ 1 MB; `type` ∈ `string|number|boolean|date|timestamp|null` (sai định dạng → `E_BAD_REQUEST`). Giá trị không bao giờ ghép vào SQL và không được log; classifier chạy trên SQL có `?` nên tham số không đổi được loại câu lệnh. SPA chuyển `:tên` → `?`.
  - `serverOutput` (Oracle): `DBMS_OUTPUT.ENABLE` trước, đọc `GET_LINE` sau (≤ 5000 dòng / 512 KB) → `serverOutput:[string]`.
  - `lobLimit`: trần mỗi giá trị cho BLOB/binary (byte) thay cho 256 B xem trước, và CLOB (ký tự = max(1M, lobLimit/2)); tối đa 3 MiB.
  - Từ chối nhiều câu lệnh; classifier (`packages/shared/testdata/sql-classify.json` là bộ test dùng chung TS/Java). `mode:"read"` + SQL không phải read → `E_READONLY_VIOLATION`. `mode:"write"` cần session `allowWrite` và `confirmWrite:true`, nếu không → `E_POLICY`.
  - → `{queryId, kind:"read"|"write"|"ddl", columns:[{name,typeName,jdbcType}], rows:[[…]], hasMore, cursorId?, rowCount?, updateCount?, truncated:bool, elapsedMs, autoCommit, txPending, messages?:[string], serverOutput?:[string], moreResults?:[{columns, rows, truncated?, updateCount?}]}`
  - `messages`: chuỗi `SQLWarning` (PostgreSQL `RAISE NOTICE`…), ≤ 200 × 2000 ký tự.
  - `moreResults`: các kết quả tiếp theo của cùng câu lệnh (gọi procedure, Oracle implicit result `DBMS_SQL.RETURN_RESULT`), đọc ngay (≤ 16 kết quả, ≤ 1000 dòng/kết quả, ngân sách JSON cộng dồn với kết quả đầu ≤ 4 MiB; vượt ngân sách trả `E_LIMIT`) — chỉ khi kết quả đầu đã trả hết (nếu còn `cursorId` thì các kết quả sau bị bỏ qua vì đi tiếp sẽ đóng result set đầu).
  - Giá trị: number an toàn → JSON number; BIGINT/DECIMAL → chuỗi; TIMESTAMP/DATE/TIME → ISO-8601 chuỗi; BLOB/binary → `{"$binary":"<base64 tối đa 256 byte>","length":n}`; NULL → null.
- `query.fetch` `{cursorId, count?}` → `{rows, hasMore, truncated}` (tổng số dòng vẫn bị `maxRows` chặn). Watchdog huỷ sau 105 giây; lỗi/huỷ fetch đóng cursor. Mỗi page ≤ 4 MiB JSON UTF-8 thực tế (kể cả escaping); row chưa vừa page được giữ sang page kế tiếp. Một row quá lớn trả `E_LIMIT` và đóng cursor.
- `query.cancel` `{queryId}` hoặc `{cursorId}` → `{cancelled:bool}` (gọi `Statement.cancel()` cho execute hoặc fetch đang chạy; kết quả đang chờ trả `E_CANCELLED`).
- `query.closeCursor` `{cursorId}`.
- `query.plan` `{sessionId, sql, timeoutSec?}` → `{format:"json", plan}` (PG `EXPLAIN (FORMAT JSON, VERBOSE)`) | `{format:"table", columns, rows}` (Oracle `EXPLAIN PLAN SET STATEMENT_ID=<ngẫu nhiên> FOR …` rồi đọc `PLAN_TABLE` — GTT riêng của phiên) | `{format:"text", text}` (Trino `EXPLAIN (TYPE DISTRIBUTED)`, driver khác `EXPLAIN`); kèm `elapsedMs`. Câu lệnh **không bao giờ được thực thi** (không có ANALYZE). Chỉ nhận một câu truy vấn đọc, hoặc DML khi engine chỉ lập kế hoạch cho DML (PG/Oracle/Trino; driver custom: chỉ câu đọc); DDL/khác/nhiều câu/`EXPLAIN …` lồng → `E_BAD_REQUEST`.

### Diagnostics
- `diag.proxy` `{host, port, proxy?}` → `{reachable, latencyMs, error?}` (TCP connect qua proxy cấu hình, `proxy` như `options.proxy` kể cả tài khoản; dùng khi chẩn đoán từng chặng).

## Ràng buộc bảo mật bắt buộc
1. Driver built-in chỉ nạp từ thư mục `drivers/` cạnh JAR theo `manifest.json` (`{type, file, sha256, version, class}`); sai checksum → không nạp. Entry `type:"custom"` trong manifest này bị bỏ qua. Không nhận đường dẫn từ request.
2. Không log: password, token, giá trị hàng, SQL đầy đủ (chỉ hash + 200 ký tự đầu đã che literal ở mức DEBUG).
3. Mỗi session một `Connection`; idle timeout (mặc định 30 phút) tự đóng; tối đa `N` session/cursor.
4. Driver type built-in chỉ là 3 loại; thêm `custom` là các driver người dùng import, chỉ nạp từ thư mục app-data truyền qua `--custom-drivers`, mô tả bằng `manifest.json` do desktop ghi: `{"drivers":[{"type":"custom","id","name","version?","class","urlTemplate","defaultPort?","files":[{"file","sha256"},…]}]}`. Mọi jar của một entry nạp chung một `URLClassLoader` (parent = platform loader) từ bản sao riêng đã kiểm sha256; tên file phẳng `*.jar`, không symlink; `class` phải là `java.sql.Driver`; `id` khớp `IDENT`, không trùng tên driver built-in, id trùng thì bỏ entry sau; `urlTemplate` bắt đầu `jdbc:`, không ký tự trắng/điều khiển, chỉ placeholder `{host}` `{port}` `{database}`. Request vẫn không mang URL JDBC hay đường dẫn driver. `host` không được chứa ký tự `/?;=` (chống chèn tham số URL).

String request `id` tối đa 256 ký tự; id quá dài trả `E_BAD_REQUEST` với `id:null` trước khi chạy thao tác. Envelope hoàn chỉnh phải dưới 8 MiB; nếu quá lớn, cursor vừa chuyển giao được đóng và trả `E_LIMIT`. Desktop tính deadline từ khi bắt đầu gửi RPC; ghi NDJSON bị gián đoạn làm sidecar hiện tại bị kết thúc để không tái sử dụng frame dở.
