import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const me = { user: { id: 'u1', email: 'a@vnpay.vn', name: 'A', roles: ['user'], permissions: ['db:connect'] }, csrfToken: 'x', authTime: 0, kind: 'desktop' };

async function setup(stored: { accessToken: string; refreshToken: string; expiresAt: number } | null, handler: (url: string, init?: RequestInit) => Response) {
  vi.resetModules();
  vi.stubEnv('VITE_TARGET', 'desktop');
  const invoked: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn(async (cmd: string) => { invoked.push(cmd); return null; }) };
  const calls: Array<{ url: string; auth?: string; body?: string }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization, body: init?.body as string | undefined });
    return handler(url, init);
  });
  const { apiClient } = await import('../api/client');
  const { MemoryTokenStore } = await import('../api/tokens');
  const tokens = new MemoryTokenStore(stored);
  apiClient.configure({ desktop: true, tokens, fetchImpl: fetchImpl as unknown as typeof fetch });
  const { AuthProvider, useAuth } = await import('./AuthContext');
  const Probe = () => { const a = useAuth(); return <div><span data-testid="s">{a.status}</span><button onClick={() => void a.logout({ forgetSso: true })}>out-forget</button><button onClick={() => void a.logout()}>out-keep</button></div>; };
  render(<AuthProvider><Probe /></AuthProvider>);
  return { tokens, calls, invoked };
}
afterEach(() => { vi.unstubAllEnvs(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; localStorage.clear(); });
const status = () => screen.getByTestId('s').textContent;

describe('desktop session restore on boot', () => {
  it('valid access token: /auth/me with the stored bearer, no refresh', async () => {
    const { calls } = await setup({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 600_000 }, (u) => (u.endsWith('/auth/me') ? json(me) : json({}, 404)));
    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/auth/me']);
    expect(calls[0]!.auth).toBe('Bearer AT');
  });

  it('expired access + valid refresh: silent POST /auth/desktop/refresh, rotated tokens stored, then authenticated', async () => {
    const { tokens, calls } = await setup({ accessToken: 'OLD', refreshToken: 'RT1', expiresAt: Date.now() - 1000 }, (u) => {
      if (u.endsWith('/auth/desktop/refresh')) return json({ accessToken: 'NEW', refreshToken: 'RT2', expiresAt: Date.now() + 600_000 });
      if (u.endsWith('/auth/me')) return json(me);
      return json({}, 404);
    });
    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(calls[0]!.url).toBe('/api/v1/auth/desktop/refresh');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ refreshToken: 'RT1' });
    expect(calls[1]!.auth).toBe('Bearer NEW');
    expect(await tokens.load()).toMatchObject({ accessToken: 'NEW', refreshToken: 'RT2' });
  });

  it('expired access + rejected refresh: anonymous (login page) and the dead session is cleared', async () => {
    const { tokens } = await setup({ accessToken: 'OLD', refreshToken: 'BAD', expiresAt: Date.now() - 1000 }, (u) =>
      u.endsWith('/auth/desktop/refresh') ? json({ error: { code: 'UNAUTHENTICATED', message: 'revoked' } }, 401) : json({ error: { code: 'UNAUTHENTICATED', message: 'x' } }, 401));
    await waitFor(() => expect(status()).toBe('anonymous'));
    expect(await tokens.load()).toBeNull();
  });

  it('refresh failing on the network keeps the stored session for the next start', async () => {
    const { tokens } = await setup({ accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() - 1000 }, () => { throw new TypeError('offline'); });
    await waitFor(() => expect(status()).toBe('anonymous'));
    expect((await tokens.load())?.refreshToken).toBe('RT');
  });

  it('no stored tokens: anonymous without any API call', async () => {
    const { calls } = await setup(null, () => json({}, 404));
    await waitFor(() => expect(status()).toBe('anonymous'));
    expect(calls).toEqual([]);
  });
});

describe('logout and SSO forget', () => {
  const ok = (u: string) => (u.endsWith('/auth/me') ? json(me) : u.endsWith('/auth/logout') ? json({}) : json({}, 404));
  const valid = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 600_000 };

  it('forgetSso: revokes the API session first, then genai_login_forget', async () => {
    const { calls, invoked, tokens } = await setup(valid, ok);
    await waitFor(() => expect(status()).toBe('authenticated'));
    fireEvent.click(screen.getByText('out-forget'));
    await waitFor(() => expect(invoked).toContain('genai_login_forget'));
    expect(calls.some((c) => c.url.endsWith('/auth/logout'))).toBe(true);
    expect(await tokens.load()).toBeNull();
    expect(status()).toBe('anonymous');
  });

  it('plain logout keeps the SSO cookies (no genai_login_forget)', async () => {
    const { invoked } = await setup(valid, ok);
    await waitFor(() => expect(status()).toBe('authenticated'));
    fireEvent.click(screen.getByText('out-keep'));
    await waitFor(() => expect(status()).toBe('anonymous'));
    expect(invoked).not.toContain('genai_login_forget');
  });

  it('SsoLogoutControl: forgets SSO only for genai sessions', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_TARGET', 'desktop');
    const invoked: string[] = [];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn(async (c: string) => { invoked.push(c); return null; }) };
    const { apiClient } = await import('../api/client');
    const { MemoryTokenStore } = await import('../api/tokens');
    apiClient.configure({ desktop: true, tokens: new MemoryTokenStore(valid), fetchImpl: (async (i: RequestInfo | URL) => ok(String(i))) as unknown as typeof fetch });
    const { AuthProvider } = await import('./AuthContext');
    const { default: SsoLogoutControl } = await import('./SsoLogoutControl');
    const { t } = await import('../i18n');
    const { rememberProvider } = await import('./login');

    const first = render(<AuthProvider><SsoLogoutControl /></AuthProvider>);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('nav.logout') }));
    await waitFor(async () => expect(await apiClient.tokenStore.load()).toBeNull());
    expect(invoked).not.toContain('genai_login_forget'); // OIDC session: SSO kept
    first.unmount();

    rememberProvider('genai');
    render(<AuthProvider><SsoLogoutControl /></AuthProvider>);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('nav.logout') }));
    await waitFor(() => expect(invoked).toContain('genai_login_forget'));
  });
});
