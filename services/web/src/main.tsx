import { createSecureFetch, WEB_SERVER_PUBLIC_KEY } from '@vnpay/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@vnpay/ui/styles.css';
import './app.css';
import { apiClient } from './api/client';
import { installStepUpHandler } from './auth/login';
import WebApp from './web/WebApp';

function bootstrap() {
  const root = createRoot(document.getElementById('root')!);
  // BO portal boot: same-origin cookie session, env badge from the build.
  const apiBase = import.meta.env.VITE_API_BASE ?? `${import.meta.env.BASE_URL}api/v1`;
  try {
    apiClient.configure({ baseUrl: apiBase, fetchImpl: createSecureFetch({ baseUrl: apiBase, clientKind: 'web', serverPublicKey: import.meta.env.VITE_SECURE_WEB_PUBLIC_KEY ?? WEB_SERVER_PUBLIC_KEY }) });
    installStepUpHandler(apiClient);
  } catch (error) {
    root.render(
      <main role="alert" style={{ padding: 32, maxWidth: 720, margin: '0 auto' }}>
        <h1>Không thể khởi tạo kết nối API an toàn</h1>
        <p>{error instanceof Error ? error.message : 'Không thể khởi tạo Secure API.'}</p>
        <p>Nếu đang mở web qua HTTP bằng IP hoặc tên miền, hãy dùng HTTPS. Khi chạy trên máy local, mở http://localhost:5173/c/.</p>
        <button onClick={() => window.location.reload()}>Thử lại</button>
      </main>,
    );
    return;
  }
  root.render(
    <StrictMode>
      <WebApp />
    </StrictMode>,
  );
}

bootstrap();
