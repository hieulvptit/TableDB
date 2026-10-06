import { describe, expect, it, vi } from 'vitest';
import { TauriGateway, type TauriBridge } from './TauriGateway';
import { createGateway } from './index';
import type { GatewayEvent } from './types';

describe('createGateway', () => {
  it('is always the local sidecar gateway (no HTTP/remote gateway exists)', () => { expect(createGateway().kind).toBe('tauri'); });
});

describe('TauriGateway', () => {
  const mk = () => {
    const calls: Array<[string, unknown]> = [];
    let emit: (e: GatewayEvent) => void = () => {};
    const bridge: TauriBridge = {
      request: vi.fn(async (m, p) => { calls.push([m, p]); return m === 'session.open' ? { sessionId: 's1', serverVersion: 'x', user: 'u', readOnly: true } : { ok: true }; }),
      cancel: vi.fn(async () => ({ cancelled: true })),
      listen: vi.fn(async (h) => { emit = h; return () => {}; }),
    };
    return { gw: new TauriGateway(bridge), bridge, calls, emit: (e: GatewayEvent) => emit(e) };
  };

  it('opens sessions with a sidecar profile (secrets only inside auth, readOnly default true)', async () => {
    const { gw, calls } = mk();
    await gw.openSession({ profile: { driver: 'postgresql', host: 'h', port: 5432, database: 'd' }, auth: { type: 'password', username: 'u', password: 'p' }, schema: 'public' });
    const [method, params] = calls[0]! as [string, { profile: Record<string, unknown> }];
    expect(method).toBe('session.open');
    expect(params.profile).toMatchObject({ driver: 'postgresql', host: 'h', schema: 'public', auth: { type: 'password', password: 'p' }, options: { readOnly: true } });
  });

  it('adds sessionId to session-scoped rpc but not to cursor/cancel methods', async () => {
    const { gw, calls } = mk();
    await gw.rpc('s1', 'meta.tables', { schema: 'a' });
    await gw.rpc('s1', 'query.fetch', { cursorId: 'c1' });
    expect(calls[0]).toEqual(['meta.tables', { sessionId: 's1', schema: 'a' }]);
    expect(calls[1]).toEqual(['query.fetch', { cursorId: 'c1', count: 500 }]);
  });

  it('cancel uses sidecar_cancel', async () => {
    const { gw, bridge } = mk();
    expect(await gw.cancel('s1', 'q1')).toBe(true);
    expect(bridge.cancel).toHaveBeenCalledWith('q1');
  });

  it('routes sidecar events per session and to pending subscribers (Trino SSO url arrives before sessionId is known)', async () => {
    const { gw, emit } = mk();
    const a = vi.fn(), pend = vi.fn();
    gw.subscribe('s1', a);
    gw.subscribePending(pend);
    await Promise.resolve();
    emit({ seq: 1, event: 'auth.openUrl', data: { sessionId: 's1', url: 'https://sso' } });
    emit({ seq: 2, event: 'auth.openUrl', data: { sessionId: 's2', url: 'https://other' } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(pend).toHaveBeenCalledTimes(2);
  });

  it('normalises sidecar errors', async () => {
    const { gw, bridge } = mk();
    (bridge.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ code: 'E_SQL', message: 'boom', sqlState: '42P01' });
    await expect(gw.rpc('s1', 'query.execute', {})).rejects.toMatchObject({ name: 'GatewayError', code: 'E_SQL', sqlState: '42P01' });
  });
});
