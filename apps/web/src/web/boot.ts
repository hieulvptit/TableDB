import { createSecureFetch, WEB_SERVER_PUBLIC_KEY } from '@vnpay/shared';
import { apiClient } from '../api/client';
import { installStepUpHandler } from '../auth/login';
import type { RuntimeInfo } from '../runtime/RuntimeContext';
import WebApp from './WebApp';

/** BO portal boot: same-origin cookie session, env badge from the build. */
export async function start(): Promise<{ App: () => JSX.Element; runtime: RuntimeInfo }> {
  const apiBase = import.meta.env.VITE_API_BASE ?? '/api/v1';
  apiClient.configure({ baseUrl: apiBase, desktop: false, fetchImpl: createSecureFetch({ baseUrl: apiBase, clientKind: 'web', serverPublicKey: import.meta.env.VITE_SECURE_WEB_PUBLIC_KEY ?? WEB_SERVER_PUBLIC_KEY }) });
  installStepUpHandler(apiClient);
  return { App: WebApp, runtime: { env: import.meta.env.VITE_ENV ?? (import.meta.env.DEV ? 'dev' : 'prod'), desktop: false, apiBase } };
}
