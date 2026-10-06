import { TEST_DB_CONFIG } from '../../test/dbConfig';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@vnpay/ui';
import { apiClient } from '../../api/client';
import { AuthContext, type AuthState } from '../../auth/AuthContext';
import TableDbPage from './TableDbPage';

const FP = 'SHA256:' + 'Q'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const perms = ['db:connect', 'db:custom', 'agent:use'];
const auth: AuthState = {
  status: 'authenticated', can: (x) => perms.includes(x), refresh: async () => {}, logout: async () => {},
  me: { user: { id: 'u', email: 'e@x', name: 'E', roles: ['user'], permissions: perms as never }, csrfToken: 'csrf', authTime: 0, kind: 'web' },
};

let opens: Array<Record<string, unknown>>;
let audits: Array<Record<string, unknown>>;
let secrets: Map<string, string>;
beforeEach(() => {
  opens = []; audits = []; secrets = new Map();
  localStorage.clear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'ssh_key_list') return { keys: [{ id: 'k1', name: 'id_ed25519', format: 'openssh', encrypted: true, addedAt: 0 }] };
      if (cmd === 'secret_set') { secrets.set(args!.key as string, args!.value as string); return null; }
      if (cmd === 'secret_get') return secrets.get(args!.key as string) ?? null;
      if (cmd === 'secret_delete') { secrets.delete(args!.key as string); return null; }
      if (cmd !== 'sidecar_request') return null;
      const { method, params } = args as { method: string; params: { profile: Record<string, unknown> } };
      if (method === 'session.open') {
        opens.push(params.profile);
        const hop = (params.profile.ssh as { hops: Array<{ hostKey?: string }> } | undefined)?.hops[0];
        if (hop && !hop.hostKey) throw { code: 'E_SSH_HOSTKEY', message: 'unknown host key', retryable: false, details: { hop: 0, host: 'bastion', port: 22, keyType: 'ssh-ed25519', fingerprint: FP, reason: 'unknown' } };
        return { sessionId: 's1', serverVersion: 'PG 16', user: 'app', readOnly: true };
      }
      if (method === 'meta.catalogs') return { catalogs: [] };
      if (method === 'meta.schemas') return { schemas: [] };
      return {};
    },
  };
  apiClient.configure({ desktop: false, baseUrl: '/api/v1', onStepUp: undefined, fetchImpl: (async (url: string, init: RequestInit) => {
    if (url.endsWith('/db/config')) return json(TEST_DB_CONFIG);
    if (url.endsWith('/db/audit')) { audits.push(JSON.parse(init.body as string)); return json({ ok: true }, 201); }
    return json({ error: { code: 'NOT_FOUND', message: 'unmocked ' + url } }, 404);
  }) as unknown as typeof fetch });
  apiClient.setCsrfToken('csrf');
});
afterEach(() => { vi.restoreAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

describe('SSH tunnel connection', () => {
  it('asks to confirm the bastion host key, pins it, connects, audits the route and never stores secrets in localStorage', async () => {
    const user = userEvent.setup();
    render(<AuthContext.Provider value={auth}><ToastProvider><MemoryRouter><TableDbPage /></MemoryRouter></ToastProvider></AuthContext.Provider>);
    await user.selectOptions(await screen.findByLabelText('Loại cơ sở dữ liệu / driver'), 'postgresql');
    await user.type(screen.getByLabelText('Máy chủ (IP hoặc hostname)'), 'db.internal');
    await user.type(screen.getByLabelText('Tên đăng nhập'), 'app');
    await user.type(screen.getByLabelText('Mật khẩu'), 'db-Pw-1');
    await user.click(screen.getByText('Kết nối nâng cao: SSH tunnel / Proxy'));
    await user.click(screen.getByLabelText('Qua SSH tunnel'));
    await user.type(screen.getByLabelText('Máy chủ SSH'), 'bastion');
    await user.type(screen.getByLabelText('Tài khoản SSH'), 'ops');
    await user.type(screen.getByLabelText('Mật khẩu SSH'), 'ssh-Pw-1');
    await user.click(screen.getAllByRole('button', { name: 'Kết nối' }).at(-1)!);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(FP)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Tin cậy và tiếp tục' }));

    await waitFor(() => expect(opens).toHaveLength(2));
    expect(opens[1]!.ssh).toEqual({ keepAliveSec: 30, hops: [{ host: 'bastion', port: 22, username: 'ops', auth: { type: 'password', password: 'ssh-Pw-1' }, hostKey: FP }] });
    await waitFor(() => expect(audits.find((a) => a.event === 'open')).toMatchObject({ route: 'SSH bastion:22' }));
    const failed = audits.find((a) => a.event === 'open_failed');
    expect(failed).toMatchObject({ route: 'SSH bastion:22' });

    const stored = localStorage.getItem('tabledb.localProfiles.v2')!;
    expect(stored).toContain(FP);
    for (const s of ['ssh-Pw-1', 'db-Pw-1']) expect(stored).not.toContain(s);
    const net = [...secrets.entries()].find(([k]) => k.endsWith('.network'));
    expect(JSON.parse(net![1])).toEqual({ hops: [{ password: 'ssh-Pw-1' }] });
  });

  it('shows a changed host key as a warning that needs an explicit acknowledgement', async () => {
    const { HostKeyDialog } = await import('./NetworkSettings');
    const user = userEvent.setup();
    const onTrust = vi.fn();
    render(<HostKeyDialog prompt={{ hop: 0, host: 'bastion', port: 22, keyType: 'ssh-rsa', fingerprint: FP, reason: 'mismatch', expected: 'SHA256:' + 'z'.repeat(43) }} onTrust={onTrust} onCancel={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Thay khóa và tiếp tục' });
    expect(btn).toBeDisabled();
    await user.click(screen.getByLabelText('Tôi đã xác minh khóa mới với quản trị máy chủ'));
    await user.click(btn);
    expect(onTrust).toHaveBeenCalled();
  });
});
