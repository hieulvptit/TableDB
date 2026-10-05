import { describe, expect, it } from 'vitest';
import type { DbTarget } from '../../api/types';
import { buildSessionRequest } from './connect';
import { filterCatalog, profileFromTarget, ProxyRequiredError } from './catalog';
import { profilesForCatalog, type LocalProfile } from './profiles';

const raw = (o: Record<string, unknown> = {}) => ({ id: 't1', name: 'PG UAT', driver: 'postgresql', host: 'db.uat', port: 5432, database: 'app', allowWrite: false, authModes: ['password'], ...o });
const tgt = (o: Partial<DbTarget> = {}): DbTarget => filterCatalog([raw(o as Record<string, unknown>)])[0]!;

describe('filterCatalog (the desktop offers only usable admin-defined targets)', () => {
  it('accepts a bare array or an envelope and sorts by name', () => {
    expect(filterCatalog({ targets: [raw({ id: 'b', name: 'B' }), raw({ id: 'a', name: 'A' })] }).map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('drops unknown drivers, incomplete/invalid host or port, duplicate ids and junk entries', () => {
    const out = filterCatalog([
      raw({ id: 'ok' }), raw({ id: 'mysql', driver: 'mysql' }), raw({ id: 'nohost', host: '' }), raw({ id: 'badport', port: 70000 }),
      raw({ id: 'ok' }), raw({ id: 'noname', name: ' ' }), null, 'x', { id: 5 },
    ]);
    expect(out.map((x) => x.id)).toEqual(['ok']);
  });
  it('keeps only valid auth modes (Trino SSO only for trino) and drops targets left with none', () => {
    expect(tgt({ authModes: ['password', 'trino-external'] } as never).authModes).toEqual(['password']);
    expect(tgt({ id: 'tr', driver: 'trino', authModes: ['trino-external', 'weird'] } as never).authModes).toEqual(['trino-external']);
    expect(filterCatalog([raw({ authModes: ['weird'] })])).toEqual([]);
    expect(tgt({ authModes: undefined } as never).authModes).toEqual(['password']);
  });
  it('allowWrite is true only for a literal true; proxy only when well-formed', () => {
    expect(tgt({ allowWrite: 'yes' } as never).allowWrite).toBe(false);
    expect(tgt({ allowWrite: true } as never).allowWrite).toBe(true);
    expect(tgt({ proxy: { type: 'http', host: 'p', port: 8080 } } as never).proxy).toEqual({ type: 'http', host: 'p', port: 8080 });
    expect(tgt({ proxy: { type: 'ftp', host: 'p', port: 8080 } } as never).proxy).toBeNull();
  });
  it('local saved profiles only apply to targets still in the catalog with the saved auth mode', () => {
    const cat = [tgt({ id: 'a' }), tgt({ id: 'tr', driver: 'trino', authModes: ['password', 'trino-external'] } as never)];
    const p = (o: Partial<LocalProfile>): LocalProfile => ({ id: 'p', targetId: 'a', name: 'n', authType: 'password', savePassword: false, ...o });
    const list = [p({ id: '1' }), p({ id: '2', targetId: 'gone' }), p({ id: '3', targetId: 'a', authType: 'trino-external' }), p({ id: '4', targetId: 'tr', authType: 'trino-external' })];
    expect(profilesForCatalog(list, cat).map((x) => x.id)).toEqual(['1', '4']);
  });
});

describe('profileFromTarget / buildSessionRequest (settings come only from the catalog)', () => {
  it('uses catalog host/port/db/proxy/options; write needs db:write AND target.allowWrite', () => {
    const t = tgt({ allowWrite: true, requiresProxy: true, proxy: { type: 'socks', host: 'px', port: 1080 }, options: { ssl: false, connectTimeoutSec: 20 } } as never);
    expect(profileFromTarget(t, { canWrite: true })).toEqual({ driver: 'postgresql', host: 'db.uat', port: 5432, database: 'app', options: { ssl: false, readOnly: true, allowWrite: true, connectTimeoutSec: 20, proxy: { type: 'socks', host: 'px', port: 1080 } } });
    expect(profileFromTarget(t, { canWrite: false }).options?.allowWrite).toBe(false);          // no db:write
    expect(profileFromTarget(tgt({ allowWrite: false }), { canWrite: true }).options?.allowWrite).toBe(false); // target read-only
  });
  it('defaults to TLS on; refuses to connect directly when the catalog says a proxy is required but gives none', () => {
    expect(profileFromTarget(tgt(), { canWrite: false }).options?.ssl).toBe(true);
    expect(() => profileFromTarget(tgt({ requiresProxy: true } as never), { canWrite: false })).toThrow(ProxyRequiredError);
  });
  it('user credentials go only into auth; Trino SSO carries no password and a longer SSO timeout', () => {
    const r = buildSessionRequest({ target: tgt(), authType: 'password', username: 'u', password: 'p', schema: 's', canWrite: false });
    expect(r.auth).toEqual({ type: 'password', username: 'u', password: 'p' });
    expect(JSON.stringify(r.profile)).not.toContain('"p"');
    expect(r.schema).toBe('s');
    const sso = buildSessionRequest({ target: tgt({ id: 'x', driver: 'trino', authModes: ['trino-external'] } as never), authType: 'trino-external', password: 'ignored', canWrite: false });
    expect(sso.auth).toEqual({ type: 'trino-external' });
    expect(sso.profile.options?.externalAuthTimeoutSec).toBe(180);
  });
});
