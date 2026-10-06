import { createSecureFetch } from '@vnpay/shared';
import { createElement } from 'react';
import { apiClient } from '../api/client';
import { installStepUpHandler } from '../auth/login';
import type { RuntimeInfo } from '../runtime/RuntimeContext';
import { SecretTokenStore } from '../runtime/secretTokenStore';
import { desktopCommands, type AppInfo } from '../runtime/tauri';
import { nativeApiFetch } from '../runtime/apiTransport';
import DesktopApp from './DesktopApp';

/** Normalise a configured API origin/URL into ".../api/v1". */
export function normalizeApiBase(raw: string): string {
  const t = raw.trim().replace(/\/+$/, '');
  return /\/api\/v1$/.test(t) ? t : `${t}/api/v1`;
}

/** Desktop boot: API base + env from app_info() (config.json), bearer tokens in the OS credential manager. */
export async function start(): Promise<{ App: () => JSX.Element; runtime: RuntimeInfo }> {
  let info: AppInfo | null = null;
  try { info = await desktopCommands.appInfo(); } catch { info = null; }
  try {
    const deployment = await desktopCommands.desktopConfig();
    info = { ...info, ...deployment };
  } catch {
    return {
      App: () => createElement('main', { style: { padding: 32 } },
        createElement('h1', null, 'Không tải được cấu hình desktop'),
        createElement('p', null, 'Kiểm tra kết nối tới server rồi thử lại.'),
        createElement('button', { onClick: () => window.location.reload() }, 'Thử lại')),
      runtime: { env: info?.env ?? 'prod', desktop: true, apiBase: info?.apiBaseUrl ?? '' },
    };
  }
  const apiBase = info?.apiBaseUrl ? normalizeApiBase(info.apiBaseUrl) : (import.meta.env.VITE_API_BASE ?? '/api/v1');
  apiClient.configure({ baseUrl: apiBase, desktop: true, tokens: new SecretTokenStore(), fetchImpl: createSecureFetch({ baseUrl: apiBase, clientKind: 'desktop', serverPublicKey: info?.serverSigningPublicKey ?? '', fetchImpl: nativeApiFetch(apiBase) }) });
  installStepUpHandler(apiClient);
  return { App: DesktopApp, runtime: { env: info?.env ?? 'prod', desktop: true, version: info?.version, apiBase, apiConnectionMode: info?.apiConnectionMode === 'proxy' ? 'proxy' : 'direct' } };
}
