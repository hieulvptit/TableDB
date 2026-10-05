import { apiClient, type ApiClient, type StepUpOutcome } from '../api/client';
import type { AuthConfig, DesktopAuthConfig, TokenBundle } from '../api/types';
import { desktopCommands, tauriInvoke } from '../runtime/tauri';
import { errorMessage, t } from '../i18n';
import { ApiError } from '../api/errors';
import { lastProvider, rememberProvider } from './login';

/** Desktop sign-in: system browser + loopback (oidc_begin) then POST /auth/desktop/exchange; tokens go to the credential manager. */
export async function desktopLogin(provider: string, opts: { stepup?: boolean } = {}, c: ApiClient = apiClient): Promise<TokenBundle> {
  const cfg = await c.get<DesktopAuthConfig>('/auth/desktop/config', { public: true, query: { provider } });
  const r = await desktopCommands.oidcBegin({
    authorizeEndpoint: cfg.authorizeEndpoint,
    clientId: cfg.clientId,
    scope: cfg.scopes.join(' '),
    extraParams: opts.stepup ? { prompt: 'login', max_age: '0' } : undefined,
  });
  const bundle = await c.post<TokenBundle>('/auth/desktop/exchange', { provider, code: r.code, codeVerifier: r.codeVerifier, redirectUri: r.redirectUri }, { public: true });
  await c.storeTokens(bundle);
  rememberProvider(provider);
  return bundle;
}

export const GENAI_PROVIDER = 'genai';

interface TauriErr { code?: string; message?: string }

/** VNPAY SSO broker login: `genai_login_begin` (system browser + loopback) -> POST /auth/desktop/genai -> credential store. The JWT is never logged. */
export async function desktopGenaiLogin(loginUrl: string, c: ApiClient = apiClient, onToken?: () => void): Promise<TokenBundle> {
  const { token } = await tauriInvoke<{ token: string }>('genai_login_begin', { params: { loginUrl } });
  onToken?.();
  const bundle = await c.post<TokenBundle>('/auth/desktop/genai', { token }, { public: true });
  await c.storeTokens(bundle);
  rememberProvider(GENAI_PROVIDER);
  return bundle;
}

/** Delete the login window's persisted SSO profile (next login asks for credentials again). */
export const forgetGenaiSso = () => tauriInvoke<void>('genai_login_forget');

export const isGenaiSession = () => lastProvider() === GENAI_PROVIDER;

export const cancelGenaiLogin = () => tauriInvoke<void>('genai_login_cancel');

export const isGenaiCancelled = (e: unknown) => (e as TauriErr | null)?.code === 'E_GENAI_CANCELLED';

const scrub = (m: string) => m.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[token]').slice(0, 200);

/** Friendly message for a failed broker login; never includes the token. An HTTP response that arrived is never reported as a network/proxy problem. */
export function genaiErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status > 0) {
    const base = e.status === 401 ? t('login.genai.err.unauthorized')
      : e.status === 403 ? t('login.genai.err.forbidden')
      : e.status === 502 ? t('login.genai.err.upstream')
      : t('login.genai.err.http');
    return t('login.genai.err.detail', { msg: base, status: e.status, code: e.code }) + (e.message && !/^HTTP \d+$/.test(e.message) ? `: ${scrub(e.message)}` : '');
  }
  switch ((e as TauriErr | null)?.code) {
    case 'E_GENAI_TIMEOUT': return t('login.genai.err.timeout');
    case 'E_GENAI_BUSY': case 'E_OIDC_BUSY': return t('login.genai.err.busy');
    case 'E_GENAI_NO_TOKEN': case 'E_GENAI_BAD_TOKEN': return t('login.genai.err.callback');
    case 'E_GENAI_ORIGIN': return t('login.genai.err.origin');
    case 'E_GENAI_WINDOW': return t('login.genai.err.window');
    case 'E_PROXY_UNSUPPORTED': return t('login.genai.err.proxy');
    case 'E_OPEN_URL': return t('login.genai.err.browser');
    default: return errorMessage(e);
  }
}

/** Desktop step-up: run the IdP round-trip again (prompt=login, max_age=0) and let the client retry the request once. */
export async function desktopStepUp(c: ApiClient = apiClient): Promise<StepUpOutcome> {
  const provider = lastProvider();
  if (!provider) throw new Error('no provider remembered for step-up');
  if (provider === GENAI_PROVIDER) {
    // the broker has no forced re-auth: run the SSO round-trip again with the current desktopLoginUrl
    const cfg = await c.get<AuthConfig>('/auth/config', { public: true });
    if (!cfg.desktopLoginUrl) throw new Error('VNPAY SSO login is no longer configured');
    await desktopGenaiLogin(cfg.desktopLoginUrl, c);
    return 'retry';
  }
  await desktopLogin(provider, { stepup: true }, c);
  return 'retry';
}
