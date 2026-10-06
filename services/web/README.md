# @vnpay/web-bo — Web BO (office portal)

SPA React + Vite chỉ dành cho web BO ở office: đăng nhập, `/transfers` (chuyển file của tôi), `/transfers/new` (upload office → jump), `/transfers/:id`, `/approvals` (+ ủy quyền) và `/audit`.
Không có TableDB, Agent hay Tauri; bản desktop vẫn nằm ở `apps/web`. Dùng chung `@vnpay/shared` và `@vnpay/ui`.

## Lệnh

```bash
npm install              # tại thư mục gốc repo (npm workspaces)
cd services/web
npm run dev              # http://localhost:5173, proxy /api -> VITE_DEV_API (mặc định http://localhost:8080)
npm test                 # vitest
npm run typecheck        # tsc --noEmit
npm run build            # tsc + vite build -> services/web/dist
```

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `VITE_API_BASE` | `/api/v1` | Gốc API (cùng origin, cookie session) |
| `VITE_ENV` | `dev` khi dev, `prod` khi build | Nhãn môi trường ở header (`test` / `prod`) |
| `VITE_DEV_API` | `http://localhost:8080` | Chỉ cho dev server: đích proxy `/api` |

## Triển khai

nginx phục vụ thư mục `services/web/dist` tại `/` (xem `deploy/nginx.conf`) và proxy `/api` tới API.

AES application transport, independent web/desktop keys and deployment settings: [SECURE-TRANSPORT.md](../../docs/SECURE-TRANSPORT.md).
