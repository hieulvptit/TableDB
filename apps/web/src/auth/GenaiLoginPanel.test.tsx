import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@vnpay/ui';
import { t } from '../i18n';
import GenaiLoginPanel from './GenaiLoginPanel';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

it('saves proxy credentials only through the vault and clears the password field', async () => {
  const invoke = vi.fn(async (command: string) => command === 'app_info' ? { genaiProxyUrl: 'http://proxy.test:3359' } : undefined);
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
