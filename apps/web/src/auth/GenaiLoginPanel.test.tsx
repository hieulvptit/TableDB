import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@vnpay/ui';
import { t } from '../i18n';
import GenaiLoginPanel from './GenaiLoginPanel';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

it.each([
  ['E_PROXY_AUTH_FAILED', 'authFailed'],
  ['E_PROXY_AUTH_REQUIRED', 'required'],
  ['E_PROXY_TARGET', 'targetFailed'],
] as const)('shows a red icon with the specific reason for %s', async (errorCode, status) => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: vi.fn(async () => ({ proxyUrl: 'http://proxy.test:3359', reachable: false, latencyMs: null, errorCode })),
  };
  render(<ToastProvider><GenaiLoginPanel loginUrl="https://genai.vnpay.vn/create-jwt-token" onDone={() => {}} /></ToastProvider>);
  const icon = await screen.findByRole('button', { name: `${t('login.proxy.retry')}: ${t(`login.proxy.${status}`)}` });
  expect(icon.style.color).toBe('var(--ui-danger)');
  expect(icon).toHaveAttribute('title', `${t('login.proxy.label')}: ${t(`login.proxy.${status}`)}`);
});

it.each(['direct', 'proxy'] as const)('hides the proxy status when none is configured, regardless of API mode (%s)', async connectionMode => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn(async () => ({ proxyUrl: null, reachable: true, latencyMs: null })) };
  render(<ToastProvider><GenaiLoginPanel loginUrl="https://genai.vnpay.vn/create-jwt-token" onDone={() => {}}
    api={{ loading: false, error: '', ready: true, baseUrl: 'http://localhost:8080/api/v1', retry: () => {}, connectionMode }} /></ToastProvider>);
  await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(t('login.proxy.retry')) })).toBeNull());
  expect(screen.queryByText(t(`login.api.${connectionMode}`))).toBeNull();
  expect(screen.getByRole('button', { name: t('login.genai.button') })).toBeEnabled();
});

