import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '@vnpay/ui';
import { AuthContext, type AuthState } from '../../auth/AuthContext';
import TableDbPage from './TableDbPage';

const perms: AuthState['me'] extends infer M ? (M extends { user: { permissions: infer P } } ? P : never) : never = ['db:connect', 'db:custom'];
const auth: AuthState = {
  status: 'authenticated', can: (p) => perms.includes(p), refresh: async () => {}, logout: async () => {},
  me: { user: { id: 'u', email: 'e@x', name: 'E', roles: ['user'], permissions: perms }, csrfToken: 'csrf', authTime: 0, kind: 'web' },
};
const profile = (id: string, name: string, savePassword: boolean) => ({
  id, targetId: 'custom', name, authType: 'password', username: 'alice', savePassword,
  custom: { driver: 'postgresql', host: 'h', port: '5432', connectType: 'serviceName', database: 'app', ssl: false, connectTimeoutSec: '15', props: [], allowWrite: false },
});
let sidecar: string[];
beforeEach(() => {
  sidecar = [];
  localStorage.clear();
  localStorage.setItem('tabledb.localProfiles.v2', JSON.stringify([profile('a', 'Alpha DB', true), profile('b', 'Beta DB', false)]));
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'secret_get') return (args as { key: string }).key === 'db.profile.a.password' ? 'pw' : null;
      if (cmd !== 'sidecar_request') return null;
      const { method } = args as { method: string };
      sidecar.push(method);
      if (method === 'session.open') return { sessionId: 's1', serverVersion: 'PG 16', user: 'alice', readOnly: true };
      if (method === 'session.close') return {};
      if (method === 'meta.catalogs') return { catalogs: [] };
      if (method === 'meta.schemas') return { schemas: ['public'] };
      return {};
    },
  };
});
afterEach(() => { localStorage.clear(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

describe('Navigator: saved connections tree', () => {
  it('lists saved connections while disconnected, connects on double-click, disconnects from the menu', async () => {
    const user = userEvent.setup();
    render(<AuthContext.Provider value={auth}><ToastProvider><MemoryRouter><TableDbPage /></MemoryRouter></ToastProvider></AuthContext.Provider>);
    const alpha = await screen.findByRole('region', { name: 'Alpha DB' });
    expect(screen.getByRole('region', { name: 'Beta DB' })).toBeInTheDocument();
    expect(sidecar).not.toContain('session.open'); // nothing connects on its own
    expect(within(alpha).queryByRole('tree')).toBeNull();

    await user.dblClick(within(alpha).getByText('Alpha DB'));
    await waitFor(() => expect(sidecar).toContain('session.open'));
    expect(await within(alpha).findByRole('treeitem', { name: /public/ })).toBeInTheDocument();

    await user.pointer({ keys: '[MouseRight]', target: within(alpha).getByText('Alpha DB') });
    await user.click(await screen.findByRole('menuitem', { name: 'Ngắt kết nối' }));
    await waitFor(() => expect(within(alpha).queryByRole('tree')).toBeNull());
    expect(screen.getByRole('region', { name: 'Alpha DB' })).toBeInTheDocument(); // still listed, just disconnected
  });

  it('a saved connection without a stored password opens the connection dialog instead of connecting', async () => {
    const user = userEvent.setup();
    render(<AuthContext.Provider value={auth}><ToastProvider><MemoryRouter><TableDbPage /></MemoryRouter></ToastProvider></AuthContext.Provider>);
    const beta = await screen.findByRole('region', { name: 'Beta DB' });
    await user.dblClick(within(beta).getByText('Beta DB'));
    expect(await screen.findByRole('dialog', { name: 'Quản lý kết nối' })).toBeInTheDocument();
    expect(sidecar).not.toContain('session.open');
  });
});
