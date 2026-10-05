import { describe, it, expect, vi, beforeEach } from 'vitest';

const vault = new Map<string, string>();
const calls = { get: 0, set: 0, del: 0 };
let delay = 0;
vi.mock('./tauri', () => ({
  desktopCommands: {
    secretGet: vi.fn(async (k: string) => { calls.get++; if (delay) await new Promise((r) => setTimeout(r, delay)); return vault.get(k) ?? null; }),
    secretSet: vi.fn(async (k: string, v: string) => { calls.set++; vault.set(k, v); }),
    secretDelete: vi.fn(async (k: string) => { calls.del++; vault.delete(k); }),
  },
}));

import { SecretTokenStore } from './secretTokenStore';

beforeEach(() => { vault.clear(); calls.get = calls.set = calls.del = 0; delay = 0; });

describe('SecretTokenStore (desktop credential manager)', () => {
  it('uses exactly ONE credential item and ONE read even when many callers load concurrently', async () => {
    const a = new SecretTokenStore();
    await a.save({ accessToken: 'acc', refreshToken: 'ref', expiresAt: 123 });
    expect([...vault.keys()]).toEqual(['auth.session']);
    expect(calls.set).toBe(1);

    const b = new SecretTokenStore(); // a fresh start of the app
    delay = 20;
    const results = await Promise.all([b.load(), b.load(), b.load(), b.load()]);
    expect(calls.get).toBe(1);
    for (const r of results) expect(r).toEqual({ accessToken: 'acc', refreshToken: 'ref', expiresAt: 123 });
    await b.load();
    expect(calls.get).toBe(1); // served from memory afterwards
  });

  it('returns null when nothing is stored, and caches that too', async () => {
    const s = new SecretTokenStore();
    expect(await s.load()).toBeNull();
    expect(await s.load()).toBeNull();
    expect(calls.get).toBe(1);
  });

  it('treats a corrupt or incomplete item as signed out instead of throwing', async () => {
    for (const bad of ['not json', '{}', '{"a":""}', 'null', '[]']) {
      vault.set('auth.session', bad);
      expect(await new SecretTokenStore().load(), bad).toBeNull();
    }
  });

  it('clear() deletes the single item and forgets the cache; a later save works', async () => {
    const s = new SecretTokenStore();
    await s.save({ accessToken: 'a', refreshToken: '', expiresAt: 1 });
    await s.clear();
    expect(vault.size).toBe(0);
    expect(calls.del).toBe(1);
    expect(await s.load()).toBeNull();
    await s.save({ accessToken: 'b', refreshToken: 'r', expiresAt: 2 });
    expect(await new SecretTokenStore().load()).toEqual({ accessToken: 'b', refreshToken: 'r', expiresAt: 2 });
  });

  it('a value large enough for a real session stays well under the 1200-char credential limit', async () => {
    const s = new SecretTokenStore();
    await s.save({ accessToken: 'x'.repeat(64), refreshToken: 'y'.repeat(64), expiresAt: Date.now() });
    expect(vault.get('auth.session')!.length).toBeLessThan(400);
  });
});
