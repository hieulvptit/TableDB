import { TEST_DB_CONFIG } from '../../test/dbConfig';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@vnpay/ui';
import { apiClient } from '../../api/client';
import { AuthContext, type AuthState } from '../../auth/AuthContext';
import TableDbPage from './TableDbPage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const perms = ['db:connect', 'db:custom', 'db:write', 'agent:use'];
const auth = (p: string[]): AuthState => ({
  status: 'authenticated', can: (x) => p.includes(x), refresh: async () => {}, logout: async () => {},
  me: { user: { id: 'u', email: 'e@x', name: 'E', roles: ['user'], permissions: p as never }, csrfToken: 'csrf', authTime: 0, kind: 'web' },
});

let sidecar: Array<{ method: string; params: Record<string, unknown> }>;
let audits: Array<Record<string, unknown>>;
beforeEach(() => {
  sidecar = []; audits = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'driver_list') return { drivers: [{ id: 'mysql8', name: 'MySQL 8', className: 'com.mysql.cj.jdbc.Driver', urlTemplate: 'jdbc:mysql://{host}:{port}/{database}', defaultPort: 3306, files: [{ file: 'a.jar', sha256: 'x' }], loaded: true }] };
      if (cmd !== 'sidecar_request') return null;
      const { method, params } = args as { method: string; params: Record<string, unknown> };
      sidecar.push({ method, params });
      if (method === 'session.open') return { sessionId: 's9', serverVersion: 'Oracle 19', user: 'SCOTT', readOnly: true };
      if (method === 'meta.catalogs') return { catalogs: [] };
      if (method === 'meta.schemas') return { schemas: [] };
      return {};
    },
  };
  apiClient.configure({ desktop: false, baseUrl: '/api/v1', onStepUp: undefined, fetchImpl: (async (url: string, init: RequestInit) => {
    if (url.endsWith('/db/config')) return json(TEST_DB_CONFIG);
    if (url.endsWith('/db/targets')) return json([{ id: 't1', name: 'PG UAT', driver: 'postgresql', host: 'h', port: 5432, allowWrite: false, authModes: ['password'] }]);
    if (url.endsWith('/db/audit')) { audits.push(JSON.parse(init.body as string)); return json({ ok: true }, 201); }
    return json({ error: { code: 'NOT_FOUND', message: 'unmocked ' + url } }, 404);
  }) as unknown as typeof fetch });
  apiClient.setCsrfToken('csrf');
});
afterEach(() => { vi.restoreAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

const page = (a: AuthState) => render(<AuthContext.Provider value={a}><ToastProvider><MemoryRouter><TableDbPage /></MemoryRouter></ToastProvider></AuthContext.Provider>);

describe('custom connection mode', () => {
  it('pasting an HTTPS Trino URL selects port 443 and TLS', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    page(auth(perms));
    expect(await screen.findByLabelText('Loại cơ sở dữ liệu / driver')).toHaveValue('trino');
    await user.type(screen.getByLabelText('Dán nhanh địa chỉ'), 'https://query-engine-staging.vnpayapi.vn');
    expect(screen.getByLabelText('Dùng SSL/TLS')).toBeChecked();
    await user.type(screen.getByLabelText('Tên đăng nhập'), 'tester');
    await user.click(screen.getAllByRole('button', { name: 'Kết nối' }).at(-1)!);
    await waitFor(() => expect(sidecar.find(x => x.method === 'session.open')?.params).toMatchObject({
      profile: { driver: 'trino', host: 'query-engine-staging.vnpayapi.vn', port: 443, options: { ssl: true } },
    }));
  });
  it('enables TLS for Trino SSO and connects through the built-in proxy marker', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    page(auth(perms));
    expect(await screen.findByLabelText('Loại cơ sở dữ liệu / driver')).toHaveValue('trino');
    await user.type(await screen.findByLabelText('Máy chủ (IP hoặc hostname)'), 'trino.internal');
    await user.click(screen.getByLabelText('Trino SSO'));
    expect(screen.getByLabelText('Dùng SSL/TLS')).toBeChecked();
    expect(screen.getByLabelText('Dùng SSL/TLS')).toBeDisabled();
    await user.click(screen.getByLabelText('Qua proxy'));
    await user.click(screen.getByLabelText('Sử dụng proxy mặc định (de_team)'));
    expect(screen.queryByLabelText('Mật khẩu proxy')).toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Kết nối' }).at(-1)!);
    await waitFor(() => expect(sidecar.find(x => x.method === 'session.open')?.params).toMatchObject({
      profile: { driver: 'trino', auth: { type: 'trino-external' }, options: { ssl: true, proxy: { useDefault: true, type: 'http', host: '10.23.5.189', port: 3359, username: 'de_team' } } },
    }));
  });
  it('has no mode tabs and no profile-name field; a successful connect is saved automatically and the menu offers reconnect/rename/export', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    page(auth(perms));
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByLabelText('Tên hồ sơ')).toBeNull();
    await user.selectOptions(await screen.findByLabelText('Loại cơ sở dữ liệu / driver'), 'oracle');
    await user.type(await screen.findByLabelText('Dán nhanh địa chỉ'), 'ora.internal:1521/BISVC');
    await user.type(screen.getByLabelText('Tên đăng nhập'), 'scott');
    await user.type(screen.getByLabelText('Mật khẩu'), 'tiger');
    await user.click(screen.getAllByRole('button', { name: 'Kết nối' }).at(-1)!);
    await user.click(await screen.findByRole('button', { name: 'Kết nối mới' }));
    const item = await within(await screen.findByRole('listbox', { name: 'Kết nối đã lưu' })).findByRole('option', { name: /scott@ora\.internal:1521\/BISVC/ });
    await user.pointer({ keys: '[MouseRight]', target: item });
    for (const name of ['Kết nối', 'Kết nối lại', 'Ngắt kết nối', 'Chỉnh sửa', 'Đổi tên', 'Nhân bản', 'Xuất kết nối này…', 'Xóa'])
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Đổi tên' }));
    const input = screen.getByLabelText('Đổi tên');
    await user.clear(input); await user.type(input, 'Oracle UAT{Enter}');
    expect(await within(screen.getByRole('listbox', { name: 'Kết nối đã lưu' })).findByRole('option', { name: /Oracle UAT/ })).toBeInTheDocument();
  });

  it('paste -> fields -> session.open with serviceName, read-only, audit carries custom endpoint (no targetId)', async () => {
    const user = userEvent.setup();
    page(auth(perms));
    await user.selectOptions(await screen.findByLabelText('Loại cơ sở dữ liệu / driver'), 'oracle');
    await user.type((await screen.findByLabelText('Dán nhanh địa chỉ')), 'ora.internal:1521/BISVC');
    expect((await screen.findByLabelText('Máy chủ (IP hoặc hostname)'))).toHaveValue('ora.internal');
    expect(screen.getByLabelText('Cổng')).toHaveValue('1521');
    expect(screen.getByLabelText('Giá trị Service name')).toHaveValue('BISVC');
    await user.type(screen.getByLabelText('Tên đăng nhập'), 'scott');
    await user.type(screen.getByLabelText('Mật khẩu'), 'tiger');
    await user.click(screen.getAllByRole('button', { name: 'Kết nối' }).at(-1)!);
    const open = await waitFor(() => { const c = sidecar.find((x) => x.method === 'session.open'); expect(c).toBeTruthy(); return c!; });
    expect(open.params).toEqual({ profile: { driver: 'oracle', host: 'ora.internal', port: 1521, database: 'BISVC', auth: { type: 'password', username: 'scott', password: 'tiger' },
      options: { connectType: 'serviceName', ssl: false, readOnly: true, allowWrite: false, connectTimeoutSec: 15 } } });
    await waitFor(() => expect(audits.find((a) => a.event === 'open')).toEqual({
      custom: { driver: 'oracle', host: 'ora.internal', port: 1521, database: 'BISVC', connectType: 'serviceName', allowWrite: false }, event: 'open', authType: 'password',
    }));
    expect(audits.every((a) => !('targetId' in a))).toBe(true);
  });

  it('offers imported drivers and sends driverId', async () => {
    const user = userEvent.setup();
    page(auth(perms));
    await user.selectOptions(await screen.findByLabelText('Loại cơ sở dữ liệu / driver'), 'custom:mysql8');
    expect(screen.getByLabelText('Cổng')).toHaveValue('3306');
    await user.type((await screen.findByLabelText('Máy chủ (IP hoặc hostname)')), 'my.internal');
    await user.type(screen.getByLabelText('Tên đăng nhập'), 'root');
    await user.click(screen.getAllByRole('button', { name: 'Kết nối' }).at(-1)!);
    const open = await waitFor(() => { const c = sidecar.find((x) => x.method === 'session.open'); expect(c).toBeTruthy(); return c!; });
    expect(open.params).toMatchObject({ profile: { driver: 'custom', driverId: 'mysql8', host: 'my.internal', port: 3306 } });
  });

  it('blocks invalid input client-side (no sidecar call)', async () => {
    const user = userEvent.setup();
    page(auth(perms));
    await user.type((await screen.findByLabelText('Máy chủ (IP hoặc hostname)')), 'bad/host');
    await user.click(screen.getAllByRole('button', { name: 'Kết nối' }).at(-1)!);
    expect(await screen.findByText(/Máy chủ không hợp lệ/)).toBeInTheDocument();
    expect(sidecar.some((c) => c.method === 'session.open')).toBe(false);
  });
});
