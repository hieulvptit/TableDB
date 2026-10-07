# @vnpay/web-bo — Web BO (office portal)

SPA React + Vite chỉ dành cho web BO ở office: đăng nhập, `/transfers` (chuyển file của tôi), `/transfers/new` (upload office → jump), `/transfers/:id`, `/approvals` (+ ủy quyền) và `/audit`.
Không có TableDB, Agent hay Tauri; bản desktop vẫn nằm ở `apps/web`. Dùng chung `@vnpay/shared` và `@vnpay/ui`.

Trang đăng nhập web chỉ hiển thị provider OIDC có `id: "powerbi"` trong `OIDC_PROVIDERS`, kể cả khi xác thực lại (step-up). `clientId` của provider được cấu hình ở API; deployment hiện tại dùng `vnpay-powerbi`. Web không hiển thị provider khác hay form đăng nhập dev.

## Lệnh

```bash
npm install              # tại thư mục gốc repo (npm workspaces)
cd services/web
npm run dev              # http://localhost:5173/c/, proxy /c/api -> VITE_DEV_API (mặc định http://localhost:8080)
npm test                 # vitest
npm run typecheck        # tsc --noEmit
npm run build            # tsc + vite build -> services/web/dist
```

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `VITE_API_BASE` | `/c/api/v1` | Gốc API (cùng origin, cookie session) |
| `VITE_ENV` | `dev` khi dev, `prod` khi build | Nhãn môi trường ở header (`test` / `prod`) |
| `VITE_DEV_API` | `http://localhost:8080` | Chỉ cho dev server: đích proxy `/api` |

## Triển khai

nginx phục vụ thư mục `services/web/dist` tại `/c/` và fallback các route SPA `/c/*` về `/c/index.html`; proxy `/c/api/` tới API. Khi chạy dev, mở `http://localhost:5173/c/`.

AES application transport, independent web/desktop keys and deployment settings: [SECURE-TRANSPORT.md](../../docs/SECURE-TRANSPORT.md).

WebCrypto yêu cầu secure context: dùng HTTPS khi truy cập qua IP/domain, hoặc `http://localhost:5173/c/` khi chạy local. `http://<IP>/c/` không cung cấp `crypto.subtle` và Secure API sẽ không khởi tạo. Kiểm tra trong console bằng `window.isSecureContext` và `Boolean(window.crypto?.subtle)`; cả hai phải là `true`. Nếu thiếu public key, đặt `VITE_SECURE_WEB_PUBLIC_KEY` khớp khóa ký của API server rồi build lại web.
