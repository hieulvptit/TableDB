import { createSecureFetch, WEB_SERVER_PUBLIC_KEY } from '@vnpay/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@vnpay/ui/styles.css';
import './app.css';
import { apiClient } from './api/client';
import { installStepUpHandler } from './auth/login';
import WebApp from './web/WebApp';

// BO portal boot: same-origin cookie session, env badge from the build.
const apiBase = import.meta.env.VITE_API_BASE ?? '/api/v1';
apiClient.configure({ baseUrl: apiBase, fetchImpl: createSecureFetch({ baseUrl: apiBase, clientKind: 'web', serverPublicKey: import.meta.env.VITE_SECURE_WEB_PUBLIC_KEY ?? WEB_SERVER_PUBLIC_KEY }) });
installStepUpHandler(apiClient);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebApp />
  </StrictMode>,
);
