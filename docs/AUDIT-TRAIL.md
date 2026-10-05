# Dấu vết kiểm toán (audit trail) cho chuyển file

Mục tiêu: truy được **AI** tải lên, **bao nhiêu**, **nội dung là gì** (chỉ metadata), **khi nào / từ đâu**, **ai duyệt**, **ai tải** — và chứng minh được nhật ký không bị sửa. Mã nguồn: `services/api/internal/{inspect,audit,tickets,logsink,diskguard}`.

## 1. Nguyên tắc
* **Chỉ metadata.** Không lưu nội dung file, không lưu giá trị ô/trường. Mẫu nhạy cảm chỉ được **đếm** (SĐT VN, email, số 9/12 chữ số kiểu CMND/CCCD, số thẻ 13–19 chữ số qua Luhn); tên cột CSV là tên (cắt 64 ký tự, tối đa 64 cột).
* **`audit_log` vẫn append-only + hash-chain** (trigger cấm UPDATE/DELETE/TRUNCATE; định dạng băm không đổi). Chỉ **thêm** action/khóa mới; tên action cũ không đổi.
* **Manifest bất biến.** Bảng `ticket_manifests` + `ticket_manifest_entries` (migration `007`) cũng có trigger cấm sửa/xóa. Danh sách đầy đủ nằm trong bảng này; chuỗi audit chỉ chứa `manifestHash` (= SHA-256 của JSON chuẩn tắc `{summary, entries}`) và số entry ⇒ đổi một entry là lệch hash (`GET /transfers/:id/manifest?verify=1` → `hashVerified`).
* **Tên do người dùng đặt** (tên file, tên entry trong zip, tên cột, User-Agent, chữ ký virus) luôn được làm sạch trước khi ghi/gửi mail/hiển thị: bỏ ký tự điều khiển (CR/LF/NUL), ký tự đảo chiều (RLO…), thay UTF-8 hỏng, cắt độ dài. Web hiển thị dạng text (không HTML).
* **Không bí mật.** Khóa nhạy cảm (`password`, `token`, `cookie`, `authorization`, `csrf…`) → `[REDACTED]`; Bearer/JWT trong mọi chuỗi bị che. Session chỉ được tham chiếu bằng `sessionRef` (12 ký tự đầu của hash đã lưu), không bao giờ là token/cookie/CSRF. Text tự do (lý do, mục đích) còn bị che email/SĐT/thẻ; chỉ các khóa danh tính/tập tin (`requester`, `approver`, `recipients`, `fileName`, `userAgent`, …) được giữ nguyên email để biết *ai*.
* **`actor_label` giữ email** của người thao tác (trước đây bị che thành `[REDACTED:email]` nên không truy được người làm). Dòng cũ không đổi (không thể sửa chuỗi băm).

## 2. Trường chung của mọi bản ghi `audit_log`
Cột: `seq, at, actor_id, actor_label, action, resource_type, resource_id, ip, detail, prev_hash, hash`. Ngoài ra mỗi bản ghi tạo trong một request HTTP tự động có trong `detail` (không ghi đè khóa đã có):

| Khóa | Ý nghĩa |
|---|---|
| `requestId` | `X-Request-ID` (cũng nằm trong log ứng dụng) |
| `userAgent` | đã làm sạch, ≤ 200 ký tự |
| `xForwardedFor` | chuỗi XFF — **chỉ khi `TRUST_PROXY=1`** (ngược lại là dữ liệu do kẻ tấn công điều khiển) |
| `sessionRef` | tiền tố hash phiên (không phải token) |
| `clientKind` | `web` \| `desktop` |
| cột `ip` | IP client (trái nhất của XFF nếu `TRUST_PROXY=1`, ngược lại IP socket) |

Bản ghi về một ticket (`resource_type=ticket`, `resource_id`=id) có thêm: `ticketId, code, direction, fileName, declaredSize, sha256, purpose, requester{id,email,name}, approver{id,email,name}` (tại thời điểm đó), `recipients[]` (email), `clientKind`.

