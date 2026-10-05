import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@vnpay/ui/styles.css';
import './app.css';
import { apiClient } from './api/client';
import { installStepUpHandler } from './auth/login';
import WebApp from './web/WebApp';

// BO portal boot: same-origin cookie session, env badge from the build.
apiClient.configure({ baseUrl: import.meta.env.VITE_API_BASE ?? '/api/v1' });
installStepUpHandler(apiClient);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebApp />
  </StrictMode>,
);
