import { apiClient, type ApiClient, type StepUpOutcome } from '../api/client';
import type { AuthConfig } from '../api/types';

export const WEB_OIDC_PROVIDER = 'powerbi';

export const fetchAuthConfig = (c: ApiClient = apiClient) => c.get<AuthConfig>('/auth/config', { public: true });

/** Only same-origin paths are allowed as returnTo (mirrors the server rule). */
export function safeReturnTo(p: string | null | undefined): string {
  if (!p || !p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return '/';
  return p;
}

export function webLoginUrl(c: ApiClient, returnTo: string, stepup = false): string {
  const path = safeReturnTo(returnTo);
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const appPath = path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`) ? path : `${base}${path}`;
  return c.url('/auth/login', { provider: WEB_OIDC_PROVIDER, returnTo: appPath, stepup: stepup ? 1 : undefined });
}

/** Web step-up always uses the permitted OIDC provider. */
export function installStepUpHandler(c: ApiClient = apiClient, nav: (url: string) => void = (u) => window.location.assign(u)) {
  c.onStepUp = async (): Promise<StepUpOutcome> => {
    const here = window.location.pathname + window.location.search;
    nav(webLoginUrl(c, here, true));
    return 'redirected';
  };
}
