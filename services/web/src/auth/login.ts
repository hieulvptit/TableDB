import { apiClient, type ApiClient, type StepUpOutcome } from '../api/client';
import type { AuthConfig } from '../api/types';

const PROVIDER_KEY = 'tabledb.lastProvider';
export const rememberProvider = (id: string) => { try { localStorage.setItem(PROVIDER_KEY, id); } catch { /* storage may be blocked */ } };
export const lastProvider = (): string | null => { try { return localStorage.getItem(PROVIDER_KEY); } catch { return null; } };

export const fetchAuthConfig = (c: ApiClient = apiClient) => c.get<AuthConfig>('/auth/config', { public: true });

/** Only same-origin paths are allowed as returnTo (mirrors the server rule). */
export function safeReturnTo(p: string | null | undefined): string {
  if (!p || !p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return '/';
  return p;
}

export function webLoginUrl(c: ApiClient, provider: string, returnTo: string, stepup = false): string {
  return c.url('/auth/login', { provider, returnTo: safeReturnTo(returnTo), stepup: stepup ? 1 : undefined });
}

/** Step-up: navigate to the IdP login (or /login?stepup=1) and let the page reload. */
export function installStepUpHandler(c: ApiClient = apiClient, nav: (url: string) => void = (u) => window.location.assign(u)) {
  c.onStepUp = async (): Promise<StepUpOutcome> => {
    const provider = lastProvider();
    const here = window.location.pathname + window.location.search;
    nav(provider ? webLoginUrl(c, provider, here, true) : `/login?stepup=1&returnTo=${encodeURIComponent(here)}`);
    return 'redirected';
  };
}
