import { createSecureFetch, redactText } from '@vnpay/shared';
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

/** Desktop boot: embedded API base + env from app_info(), bearer tokens in the OS credential manager. */
export async function start(): Promise<{ App: () => JSX.Element; runtime: RuntimeInfo }> {
  let info: AppInfo | null = null;
  let stage = 'Đọc cấu hình nhúng trong desktop (app_info)';
  try {
    info = await desktopCommands.appInfo();
    if (info.configError) throw { code: 'E_DESKTOP_BOOTSTRAP', message: info.configError };
    if (!info.apiBaseUrl) throw { code: 'E_DESKTOP_BOOTSTRAP', message: 'Bản build desktop thiếu địa chỉ API nhúng. Cần build và cài lại ứng dụng.' };
    stage = 'Tải cấu hình từ API (desktop_config)';
    const deployment = await desktopCommands.desktopConfig();
    info = { ...info, ...deployment };
    stage = 'Khởi tạo Secure API';
    const apiBase = normalizeApiBase(info.apiBaseUrl!);
    apiClient.configure({ baseUrl: apiBase, desktop: true, tokens: new SecretTokenStore(), fetchImpl: createSecureFetch({ baseUrl: apiBase, clientKind: 'desktop', serverPublicKey: info.serverSigningPublicKey ?? '', fetchImpl: nativeApiFetch(apiBase) }) });
    installStepUpHandler(apiClient);
    return { App: DesktopApp, runtime: { env: 'prod', desktop: true, version: info.version, apiBase, apiConnectionMode: info.apiConnectionMode === 'proxy' ? 'proxy' : 'direct' } };
  } catch (error) {
    const detail = typeof error === 'object' && error !== null ? error as { code?: string; message?: string; details?: { stage?: string; requestId?: string } } : null;
    const message = redactText(String(detail?.message ?? (typeof error === 'string' ? error : 'Lỗi không xác định.')))
      .replace(/(:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[REDACTED]@');
    return {
      App: () => createElement('main', { style: { padding: 32 } },
        createElement('h1', null, 'Không tải được cấu hình desktop'),
        createElement('p', { role: 'alert' }, `${detail?.code ? `${detail.code}: ` : ''}${message}`),
        createElement('p', null, `Bước: ${stage}${detail?.details?.stage ? ` / ${detail.details.stage}` : ''}`),
        createElement('p', null, `API: ${info?.apiBaseUrl || 'Chưa cấu hình'}`),
        info?.logDir && createElement('p', null, `Thư mục log: ${info.logDir}`),
        detail?.details?.requestId && createElement('p', null, `Request ID: ${detail.details.requestId}`),
        createElement('p', null, 'API được nhúng cố định trong bản build desktop. Kiểm tra log desktop và kết nối tới API; nếu bản build thiếu hoặc sai địa chỉ API, hãy build và cài lại ứng dụng.'),
        createElement('button', { onClick: () => window.location.reload() }, 'Thử lại')),
      runtime: { env: 'prod', desktop: true, apiBase: info?.apiBaseUrl ?? '' },
    };
  }
}
