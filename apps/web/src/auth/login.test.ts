import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import { MemoryTokenStore } from '../api/tokens';
import { desktopLogin, desktopStepUp } from './desktopLogin';
import { installStepUpHandler, rememberProvider, safeReturnTo, webLoginUrl } from './login';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; localStorage.clear(); });

describe('safeReturnTo', () => {
  it('allows only same-origin paths', () => {
    expect(safeReturnTo('/tabledb?x=1')).toBe('/tabledb?x=1');
    for (const bad of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/\\evil', '', null, undefined]) expect(safeReturnTo(bad as string)).toBe('/');
  });
});

describe('step-up handler', () => {
  it('web: navigates to /auth/login?...&stepup=1 for the remembered provider and reports "redirected"', async () => {
    rememberProvider('s2o');
    const nav = vi.fn();
    const c = new ApiClient({ baseUrl: '/api/v1' });
    installStepUpHandler(c, nav);
    expect(await c.onStepUp!()).toBe('redirected');
    const url = new URL(nav.mock.calls[0]![0] as string, 'http://x');
    expect(url.pathname).toBe('/api/v1/auth/login');
    expect(url.searchParams.get('provider')).toBe('s2o');
    expect(url.searchParams.get('stepup')).toBe('1');
    expect(url.searchParams.get('returnTo')?.startsWith('/')).toBe(true);
  });
  it('web without a remembered provider falls back to the SPA login page', async () => {
    const nav = vi.fn();
    const c = new ApiClient({});
    installStepUpHandler(c, nav);
    await c.onStepUp!();
    expect(nav.mock.calls[0]![0]).toMatch(/^\/login\?stepup=1&returnTo=/);
  });
  it('webLoginUrl carries stepup only when asked', () => {
    const c = new ApiClient({ baseUrl: '/api/v1' });
    expect(webLoginUrl(c, 'g', '/x')).not.toContain('stepup');
    expect(webLoginUrl(c, 'g', '/x', true)).toContain('stepup=1');
  });
});

describe('desktop login (oidc_begin + exchange + secret store)', () => {
  it('runs oidc_begin with prompt=login on step-up, exchanges the code, stores the bearer tokens', async () => {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'oidc_begin' ? { code: 'CODE', redirectUri: 'http://127.0.0.1:5555/cb', codeVerifier: 'V'.repeat(43) } : null));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
    const f = vi.fn()
      .mockResolvedValueOnce(json({ authorizeEndpoint: 'https://idp/authorize', clientId: 'cid', scopes: ['openid', 'email'], redirectUriTemplate: 'http://127.0.0.1:{port}/cb' }))
      .mockResolvedValueOnce(json({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1000 }));
    const tokens = new MemoryTokenStore();
    const c = new ApiClient({ desktop: true, fetchImpl: f as unknown as typeof fetch, tokens });
    await desktopLogin('s2o', { stepup: true }, c);
    expect(invoke).toHaveBeenCalledWith('oidc_begin', { params: { authorizeEndpoint: 'https://idp/authorize', clientId: 'cid', scope: 'openid email', extraParams: { prompt: 'login', max_age: '0' } } });
    expect(f.mock.calls[0]![0]).toBe('/api/v1/auth/desktop/config?provider=s2o');
    expect(JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string)).toMatchObject({ provider: 's2o', code: 'CODE', redirectUri: 'http://127.0.0.1:5555/cb' });
    expect((await tokens.load())?.accessToken).toBe('AT');
  });
  it('desktopStepUp re-runs the IdP flow for the remembered provider and asks the client to retry', async () => {
    rememberProvider('s2o');
    const invoke = vi.fn(async (cmd: string) => (cmd === 'oidc_begin' ? { code: 'C', redirectUri: 'http://127.0.0.1:1/cb', codeVerifier: 'V'.repeat(43) } : null));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
    const f = vi.fn()
      .mockResolvedValueOnce(json({ authorizeEndpoint: 'https://idp/a', clientId: 'cid', scopes: ['openid'], redirectUriTemplate: 'x' }))
      .mockResolvedValueOnce(json({ accessToken: 'AT2', refreshToken: 'RT2', expiresAt: Date.now() + 1000 }));
    const c = new ApiClient({ desktop: true, fetchImpl: f as unknown as typeof fetch, tokens: new MemoryTokenStore() });
    expect(await desktopStepUp(c)).toBe('retry');
    expect(invoke).toHaveBeenCalledWith('oidc_begin', expect.objectContaining({ params: expect.objectContaining({ extraParams: { prompt: 'login', max_age: '0' } }) }));
  });
});
