import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@vnpay/ui';
import { t } from '../i18n';
import GenaiLoginPanel from './GenaiLoginPanel';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

it('saves proxy credentials only through the vault and clears the password field', async () => {
  const invoke = vi.fn(async (command: string) => command === 'genai_proxy_check' ? { proxyUrl: 'http://proxy.test:3359', reachable: true, latencyMs: 5 } : undefined);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  render(<ToastProvider><GenaiLoginPanel loginUrl="https://genai.vnpay.vn/create-jwt-token" onDone={() => {}} /></ToastProvider>);
  await screen.findByText(t('login.proxy.title'));
  fireEvent.click(screen.getByText(t('login.proxy.title')));
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

it('blocks SSO on a closed proxy and enables it only after a successful retry', async () => {
  let reachable = false;
  const invoke = vi.fn(async () => ({ proxyUrl: 'http://proxy.test:3359', reachable, latencyMs: reachable ? 5 : null }));
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  render(<ToastProvider><GenaiLoginPanel loginUrl="https://genai.vnpay.vn/create-jwt-token" onDone={() => {}} /></ToastProvider>);
  const login = screen.getByRole('button', { name: t('login.genai.button') });
  expect(login).toBeDisabled();
  await screen.findByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.unreachable')}` });
  expect(login).toBeDisabled();
  reachable = true;
  fireEvent.click(screen.getByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.unreachable')}` }));
  await waitFor(() => expect(login).toBeEnabled());
  expect(screen.getByRole('button', { name: `${t('login.proxy.retry')}: ${t('login.proxy.reachable')}` })).toHaveAttribute('title', `http://proxy.test:3359 · ${t('login.proxy.reachable')} (5 ms)`);
  expect(invoke.mock.calls).toHaveLength(2);
});
