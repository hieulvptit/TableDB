# Chính sách hạ tầng: cấm copy file từ jump server

**Giới hạn phải nói rõ:** việc cài ứng dụng TableDB/SecureTransfer **không** chặn được copy từ jump. Ứng dụng chỉ cung cấp *đường thay thế được phê duyệt* (upload → duyệt → tải trên BO). Chặn phải do cấu hình hạ tầng jump/PAM/mạng. Tài liệu này là đề xuất cho đội hạ tầng; mọi biện pháp cần kiểm chứng trên sản phẩm jump/PAM thực tế của VNPAY (chưa biết).

## 1. Khảo sát hiện trạng (làm trước)
Với mỗi jump server, ghi nhận kênh nào đang bật:

| Kênh | Cách kiểm tra | Ai sở hữu |
|---|---|---|
| SCP/SFTP (SSH subsystem `sftp`, `scp`) | `sshd_config`: `Subsystem sftp`, `AllowTcpForwarding`, PAM policy | Hạ tầng Linux |
| SSH port-forwarding / `-R`, `-L`, ProxyJump tới máy đích | `AllowTcpForwarding`, `PermitOpen`, `GatewayPorts` | Hạ tầng |
| Clipboard RDP/VNC (`redirectclipboard`) | GPO "Do not allow Clipboard redirection", thuộc tính RDP | Windows/GPO |
| Drive mapping RDP (`redirectdrives`), USB/COM/Printer redirect | GPO "Do not allow drive redirection" | Windows/GPO |
| Tải qua trình duyệt trên jump (HTTP/S ra Internet/nội bộ, upload webmail/cloud drive) | Proxy/firewall egress, allowlist domain | Mạng |
| Công cụ trong phiên (rz/sz, xmodem, base64 qua terminal, `curl/wget` ra ngoài) | AppArmor/SELinux, allowlist lệnh, egress firewall | Hạ tầng |
| Kênh của sản phẩm PAM (file transfer, session recording) | console PAM | Bảo mật |
| Remote khác: AnyDesk/TeamViewer, RDP gateway, VDI | quét phần mềm, chặn domain/port | Bảo mật |
| Đường mạng: jump → các máy đích cho phép SMB/NFS/FTP | rule firewall | Mạng |

## 2. Biện pháp đề xuất (theo kênh)
1. **SCP/SFTP**: tắt subsystem sftp cho nhóm người dùng jump (`Match Group jumpusers` → `ForceCommand`/`Subsystem` không có; `ChrootDirectory` nếu cần); chặn `scp` phía đích (shell hạn chế). Nếu PAM có proxy SSH: tắt tính năng file transfer theo policy.
2. **Port forwarding**: `AllowTcpForwarding no`, `PermitTunnel no`, `X11Forwarding no`, `GatewayPorts no`.
3. **Clipboard & drive**: GPO/RDP gateway: tắt clipboard redirection, drive/USB/printer redirection cho phiên jump; trong PAM đặt policy per-account.
4. **Trình duyệt/HTTP egress**: chặn Internet trực tiếp từ jump; qua proxy allowlist (chỉ các đích cần thiết); chặn upload lên dịch vụ ngoài; **cho phép** truy cập BO (`https://<bo>`) từ máy làm việc, không từ jump.
5. **Kênh lệnh trong phiên**: chặn `rz/sz`, terminal file transfer của client SSH; giám sát `base64`/dump lớn (phát hiện, không chặn tuyệt đối); egress firewall mặc định deny từ jump.
6. **Ghi phiên (session recording) + cảnh báo**: bật ghi phiên và lưu tập trung; cảnh báo khi phát hiện truyền file/lệnh đáng ngờ.
7. **Nhóm đích**: các máy đích sản xuất chỉ nhận kết nối quản trị từ jump; luồng dữ liệu vào/ra máy đích đi qua kênh được duyệt (vd. dịch vụ triển khai) — quyết định kiến trúc do hạ tầng.
8. **Ngoại lệ**: quy trình break-glass có ticket + thời hạn + audit.

## 3. Luồng thay thế cung cấp bởi ứng dụng
- **Jump → office**: upload trên ứng dụng desktop ở jump → quét → leader duyệt → tải trên BO ở office (đăng nhập lại).
- **Office → jump**: upload trên BO ở office → quét → leader duyệt → tải trên ứng dụng desktop ở jump (đăng nhập lại; file chỉ xuất hiện sau khi khớp SHA-256).

Server chỉ cho phía đích tải (theo loại phiên web/desktop). Mọi bước có audit (kèm chiều chuyển); người duyệt được thông báo qua email.

## 4. Không thể đảm bảo bằng kỹ thuật
- Người dùng chụp màn hình/đọc số liệu bằng mắt, gõ lại; OCR; camera. → cần chính sách + giám sát + đào tạo.
- Dữ liệu đã tải hợp lệ về máy người dùng: ứng dụng không thu hồi được bản đã tải (chỉ audit).
- Kiểm tra hiệu quả: kế hoạch thử nghiệm đội đỏ nội bộ trên từng kênh ở bảng 1 sau khi áp cấu hình (mục `TEST-PLAN.md` J1–J8).