it('saves proxy credentials only through the vault and clears the password field', async () => {
  const invoke = vi.fn(async (command: string) => command === 'genai_proxy_check' ? { proxyUrl: 'http://proxy.test:3359', reachable: true, latencyMs: 5 } : undefined);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  render(<ToastProvider><GenaiLoginPanel loginUrl="https://genai.vnpay.vn/create-jwt-token" onDone={() => {}} /></ToastProvider>);
  await screen.findByText(t('login.proxy.title'));
  fireEvent.click(screen.getByText(t('login.proxy.title')));
  expect(screen.getByLabelText(t('login.proxy.url'))).toHaveValue('http://proxy.test:3359');
  fireEvent.change(screen.getByLabelText(t('login.proxy.username')), { target: { value: 'test-user' } });
  fireEvent.change(screen.getByLabelText(t('login.proxy.password')), { target: { value: 'test-proxy-password' } });
  fireEvent.click(screen.getByRole('button', { name: t('login.proxy.save') }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('secret_set', {
    key: 'proxy.sso.credentials', value: JSON.stringify({ proxyUrl: 'http://proxy.test:3359', username: 'test-user', password: 'test-proxy-password' }),
  }));
  await waitFor(() => expect(screen.queryByLabelText(t('login.proxy.password'))).toBeNull());
  fireEvent.click(screen.getByText(t('login.proxy.title')));
  expect(screen.getByLabelText(t('login.proxy.password'))).toHaveValue('');
  expect(invoke.mock.calls.some(([command]) => command === 'secret_get')).toBe(false);
  expect(JSON.stringify(localStorage)).not.toContain('test-proxy-password');
});

it('allows SSO with a closed proxy and keeps the status retry available', async () => {
  let reachable = false;
  const invoke = vi.fn(async () => ({ proxyUrl: 'http://proxy.test:3359', reachable, latencyMs: reachable ? 5 : null }));
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  render(<ToastProvider><GenaiLoginPanel loginUrl="https://genai.vnpay.vn/create-jwt-token" onDone={() => {}} /></ToastProvider>);
  const login = screen.getByRole('button', { name: t('login.genai.button') });
  expect(login).toBeEnabled();
  const checking = screen.getByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.checking')}` });
  expect(checking.style.color).toBe('var(--ui-warning)');
  expect(checking.textContent).toBe('');
  await screen.findByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.unreachable')}` });
  expect(screen.getByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.unreachable')}` }).style.color).toBe('var(--ui-danger)');
  expect(document.body.innerHTML).not.toContain('proxy.test');
  expect(login).toBeEnabled();
  reachable = true;
  fireEvent.click(screen.getByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.unreachable')}` }));
  await waitFor(() => expect(login).toBeEnabled());
  const connected = screen.getByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.reachable')}` });
  expect(connected).toHaveAttribute('title', `${t('login.proxy.label')}: ${t('login.proxy.reachable')} (5 ms)`);
  expect(connected.style.color).toBe('var(--ui-success)');
  expect(connected.textContent).toBe('');
  expect(document.body.innerHTML).not.toContain('proxy.test');
  expect(invoke.mock.calls).toHaveLength(2);
});

it.each(['unreachable', 'error'] as const)('starts SSO when the proxy check is %s', async status => {
  const invoke = vi.fn(async (command: string) => {
    if (command === 'genai_proxy_check') {
      if (status === 'error') throw new Error('probe failed');
      return { proxyUrl: 'http://proxy.test:3359', reachable: false, latencyMs: null };
    }
    if (command === 'genai_login_begin') throw { code: 'E_GENAI_CANCELLED' };
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  render(<ToastProvider><GenaiLoginPanel loginUrl="https://genai.vnpay.vn/create-jwt-token" onDone={() => {}} /></ToastProvider>);
  await screen.findByRole('button', { name: `${t('login.proxy.retry')}: ${t(`login.proxy.${status}`)}` });
  const login = screen.getByRole('button', { name: t('login.genai.button') });
  expect(login).toBeEnabled();
  fireEvent.click(login);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('genai_login_begin', {
    params: { loginUrl: 'https://genai.vnpay.vn/create-jwt-token' },
  }));
  await waitFor(() => expect(login).toBeEnabled());
});


it('lets users save a custom proxy URL and credentials', async () => {
  const invoke = vi.fn(async (command: string) => command === 'genai_proxy_check' ? { proxyUrl: 'http://10.23.5.189:3359', reachable: true, latencyMs: 5 } : undefined);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  render(<ToastProvider><GenaiLoginPanel loginUrl="https://genai.vnpay.vn/create-jwt-token" onDone={() => {}} /></ToastProvider>);
  await screen.findByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.reachable')}` });
  expect(screen.queryByLabelText(t('login.proxy.url'))).toBeNull();
  fireEvent.click(screen.getByText(t('login.proxy.title')));
  expect(screen.getByLabelText(t('login.proxy.url'))).toHaveValue('');
  expect(screen.getByLabelText(t('login.proxy.username'))).toHaveValue('');
  fireEvent.change(screen.getByLabelText(t('login.proxy.url')), { target: { value: 'http://custom-proxy:3128' } });
  fireEvent.change(screen.getByLabelText(t('login.proxy.username')), { target: { value: 'custom-user' } });
  expect(screen.getByRole('button', { name: t('login.proxy.save') })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(t('login.proxy.password')), { target: { value: 'custom-password' } });
  fireEvent.click(screen.getByRole('button', { name: t('login.proxy.save') }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('secret_set', {
    key: 'proxy.sso.credentials', value: JSON.stringify({ proxyUrl: 'http://custom-proxy:3128', username: 'custom-user', password: 'custom-password' }),
  }));
});

it('can select direct SSO without proxy credentials when the server has no proxy', async () => {
  const invoke = vi.fn(async (command: string) => command === 'genai_proxy_check' ? { proxyUrl: null, reachable: true, latencyMs: null } : undefined);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  render(<ToastProvider><GenaiLoginPanel loginUrl="https://genai.vnpay.vn/create-jwt-token" onDone={() => {}} /></ToastProvider>);
  await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(t('login.proxy.retry')) })).toBeNull());
  fireEvent.click(screen.getByText(t('login.proxy.title')));
  expect(screen.getByLabelText(t('login.proxy.url'))).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: t('login.proxy.save') }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('secret_set', {
    key: 'proxy.sso.credentials', value: JSON.stringify({ proxyUrl: '', username: 'de_team', password: '' }),
  }));
});
