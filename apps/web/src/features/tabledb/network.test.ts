import { describe, expect, it } from 'vitest';
import { GatewayError } from '../../gateway/types';
import { toGatewayError } from '../../gateway/errors';
import { TauriGateway } from '../../gateway/TauriGateway';
import { buildSessionRequest } from './connect';
import { emptyCustomForm } from './custom';
import {
  buildNetwork, emptyHop, emptyNetwork, hostKeyPrompt, networkFields, networkSecrets, parseNetworkSecrets, pinHostKey, restoreNetwork, routeLabel, validateNetwork,
  type NetworkForm,
} from './network';

const FP = 'SHA256:' + 'a'.repeat(43);
const sshForm = (): NetworkForm => ({
  ...emptyNetwork(), useSsh: true,
  hops: [
    { ...emptyHop(), host: 'bastion.vnpay.vn', username: 'ops', password: 'ssh-Pw-1', hostKey: FP },
    { ...emptyHop(), host: '10.0.0.5', port: '2222', username: 'ops', authType: 'publicKey', keyId: 'k0123', passphrase: 'pp-1' },
  ],
});

describe('network settings', () => {
  it('uses the built-in proxy marker without exposing or persisting its password', () => {
    const n = { ...emptyNetwork(), useProxy: true };
    n.proxy = { ...n.proxy, useDefault: true, password: 'old-custom-password' };
    expect(validateNetwork(n)).toEqual([]);
    expect(buildNetwork(n)?.proxy).toEqual({ useDefault: true, type: 'http', host: '10.23.5.189', port: 3359, username: 'de_team' });
    expect(networkSecrets(n)).toBeNull();
    const restored = restoreNetwork(networkFields(n), null);
    expect(restored.proxy.useDefault).toBe(true);
    expect(routeLabel(restored)).toBe('HTTP 10.23.5.189:3359');
  });
  it('validates proxy and hops', () => {
    expect(validateNetwork(emptyNetwork())).toEqual([]);
    const n = { ...emptyNetwork(), useProxy: true, proxy: { type: 'socks' as const, host: 'a/b', port: '0', username: '', password: 'x' } };
    expect(validateNetwork(n)).toEqual(['proxy.host', 'proxy.port', 'proxy.username']);
    expect(validateNetwork(n, true)).toEqual([]); // a catalog proxy replaces the user proxy fields
    const s = sshForm();
    expect(validateNetwork(s)).toEqual([]);
    s.hops[1] = { ...s.hops[1]!, keyId: '', username: ' ', host: 'x?y', hostKey: 'MD5:zz' };
    expect(validateNetwork(s)).toEqual(['hop.1.host', 'hop.1.username', 'hop.1.keyId', 'hop.1.hostKey']);
    expect(validateNetwork({ ...sshForm(), hops: Array.from({ length: 5 }, emptyHop) })).toContain('hops.count');
  });

  it('builds the sidecar ssh/proxy spec (proxy creds only with a username)', () => {
    expect(buildNetwork(emptyNetwork())).toBeUndefined();
    const n = { ...sshForm(), useProxy: true, proxy: { type: 'http' as const, host: 'px', port: '3128', username: '', password: 'ignored' } };
    expect(buildNetwork(n)).toEqual({
      proxy: { type: 'http', host: 'px', port: 3128 },
      ssh: { keepAliveSec: 30, hops: [
        { host: 'bastion.vnpay.vn', port: 22, username: 'ops', auth: { type: 'password', password: 'ssh-Pw-1' }, hostKey: FP },
        { host: '10.0.0.5', port: 2222, username: 'ops', auth: { type: 'publicKey', keyId: 'k0123', passphrase: 'pp-1' } },
      ] },
    });
    expect(buildNetwork({ ...n, proxy: { ...n.proxy, username: 'u' } })!.proxy).toEqual({ type: 'http', host: 'px', port: 3128, username: 'u', password: 'ignored' });
    expect(buildNetwork(n, true)!.proxy).toBeUndefined();
  });

  it('goes into session.open as profile.ssh + options.proxy', async () => {
    const calls: unknown[] = [];
    const gw = new TauriGateway({ request: async (_m, p) => { calls.push(p); return {}; }, cancel: async () => ({}), listen: async () => () => {} });
    const custom = { ...emptyCustomForm(), host: 'db.internal', port: '5432', driver: 'postgresql' as const, username: 'u', password: 'p',
      network: { ...sshForm(), useProxy: true, proxy: { type: 'socks' as const, host: 'px', port: '1080', username: 'pu', password: 'pp' } } };
    await gw.openSession(buildSessionRequest({ custom, canWrite: false }));
    const body = calls[0] as { profile: Record<string, unknown> & { options: Record<string, unknown> } };
    expect(body.profile.host).toBe('db.internal');
    expect((body.profile.ssh as { hops: unknown[] }).hops).toHaveLength(2);
    expect(body.profile.options.proxy).toEqual({ type: 'socks', host: 'px', port: 1080, username: 'pu', password: 'pp' });
    expect(body.profile.options.readOnly).toBe(true);
  });

  it('splits secrets from what is saved/exported, and restores them', () => {
    const n = { ...sshForm(), useProxy: true, proxy: { type: 'socks' as const, host: 'px', port: '1080', username: 'pu', password: 'px-Pw' } };
    const fields = networkFields(n);
    const text = JSON.stringify(fields);
    for (const secret of ['ssh-Pw-1', 'pp-1', 'px-Pw']) expect(text).not.toContain(secret);
    expect(fields.hops[0]!.hostKey).toBe(FP);
    const sec = networkSecrets(n)!;
    expect(sec).toEqual({ proxy: 'px-Pw', hops: [{ password: 'ssh-Pw-1' }, { passphrase: 'pp-1' }] });
    const back = restoreNetwork(fields, parseNetworkSecrets(JSON.stringify(sec)));
    expect(back).toEqual(n);
    expect(networkSecrets(emptyNetwork())).toBeNull();
    expect(parseNetworkSecrets('not json')).toBeNull();
    // junk in storage is dropped rather than trusted
    expect(networkFields({ ...fields, hops: [{ ...fields.hops[0]!, hostKey: 'evil', authType: 'x' as never }] }).hops[0]).toMatchObject({ hostKey: '', authType: 'password' });
  });

  it('turns E_SSH_HOSTKEY into a prompt and pins the confirmed key on that hop', () => {
    const raw = { code: 'E_SSH_HOSTKEY', message: 'unknown host key', details: { hop: 1, host: '10.0.0.5', port: 2222, keyType: 'ssh-ed25519', fingerprint: FP, reason: 'unknown' } };
    const g = toGatewayError(raw);
    expect(g).toBeInstanceOf(GatewayError);
    const p = hostKeyPrompt(raw)!;
    expect(p).toEqual({ hop: 1, host: '10.0.0.5', port: 2222, keyType: 'ssh-ed25519', fingerprint: FP, reason: 'unknown' });
    const pinned = pinHostKey(sshForm(), p.hop, p.fingerprint);
    expect(pinned.hops[1]!.hostKey).toBe(FP);
    expect(pinHostKey(sshForm(), 7, FP)).toEqual(sshForm());
    expect(hostKeyPrompt({ code: 'E_CONN', message: 'x' })).toBeNull();
    expect(hostKeyPrompt({ code: 'E_SSH_HOSTKEY', message: 'x', details: { hop: 0, fingerprint: 'nope' } })).toBeNull();
    expect(hostKeyPrompt({ ...raw, details: { ...raw.details, reason: 'mismatch', expected: FP } })!.reason).toBe('mismatch');
  });

  it('describes the route without credentials', () => {
    const n = { ...sshForm(), useProxy: true, proxy: { type: 'socks' as const, host: 'px', port: '1080', username: 'pu', password: 'px-Pw' } };
    expect(routeLabel(n)).toBe('SOCKS5 px:1080 → SSH bastion.vnpay.vn:22 → 10.0.0.5:2222');
    expect(routeLabel(emptyNetwork())).toBe('');
  });
});
