import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { MemoryTokenStore } from '../api/tokens';
import { cancelGenaiLogin, desktopGenaiLogin, desktopStepUp, genaiErrorMessage, isGenaiCancelled } from './desktopLogin';
import { rememberProvider } from './login';
import GenaiLoginPanel from './GenaiLoginPanel';
import { t } from '../i18n';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const URL_ = 'https://genai.vnpay.vn/create-jwt-token';
const setTauri = (invoke: (cmd: string, args?: unknown) => Promise<unknown>) => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => cmd === 'genai_proxy_check'
      ? Promise.resolve({ proxyUrl: null, reachable: true, latencyMs: null }) : invoke(cmd, args),
  };
};
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; localStorage.clear(); vi.restoreAllMocks(); });

const bundle = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1000 };

describe('desktopGenaiLogin', () => {
  it('genai_login_begin -> POST /auth/desktop/genai {token} -> credential store', async () => {
    const invoke = vi.fn(async () => ({ token: JWT }));
    setTauri(invoke);
    const f = vi.fn().mockResolvedValueOnce(json(bundle));
    const tokens = new MemoryTokenStore();
    const c = new ApiClient({ desktop: true, fetchImpl: f as unknown as typeof fetch, tokens });
    await desktopGenaiLogin(URL_, c);
    expect(invoke).toHaveBeenCalledWith('genai_login_begin', { params: { loginUrl: URL_ } });
    expect(f.mock.calls[0]![0]).toBe('/api/v1/auth/desktop/genai');
    expect(JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ token: JWT });
    expect((await tokens.load())?.refreshToken).toBe('RT');
  });

  it('never writes the token to console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    setTauri(async () => ({ token: JWT }));
    const c = new ApiClient({ desktop: true, fetchImpl: (async () => json(bundle)) as unknown as typeof fetch, tokens: new MemoryTokenStore() });
    await desktopGenaiLogin(URL_, c);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('eyJ');
  });

  it('step-up for a genai session re-runs the broker flow when /auth/config still has desktopLoginUrl', async () => {
    rememberProvider('genai');
    const invoke = vi.fn(async () => ({ token: JWT }));
    setTauri(invoke);
    const f = vi.fn().mockResolvedValueOnce(json({ providers: [], devLogin: false, desktopLoginUrl: URL_ })).mockResolvedValueOnce(json(bundle));
    const c = new ApiClient({ desktop: true, fetchImpl: f as unknown as typeof fetch, tokens: new MemoryTokenStore() });
    expect(await desktopStepUp(c)).toBe('retry');
    expect(invoke).toHaveBeenCalledWith('genai_login_begin', expect.anything());
  });
});

describe('error mapping', () => {
  it('maps shell and API errors to friendly Vietnamese and never leaks the token', () => {
    expect(genaiErrorMessage({ code: 'E_GENAI_TIMEOUT', message: 'x' })).toBe(t('login.genai.err.timeout'));
    expect(genaiErrorMessage({ code: 'E_GENAI_BUSY', message: 'x' })).toBe(t('login.genai.err.busy'));
    expect(genaiErrorMessage({ code: 'E_GENAI_BAD_TOKEN', message: 'x' })).toBe(t('login.genai.err.callback'));
    expect(genaiErrorMessage({ code: 'E_GENAI_ORIGIN', message: 'x' })).toBe(t('login.genai.err.origin'));
    const m401 = genaiErrorMessage(new ApiError('UNAUTHENTICATED', `bad ${JWT}`, 401));
    expect(m401).toContain(t('login.genai.err.unauthorized'));
    expect(m401).not.toContain('eyJ');
    expect(genaiErrorMessage(new ApiError('FORBIDDEN', 'nope', 403))).toContain(t('login.genai.err.forbidden'));
    expect(genaiErrorMessage(new ApiError('UPSTREAM', 'HTTP 502', 502))).toContain(t('login.genai.err.upstream'));
    expect(genaiErrorMessage(new ApiError('UPSTREAM', 'x', 502))).not.toContain(t('err.NETWORK'));
    expect(genaiErrorMessage(new ApiError('NETWORK', 'Failed to fetch', 0))).toBe(t('err.NETWORK'));
    expect(genaiErrorMessage({ code: 'E_PROXY_UNSUPPORTED', message: 'x' })).toBe(t('login.genai.err.proxy'));
    expect(genaiErrorMessage(new ApiError('INTERNAL', 'boom', 500))).not.toContain('eyJ');
    expect(isGenaiCancelled({ code: 'E_GENAI_CANCELLED' })).toBe(true);
    expect(isGenaiCancelled({ code: 'E_GENAI_TIMEOUT' })).toBe(false);
  });
  it('cancel invokes genai_login_cancel', async () => {
    const invoke = vi.fn(async () => undefined);
    setTauri(invoke);
    await cancelGenaiLogin();
    expect(invoke).toHaveBeenCalledWith('genai_login_cancel', undefined);
  });
});

function renderPanel(onDone = vi.fn()) {
  return { onDone, ...render(<GenaiLoginPanel loginUrl={URL_} onDone={onDone} />) };
}
vi.mock('@vnpay/ui', async (orig) => {
  const m = await orig<typeof import('@vnpay/ui')>();
  return { ...m, useToast: () => ({ push: (...a: unknown[]) => toastPush(...a) }) };
});
const toastPush = vi.fn();

describe('GenaiLoginPanel', () => {
  afterEach(() => toastPush.mockClear());

  it('shows the button, waits, cancel returns to idle without an error toast', async () => {
    let reject!: (e: unknown) => void;
    setTauri((cmd) => cmd === 'genai_login_begin' ? new Promise((_, rj) => { reject = rj; }) : (reject({ code: 'E_GENAI_CANCELLED', message: 'c' }), Promise.resolve()));
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: t('login.genai.button') })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: t('login.genai.button') }));
    await screen.findByText(t('login.genai.waiting'));
    fireEvent.click(screen.getByRole('button', { name: t('login.genai.cancel') }));
    await waitFor(() => expect(screen.queryByText(t('login.genai.waiting'))).toBeNull());
    expect(toastPush).not.toHaveBeenCalled();
  });

  it('timeout shows a friendly toast without the token', async () => {
    setTauri(async () => { throw { code: 'E_GENAI_TIMEOUT', message: 'sign-in timed out' }; });
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: t('login.genai.button') })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: t('login.genai.button') }));
    await waitFor(() => expect(toastPush).toHaveBeenCalledWith(t('login.genai.err.timeout'), 'error'));
  });

  it('happy path calls onDone; API 403 toasts the forbidden message', async () => {
    setTauri(async () => ({ token: JWT }));
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(bundle));
    const { onDone } = renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: t('login.genai.button') })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: t('login.genai.button') }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    spy.mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403));
    fireEvent.click(screen.getByRole('button', { name: t('login.genai.button') }));
    await waitFor(() => expect(toastPush).toHaveBeenCalledWith(expect.stringContaining(t('login.genai.err.forbidden')), 'error'));
    expect(JSON.stringify(toastPush.mock.calls)).not.toContain('eyJ');
  });
});
