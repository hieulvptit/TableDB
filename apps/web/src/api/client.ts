import { ApiError, errorFromResponse } from './errors';
import { MemoryTokenStore, toEpochMs, type StoredTokens, type TokenStore } from './tokens';
import type { TokenBundle } from './types';

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** raw body (e.g. Blob for part upload); when set `body` is ignored */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** public routes (login/exchange): no bearer, no CSRF, no 401 refresh */
  public?: boolean;
  /** return Response instead of parsing JSON */
  raw?: boolean;
  /** internal: prevents infinite retry loops */
  _retried?: { stepup?: boolean; refresh?: boolean };
}

export type StepUpOutcome = 'retry' | 'redirected';
export interface ApiClientOptions {
  baseUrl?: string;
  desktop?: boolean | (() => boolean);
  fetchImpl?: typeof fetch;
  tokens?: TokenStore;
  /** Called on STEPUP_REQUIRED. Web: navigate to login?stepup=1 (return 'redirected'). Desktop: run oidc again then return 'retry'. */
  onStepUp?: () => Promise<StepUpOutcome>;
  /** Called when the session is definitively gone (401 UNAUTHENTICATED that could not be refreshed). */
  onUnauthenticated?: () => void;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export class ApiClient {
  baseUrl: string;
  private desktopFlag: boolean | (() => boolean);
  private fetchImpl: typeof fetch;
  private tokens: TokenStore;
  private csrf: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  onStepUp?: ApiClientOptions['onStepUp'];
  onUnauthenticated?: ApiClientOptions['onUnauthenticated'];

  constructor(o: ApiClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? '/api/v1').replace(/\/+$/, '');
    this.desktopFlag = o.desktop ?? false;
    this.fetchImpl = o.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.tokens = o.tokens ?? new MemoryTokenStore();
    this.onStepUp = o.onStepUp;
    this.onUnauthenticated = o.onUnauthenticated;
  }

  configure(o: Partial<ApiClientOptions>) {
    if (o.baseUrl !== undefined) this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    if (o.desktop !== undefined) this.desktopFlag = o.desktop;
    if (o.fetchImpl) this.fetchImpl = o.fetchImpl;
    if (o.tokens) this.tokens = o.tokens;
    if ('onStepUp' in o) this.onStepUp = o.onStepUp;
    if ('onUnauthenticated' in o) this.onUnauthenticated = o.onUnauthenticated;
  }

  get isDesktop() { return typeof this.desktopFlag === 'function' ? this.desktopFlag() : this.desktopFlag; }
  get tokenStore() { return this.tokens; }
  setCsrfToken(t: string | null) { this.csrf = t; }
  getCsrfToken() { return this.csrf; }
  url(path: string, query?: RequestOptions['query']): string {
    const q = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
    const qs = q.length ? `?${new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString()}` : '';
    return `${this.baseUrl}${path}${qs}`;
  }

  async storeTokens(b: TokenBundle): Promise<void> {
    const t: StoredTokens = { accessToken: b.accessToken, refreshToken: b.refreshToken, expiresAt: toEpochMs(b.expiresAt) };
    await this.tokens.save(t);
  }

  /** Refresh (desktop). Single-flight so parallel 401s share one rotation. */
  private refresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const cur = await this.tokens.load();
        if (!cur?.refreshToken) return false;
        try {
          const b = await this.request<TokenBundle>('POST', '/auth/desktop/refresh', { public: true, body: { refreshToken: cur.refreshToken } });
          await this.storeTokens(b);
          return true;
        } catch (e) {
          // Only a definitive rejection (4xx) drops the stored session; a network/5xx failure keeps it so a restart can retry.
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) await this.tokens.clear();
          return false;
        }
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const m = method.toUpperCase();
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    const init: RequestInit = { method: m, headers, signal: opts.signal };

    if (!opts.public) {
      if (this.isDesktop) {
        let tok = await this.tokens.load();
        if (tok && tok.refreshToken && tok.expiresAt && tok.expiresAt - Date.now() < 30_000 && !opts._retried?.refresh) {
          if (await this.refresh()) tok = await this.tokens.load();
        }
        if (tok?.accessToken) headers.Authorization = `Bearer ${tok.accessToken}`;
      } else {
        init.credentials = 'include';
        if (!SAFE.has(m)) {
          if (!this.csrf) await this.loadCsrf();
          if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
        }
      }
    }
    if (opts.rawBody !== undefined) init.body = opts.rawBody;
    else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }

    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), init);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw new ApiError('ABORTED', 'aborted', 0);
      throw new ApiError('NETWORK', (e as Error).message || 'network error', 0);
    }

    if (res.ok) {
      if (opts.raw) return res as unknown as T;
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    let body: unknown = null;
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    const err = errorFromResponse(res.status, res.headers, body);

    if (err.code === 'STEPUP_REQUIRED' && this.onStepUp && !opts._retried?.stepup) {
      const outcome = await this.onStepUp();
      if (outcome === 'retry') return this.request<T>(method, path, { ...opts, _retried: { ...opts._retried, stepup: true } });
      throw err; // 'redirected': the page is navigating away
    }
    if (err.code === 'UNAUTHENTICATED' && !opts.public) {
      if (this.isDesktop && !opts._retried?.refresh && (await this.refresh())) {
        return this.request<T>(method, path, { ...opts, _retried: { ...opts._retried, refresh: true } });
      }
      this.onUnauthenticated?.();
    }
    if (err.code === 'FORBIDDEN' && !this.isDesktop && /csrf/i.test(err.message) && !opts._retried?.refresh) {
      // stale CSRF token (e.g. session rotated): fetch a new one once
      this.csrf = null;
      await this.loadCsrf();
      return this.request<T>(method, path, { ...opts, _retried: { ...opts._retried, refresh: true } });
    }
    throw err;
  }

  private async loadCsrf() {
    try {
      const me = await this.request<{ csrfToken?: string }>('GET', '/auth/me');
      if (me?.csrfToken) this.csrf = me.csrfToken;
    } catch { /* let the real request fail with the server's error */ }
  }

  get<T>(path: string, opts?: RequestOptions) { return this.request<T>('GET', path, opts); }
  post<T>(path: string, body?: unknown, opts?: RequestOptions) { return this.request<T>('POST', path, { ...opts, body }); }
  put<T>(path: string, body?: unknown, opts?: RequestOptions) { return this.request<T>('PUT', path, { ...opts, body }); }
  del<T>(path: string, opts?: RequestOptions) { return this.request<T>('DELETE', path, opts); }
}

export const apiClient = new ApiClient({ desktop: import.meta.env.VITE_TARGET === 'desktop' });
