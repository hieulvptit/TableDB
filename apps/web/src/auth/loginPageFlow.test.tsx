import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from '../i18n';
import type { AuthState } from './AuthContext';

const anon: AuthState = { status: 'anonymous', me: null, can: () => false, refresh: async () => {}, logout: async () => {} };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function mount(target: 'desktop' | 'web', cfg: unknown) {
  vi.resetModules();
  vi.stubEnv('VITE_TARGET', target);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(cfg));
  const { default: LoginPage } = await import('./LoginPage');
  const { ToastProvider } = await import('@vnpay/ui');
  const { AuthContext } = await import('./AuthContext');
  const { apiClient } = await import('../api/client');
  apiClient.configure({ desktop: target === 'desktop' });
  return render(
    <ToastProvider><AuthContext.Provider value={anon}><MemoryRouter><LoginPage /></MemoryRouter></AuthContext.Provider></ToastProvider>,
  );
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('LoginPage flow selection (desktop)', () => {
  it('desktopLoginUrl set -> single VNPAY SSO button, no provider buttons', async () => {
    await mount('desktop', { providers: [{ id: 's2o', label: 'S2O' }], devLogin: false, desktopLoginUrl: 'https://genai.vnpay.vn/create-jwt-token' });
    expect(await screen.findByRole('button', { name: t('login.genai.button') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('login.with', { name: 'S2O' }) })).toBeNull();
  });
  it('desktopLoginUrl null -> existing OIDC provider buttons', async () => {
    await mount('desktop', { providers: [{ id: 's2o', label: 'S2O' }], devLogin: false, desktopLoginUrl: null });
    expect(await screen.findByRole('button', { name: t('login.with', { name: 'S2O' }) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('login.genai.button') })).toBeNull();
  });
  it('web target ignores desktopLoginUrl', async () => {
    await mount('web', { providers: [{ id: 's2o', label: 'S2O' }], devLogin: false, desktopLoginUrl: 'https://genai.vnpay.vn/create-jwt-token' });
    expect(await screen.findByRole('button', { name: t('login.with', { name: 'S2O' }) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('login.genai.button') })).toBeNull();
  });
});
