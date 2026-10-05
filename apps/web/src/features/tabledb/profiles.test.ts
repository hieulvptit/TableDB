import { beforeEach, describe, expect, it, vi } from 'vitest';

const secrets = new Map<string, string>();
vi.mock('../../runtime/tauri', () => ({
  desktopCommands: {
    secretSet: vi.fn(async (k: string, v: string) => { secrets.set(k, v); }),
    secretGet: vi.fn(async (k: string) => secrets.get(k) ?? null),
    secretDelete: vi.fn(async (k: string) => { secrets.delete(k); }),
  },
}));

import { CUSTOM_TARGET, dedupeLocalProfiles, findSameProfile, importLocalProfiles, loadLocalProfiles, loadOpenProfileIds, saveLocalProfile, saveOpenProfileIds, secretKeyFor, type CustomProfileFields, type LocalProfile } from './profiles';

const custom = (o: Partial<CustomProfileFields> = {}): CustomProfileFields => ({
  driver: 'postgresql', host: 'db.local', port: '5432', connectType: 'serviceName', database: 'app', ssl: false, connectTimeoutSec: '15', props: [], allowWrite: false, ...o,
});
const prof = (id: string, o: Partial<LocalProfile> = {}, c: Partial<CustomProfileFields> = {}): LocalProfile =>
  ({ id, targetId: CUSTOM_TARGET, name: 'u@db.local:5432/app', authType: 'password', username: 'u', savePassword: true, custom: custom(c), ...o });

beforeEach(() => { localStorage.clear(); secrets.clear(); });

describe('saved connection duplicates', () => {
  it('same driver/endpoint/db/user is the same connection (host case, port format and spaces ignored)', () => {
    const list = [prof('a')];
    expect(findSameProfile(list, prof('b', { username: ' u ' }, { host: 'DB.Local', port: '05432' }))?.id).toBe('a');
    expect(findSameProfile(list, prof('b', {}, { database: 'other' }))).toBeUndefined();
    expect(findSameProfile(list, prof('b', { username: 'v' }))).toBeUndefined();
    expect(findSameProfile(list, prof('b', {}, { driver: 'trino' }))).toBeUndefined();
    expect(findSameProfile(list, prof('a'))).toBeUndefined();
  });

  it('import skips connections that are already saved or repeated in the file', async () => {
    await saveLocalProfile(prof('a'));
    const r = await importLocalProfiles([prof('b'), prof('c', {}, { database: 'x' }), prof('d', {}, { database: 'x' })]);
    expect(r).toEqual({ added: 1, skipped: 2 });
    expect(loadLocalProfiles().map((p) => p.id).sort()).toEqual(['a', 'c']);
  });

  it('merges same-name duplicates, keeps the open one and renamed copies, drops the extra secrets', async () => {
    await saveLocalProfile(prof('a'), 'pw-a');
    await saveLocalProfile(prof('b'), 'pw-b');
    await saveLocalProfile(prof('c'), 'pw-c');
    await saveLocalProfile(prof('copy', { name: 'u@db.local:5432/app (copy)' }), 'pw');
    saveOpenProfileIds(['b']);
    expect(await dedupeLocalProfiles()).toEqual(new Map([['a', 'b'], ['c', 'b']]));
    expect(loadLocalProfiles().map((p) => p.id).sort()).toEqual(['b', 'copy']);
    expect(loadOpenProfileIds()).toEqual(['b']);
    expect(secrets.has(secretKeyFor('a'))).toBe(false);
    expect(secrets.get(secretKeyFor('b'))).toBe('pw-b');
    expect((await dedupeLocalProfiles()).size).toBe(0);
  });
});
