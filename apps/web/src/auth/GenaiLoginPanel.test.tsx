import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@vnpay/ui';
import { t } from '../i18n';
import GenaiLoginPanel from './GenaiLoginPanel';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
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
  expect(document.body.innerHTML).not.toContain('proxy.test');
  expect(document.body.innerHTML).not.toContain('3359');
  fireEvent.change(screen.getByLabelText(t('login.proxy.username')), { target: { value: 'test-user' } });
  fireEvent.change(screen.getByLabelText(t('login.proxy.password')), { target: { value: 'test-proxy-password' } });
  fireEvent.click(screen.getByRole('button', { name: t('login.proxy.save') }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('secret_set', {
    key: 'proxy.sso.credentials', value: JSON.stringify({ username: 'test-user', password: 'test-proxy-password' }),
  }));
  await waitFor(() => expect(screen.getByLabelText(t('login.proxy.password'))).toHaveValue(''));
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
