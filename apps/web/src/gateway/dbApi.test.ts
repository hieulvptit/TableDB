import { describe, expect, it, vi } from 'vitest';
import { DbApi } from './dbApi';
import { GatewayError, type DbGateway } from './types';

const lost = () => new GatewayError('E_NOT_FOUND', 'unknown session');

function gw(rpc: DbGateway['rpc']) { return { rpc: vi.fn(rpc) } as unknown as DbGateway & { rpc: ReturnType<typeof vi.fn> }; }

describe('DbApi reconnect', () => {
  it('reopens a lost session once and retries the call on the new one', async () => {
    const g = gw(async (sid) => { if (sid === 's1') throw lost(); return { catalogs: ['a'] } as never; });
    const api = new DbApi(g, 's1');
    api.reconnect = vi.fn(async () => 's2');
    expect(await api.catalogs()).toEqual(['a']);
    expect(api.reconnect).toHaveBeenCalledTimes(1);
    expect(api.sessionId).toBe('s2');
    expect(g.rpc.mock.calls.map((c) => c[0])).toEqual(['s1', 's2']);
  });

  it('concurrent failures share one reconnect', async () => {
    const g = gw(async (sid) => { if (sid === 's1') throw lost(); return { schemas: [] } as never; });
    const api = new DbApi(g, 's1');
    api.reconnect = vi.fn(async () => 's2');
    await Promise.all([api.schemas(), api.schemas(), api.schemas()]);
    expect(api.reconnect).toHaveBeenCalledTimes(1);
  });

  it('reports the original error when reconnecting fails, and never retries cursors or commit', async () => {
    const g = gw(async () => { throw lost(); });
    const api = new DbApi(g, 's1');
    api.reconnect = vi.fn(async () => { throw new GatewayError('E_CONN', 'down'); });
    await expect(api.catalogs()).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    (api.reconnect as ReturnType<typeof vi.fn>).mockClear();
    await expect(api.fetch('c1')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await expect(api.commit()).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    expect(api.reconnect).not.toHaveBeenCalled();
  });

  it('other errors pass through untouched', async () => {
    const g = gw(async () => { throw new GatewayError('E_SQL', 'syntax'); });
    const api = new DbApi(g, 's1');
    api.reconnect = vi.fn(async () => 's2');
    await expect(api.execute({ sql: 'x' } as never)).rejects.toMatchObject({ code: 'E_SQL' });
    expect(api.reconnect).not.toHaveBeenCalled();
  });
});
