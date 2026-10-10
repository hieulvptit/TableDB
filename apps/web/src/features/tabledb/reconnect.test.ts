import { describe, expect, it, vi } from 'vitest';
import { GatewayError, type DbGateway } from '../../gateway/types';
import { openConnection } from './connect';
import { emptyCustomForm } from './custom';
import { desktopCommands } from '../../runtime/tauri';

/** fake sidecar whose sessions can be reaped */
function sidecar() {
  const alive = new Set<string>();
  let n = 0;
  const gw = {
    kind: 'tauri',
    openSession: vi.fn(async () => { const id = `s${++n}`; alive.add(id); return { sessionId: id, serverVersion: '16', user: 'u', readOnly: true, schema: 'public', autoCommit: true }; }),
    closeSession: vi.fn(async (id: string) => { alive.delete(id); }),
    rpc: vi.fn(async (sid: string, method: string, params?: Record<string, unknown>) => {
      if (!alive.has(sid)) throw new GatewayError('E_NOT_FOUND', 'unknown session');
      if (method === 'session.setSchema') return { schema: params?.schema };
      return { catalogs: ['db'] };
    }),
    subscribe: vi.fn(() => () => {}), subscribePending: vi.fn(() => () => {}),
  };
  return { gw: gw as unknown as DbGateway, raw: gw, reap: () => alive.clear() };
}
const form = () => ({ ...emptyCustomForm(), driver: 'postgresql' as const, host: 'db.local', port: '5432', username: 'u', password: 'p' });
const audit = { report: vi.fn() };

describe('openConnection: automatic reconnect', () => {
  it.each([true, false])('opens SSO once when native browserHandled=%s', async (handled) => {
    const sc = sidecar();
    const opened = vi.spyOn(desktopCommands, 'openExternal').mockResolvedValue(undefined);
    const onSsoUrl = vi.fn();
    sc.gw.subscribePending = (cb) => {
      cb({ event: 'auth.openUrl', seq: 1, data: { url: 'https://s2o.vnpay.vn/login', browserHandled: handled } });
      return () => {};
    };
    await openConnection({ custom: { ...emptyCustomForm(), host: 'query-engine-staging.vnpayapi.vn', port: '443', ssl: true, sso: true }, canWrite: false }, { onSsoUrl }, sc.gw, audit);
    expect(onSsoUrl).toHaveBeenCalledWith('https://s2o.vnpay.vn/login');
    expect(opened).toHaveBeenCalledTimes(handled ? 0 : 1);
    opened.mockRestore();
  });
  it('a reaped session is reopened (same schema) and the call succeeds', async () => {
    const sc = sidecar();
    const conn = await openConnection({ custom: form(), canWrite: false }, undefined, sc.gw, audit);
    conn.currentSchema = 'sales';
    sc.reap();
    expect(await conn.api.catalogs()).toEqual(['db']);
    expect(sc.raw.openSession).toHaveBeenCalledTimes(2);
    expect(conn.api.sessionId).toBe('s2');
    expect(conn.id).toBe('s1');
    expect(conn.currentSchema).toBe('sales');
    expect(sc.raw.rpc).toHaveBeenCalledWith('s2', 'session.setSchema', { schema: 'sales' });
  });

  it('manual-commit sessions are not silently reopened', async () => {
    const sc = sidecar();
    const conn = await openConnection({ custom: form(), canWrite: true }, undefined, sc.gw, audit);
    conn.tx = { autoCommit: false, pending: true };
    sc.reap();
    await expect(conn.api.catalogs()).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    expect(sc.raw.openSession).toHaveBeenCalledTimes(1);
  });
});