## 3. Danh mục action
| Action | Khi nào | Trường bổ sung |
|---|---|---|
| `transfer.create` | tạo ticket | `size`, `sha256`, `approverId`, `partBytes`, `totalParts`, `maxDownloads`, `ticketTtlHours` |
| `transfer.upload_started` | part đầu tiên được nhận (1 lần) | `partBytes`, `totalParts` |
| `transfer.upload_complete` | hoàn tất upload (cả "batch" các part = **một** bản ghi; tương đương `transfer.upload.completed` trong đặc tả) | `size`, `actualSize`, `sha256Verified`, `parts`, `uploadStartedAt`, `uploadCompletedAt`, `uploadDurationMs`, `throughputBps` |
| `transfer.abort` | người gửi hủy | `fromStatus`, `partsReceived`, thời gian upload |
| `transfer.scan_skipped` | bỏ qua AV (`reason=av_disabled`; hoặc ZIP mã hóa) | `engine`, `result`, `reason`, `ms`, `scannedAt`, `approvalExpiresAt` |
| `transfer.scan_clean` | kết quả sạch từ adapter cũ (không dùng trong production) | `engine`, `result`, `ms`, `scannedAt`, `approvalExpiresAt` |
| `transfer.quarantine` | clamd/rescan thấy mã độc | `signature`, `engine`, `result`, `ms`, `late` (rescan) |
| `transfer.scan_error` | scanner lỗi (chỉ lần thử đầu) | `engine`, `reason`, `attempt`, `maxAttempts`, `ms` |
| `transfer.scan_failed` | job scan chết (hết lượt thử) | `attempts`, `reason` |
| `transfer.inspected` | sau scan (cả sạch và nhiễm), kể cả khi inspect lỗi | `status` (`ok`/`error`), `inspectError`, `manifestHash`, `entryCount`, `detectedType`, `label`, `declaredExt`, `typeMismatch`, `mismatchNote`, `executable`, `containsExecutable`, `containsSensitivePatterns`, `sensitive{phone,email,idNumber,card}`, `truncated`, `truncatedReason`, `parseError`, `actualSize`, `text{encoding,lines,bytes,csv{delimiter,columns,dataRows,raggedRows},json{valid,topLevel,length},jsonl{validLines,invalidLines}}`, `zip{entryCount,fileCount,dirCount,totalCompressed,totalUncompressed,encryptedCount,zipSlipCount,nestedArchiveCount,maxRatio,inspectedEntries}`, `entries[]` **chỉ khi ≤ 50 entry** |
| `transfer.approve` / `transfer.reject` | quyết định | `decision`, `reason`, `decidedBy{…}`, `decidedAt`, `onBehalfOf` (id) + `onBehalfOfUser{…}` (ủy quyền), `fromStatus`, `scanResult`, `sha256` |
| `transfer.revoke` | thu hồi | `reason`, `fromStatus`, `downloadCount`, `remainingDownloads`, `revokedBy{…}` |
| `transfer.change_approver` | đổi người duyệt | `from`, `to`, `fromApprover{…}`, `toApprover{…}`, `changedBy{…}` |
| `transfer.expire` | hết hạn (sweeper) | `from`, `reason` (`ttl`\|`upload-abandoned`), `expiresAt`, `downloadCount` |
| `transfer.download_token` | cấp token tải (**không** ghi token) | `tokenTtlSec`, `downloadCount`, `remainingDownloads`, `requestedBy{…}`, `client` |
| `transfer.download` | bắt đầu tải | `bytes`, `sha256`, `client`, `downloadCount`, `remainingDownloads`, `downloadedBy{…}` |
| `transfer.download_completed` / `transfer.download_failed` | kết thúc tải | `bytesSent`, `expectedBytes`, `sentSha256`, `shaMatched`, `durationMs`, `error` |
| `storage.purge` | xóa ciphertext (job purge hoặc `disk-pressure`) | `reason` (`terminal-status`\|`disk-pressure`), `status`, `parts`, `bytes` |
| `storage.pressure` | đĩa đầy / đã dọn / hồi phục (`resource_type=storage`) | `state` (`blocked`\|`cleaned`\|`recovered`), `usedPct`, `limitPct`, `actions[]`, `availBytes`, `totalBytes` |
| `notify.approval_sent`, `notify.dead` | email | `to`, `notified{…}` / `job` |
| `delegation.create` / `delegation.revoke` | ủy quyền | `delegator{…}`, `delegate{…}`, `validFrom`, `validTo`, `delegationId` |
| `auth.login`, `auth.logout`, `auth.login_failed`, `auth.stepup`, `user.provisioned` | phiên | `provider`/`via`/`kind`, `reason` (login_failed) + trường chung §2 |
| `audit.export` | xuất audit (`resource_type=audit`) | `format`, `minSeq`, `maxSeq`, `from`, `to` |
| `db.*`, `agent.*` | desktop báo cáo | không đổi |

