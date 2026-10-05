import { ApiError, errorFromResponse } from './errors';

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** raw body (e.g. Blob for part upload); when set `body` is ignored */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** public routes (login): no CSRF header */
  public?: boolean;
  /** return Response instead of parsing JSON */
  raw?: boolean;
  /** internal: prevents infinite retry loops */
  _retried?: { stepup?: boolean; refresh?: boolean };
}

export type StepUpOutcome = 'retry' | 'redirected';
export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called on STEPUP_REQUIRED. Navigate to login?stepup=1 (return 'redirected'). */
  onStepUp?: () => Promise<StepUpOutcome>;
  /** Called when the session is definitively gone (401 UNAUTHENTICATED that could not be refreshed). */
  onUnauthenticated?: () => void;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export class ApiClient {
  baseUrl: string;
  private fetchImpl: typeof fetch;
  private csrf: string | null = null;
  onStepUp?: ApiClientOptions['onStepUp'];
  onUnauthenticated?: ApiClientOptions['onUnauthenticated'];

  constructor(o: ApiClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? '/api/v1').replace(/\/+$/, '');
    this.fetchImpl = o.fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.onStepUp = o.onStepUp;
    this.onUnauthenticated = o.onUnauthenticated;
  }

  configure(o: Partial<ApiClientOptions>) {
    if (o.baseUrl !== undefined) this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    if (o.fetchImpl) this.fetchImpl = o.fetchImpl;
    if ('onStepUp' in o) this.onStepUp = o.onStepUp;
    if ('onUnauthenticated' in o) this.onUnauthenticated = o.onUnauthenticated;
  }

  setCsrfToken(t: string | null) { this.csrf = t; }
  getCsrfToken() { return this.csrf; }
  url(path: string, query?: RequestOptions['query']): string {
    const q = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
    const qs = q.length ? `?${new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString()}` : '';
    return `${this.baseUrl}${path}${qs}`;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const m = method.toUpperCase();
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    const init: RequestInit = { method: m, headers, signal: opts.signal };

    if (!opts.public) {
      init.credentials = 'include';
      if (!SAFE.has(m)) {
        if (!this.csrf) await this.loadCsrf();
        if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
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
      this.onUnauthenticated?.();
    }
    if (err.code === 'FORBIDDEN' && /csrf/i.test(err.message) && !opts._retried?.refresh) {
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

export const apiClient = new ApiClient();
