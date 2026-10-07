import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
import { t } from '../i18n';
import { AuthContext, type AuthState } from './AuthContext';
import LoginPage from './LoginPage';

afterEach(() => vi.restoreAllMocks());

const anonymous: AuthState = { status: 'anonymous', me: null, can: () => false, refresh: async () => {}, logout: async () => {} };
function mount() {
  return render(<AuthContext.Provider value={anonymous}><MemoryRouter><LoginPage /></MemoryRouter></AuthContext.Provider>);
}

it('offers only powerbi even when the API returns other providers and dev login', async () => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({
    providers: [{ id: 'vnpaybi', label: 'Other SSO' }, { id: 'powerbi', label: 'Local SSO' }], devLogin: true,
  });
  mount();
  expect(await screen.findByRole('button', { name: t('login.with', { name: 'Local SSO' }) })).toBeEnabled();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('does not fall back to another provider when powerbi is missing', async () => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ providers: [{ id: 'vnpaybi', label: 'Other SSO' }], devLogin: true });
  mount();
  expect(await screen.findByText(t('login.noProviders'))).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});