## 4. API truy vết
* `GET /transfers/:id` — thêm `uploader`, `upload{startedAt,completedAt,durationMs,parts,throughputBps,clientKind}` (+ `clientIp`, `userAgent` **chỉ với `audit:read`**), `fileType`, `scan`, `manifest` (tóm tắt + trang đầu danh sách entry). Thấy được: người gửi, người duyệt, người được ủy quyền đang hiệu lực, `audit:read`. Người nhận thuần không thấy manifest.
* `GET /transfers/:id/manifest?offset=&limit=(≤500)&verify=1` — phân trang entry (zip lớn) và kiểm hash.
* `GET /transfers/:id/trace` — dòng thời gian mọi bản ghi audit của ticket (`audit:read`, hoặc người gửi/duyệt/ủy quyền; với người không phải auditor, trường mạng — `ip`, `userAgent`, `xForwardedFor`, `sessionRef`, `requestId` — bị bỏ và `redacted:true`).
* `GET /audit?actor=&actorEmail=|q=&action=&resourceId=&ticket=<mã>&from=&to=&limit=&before=` — kết quả có thêm `prevHash`, `hash`.
* `GET /audit/export?from=&to=&format=csv|jsonl` — streaming, chính nó được audit (`audit.export`); lấy một **đoạn liên tiếp theo `seq`** (cửa sổ thời gian được đổi sang `seq` vì `at` không đơn điệu tuyệt đối). JSONL xác minh offline: `go run ./cmd/auditverify file.jsonl` (hoặc `auditverify.exe`) tính lại từng hash, kiểm `prevHash` và `seq` liên tục; xuất một phần được neo bằng `anchorPrevHash`. CSV là bản dễ đọc: ô bắt đầu bằng `= + - @` được thêm `'` phía trước (chống formula injection) nên **dùng JSONL để xác minh**.
* `GET /audit/verify` — kiểm chuỗi trong DB; khi `ok` ghi marker cho janitor (§5).

## 5. Lưu giữ & dọn dẹp
* **DB là nguồn sự thật.** `LOG_DIR/audit.jsonl` (+ các mảnh xoay vòng `audit-<ts>.jsonl.gz`) chỉ là **bản sao** để lưu/đối chiếu ngoài DB; mỗi dòng là cả bản ghi kèm `seq/prevHash/hash` nên tự xác minh được. Sink đọc từ bảng (chỉ dòng đã commit) nên không có dòng "ma" của transaction bị rollback và tự bắt kịp sau khi restart.
* Khi đĩa ≥ `DISK_MAX_USED_PCT`, janitor dọn theo thứ tự và dừng khi < giới hạn − 2: (1) mảnh log ứng dụng cũ nhất; (2) ciphertext của ticket đã kết thúc (`storage.purge`, `reason=disk-pressure`); (3) mảnh **bản sao** audit cũ nhất, **chỉ khi** tuổi ≥ `AUDIT_FILE_MIN_RETAIN_DAYS` (90) **và** đã có `/audit/verify` thành công hoặc xuất đầy đủ `/audit/export` **sau** khi mảnh đó đóng (marker `LOG_DIR/audit.verified.json`); (4) không bao giờ xóa dữ liệu sống, DB, file log đang ghi. Vẫn quá giới hạn ⇒ trạng thái `blocked`: `POST /transfers` và upload part trả **507 `INSUFFICIENT_STORAGE`**, ghi `storage.pressure` + log WARN, `/healthz` & `/readyz` có `disk{usedPct,limitPct,state}`.
* Xoay vòng: `app.log` và `audit.jsonl` xoay khi đạt `LOG_MAX_SIZE_MB` và mỗi nửa đêm (giờ máy), nén gzip; `LOG_MAX_AGE_DAYS`/`LOG_MAX_BACKUPS` chỉ áp cho `app.log`. Mảnh audit chỉ bị xóa bởi janitor theo luật trên.
