import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const me = { user: { id: 'u1', email: 'a@vnpay.vn', name: 'A', roles: ['user'], permissions: ['db:connect'] }, csrfToken: 'x', authTime: 0, kind: 'desktop' };

async function mount(genai: () => Response, authConfig?: () => Response) {
  vi.resetModules();
  vi.stubEnv('VITE_TARGET', 'desktop');
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn(async (command: string) => command === 'genai_proxy_check'
    ? { proxyUrl: 'http://proxy.test:3359', reachable: true, latencyMs: 5 } : { token: JWT }) };
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/auth/config')) return authConfig ? authConfig() : json({ providers: [], devLogin: false, desktopLoginUrl: 'https://genai.vnpay.vn/create-jwt-token' });
    if (url.endsWith('/auth/desktop/genai')) return genai();
    if (url.endsWith('/auth/me')) return json(me);
    return json({}, 404);
  });
  const { apiClient } = await import('../api/client');
  const { MemoryTokenStore } = await import('../api/tokens');
  apiClient.configure({ desktop: true, tokens: new MemoryTokenStore(), fetchImpl: fetchImpl as unknown as typeof fetch });
  const { ToastProvider } = await import('@vnpay/ui');
  const { AuthProvider, RequireAuth, useAuth } = await import('./AuthContext');
  const { default: LoginPage } = await import('./LoginPage');
  const { MemoryRouter, Routes, Route, Navigate } = await import('react-router-dom');
  const { t } = await import('../i18n');
  const Home = () => { const { can } = useAuth(); return can('db:connect') ? <Navigate to="/tabledb" replace /> : <div>no access</div>; };
  const utils = render(
    <ToastProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
            <Route path="/tabledb" element={<RequireAuth><div>TABLEDB PAGE</div></RequireAuth>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ToastProvider>,
  );
  return { ...utils, t, calls };
}
afterEach(() => { vi.unstubAllEnvs(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; localStorage.clear(); });

describe('genai login end to end (jsdom)', () => {
  it('keeps proxy status and credentials available when the API is unreachable; retry restores sign-in', async () => {
    let online = false;
    const { t, calls } = await mount(() => json({}), () => {
      if (!online) throw new TypeError('Failed to fetch');
      return json({ providers: [], devLogin: false, desktopLoginUrl: 'https://genai.vnpay.vn/create-jwt-token' });
    });
    expect(await screen.findByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.reachable')}` })).toBeEnabled();
    expect(screen.queryByText(t('login.api.address', { url: '/api/v1' }))).toBeNull();
    fireEvent.click(screen.getByText(t('login.proxy.title')));
    expect(screen.getByLabelText(t('login.proxy.username'))).toBeEnabled();
    expect(screen.getByLabelText(t('login.proxy.password'))).toBeEnabled();
    expect(screen.queryByRole('button', { name: t('login.genai.button') })).toBeNull();
    online = true;
    fireEvent.click(await screen.findByRole('button', { name: t('common.retry') }));
    await waitFor(() => expect(screen.getByRole('button', { name: t('login.genai.button') })).toBeEnabled());
    expect(calls.filter(u => u.endsWith('/auth/config'))).toHaveLength(2);
  });

  it('success: tokens stored, AuthContext user set, router lands on /tabledb', async () => {
    const { t, calls } = await mount(() => json({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 60_000, user: me.user }));
    fireEvent.click(await screen.findByRole('button', { name: t('login.genai.button') }));
    expect(await screen.findByText('TABLEDB PAGE')).toBeInTheDocument();
    expect(calls.some((u) => u.endsWith('/auth/desktop/genai'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/auth/me'))).toBe(true);
  });

  it('502 from /auth/desktop/genai shows the VNPAY-upstream message with status and stays on the login page', async () => {
    const { t } = await mount(() => json({ error: { code: 'UPSTREAM', message: 'genai verify failed' } }, 502));
    fireEvent.click(await screen.findByRole('button', { name: t('login.genai.button') }));
    const el = await screen.findByText(new RegExp(t('login.genai.err.upstream').replace(/[.]/g, '\\.')));
    expect(el.textContent).toContain('502');
    expect(el.textContent).not.toContain(t('err.NETWORK'));
    expect(screen.queryByText('TABLEDB PAGE')).toBeNull();
    expect(screen.getByRole('button', { name: t('login.genai.button') })).toBeEnabled();
  });

  it('login succeeded but /auth/me fails: the error is surfaced instead of a silent bounce', async () => {
    const { t } = await mount(() => json({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 60_000 }));
    const { apiClient } = await import('../api/client');
    const inner = (apiClient as unknown as { fetchImpl: typeof fetch }).fetchImpl;
    (apiClient as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) =>
      String(i).endsWith('/auth/me') ? json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403) : inner(i, init)) as typeof fetch;
    fireEvent.click(await screen.findByRole('button', { name: t('login.genai.button') }));
    await waitFor(() => expect(screen.getByText(new RegExp('HTTP 403'))).toBeInTheDocument());
    expect(screen.queryByText('TABLEDB PAGE')).toBeNull();
  });
});
