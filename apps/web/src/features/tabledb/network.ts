import type { GatewayError, NetworkSpec, ProxySpec, SshHopSpec } from '../../gateway/types';
import { toGatewayError } from '../../gateway/errors';
import { HOST_RE } from './custom';

/**
 * "Advanced connection" settings: reach a database the user's machine cannot reach directly, through an HTTP/SOCKS5
 * proxy and/or a chain of SSH servers (bastion/jump hosts). Pure functions so they can be tested without a DOM; the
 * sidecar re-validates everything and pins each SSH host key (docs/SIDECAR-PROTOCOL.md "Tunnels").
 */

export type ProxyType = 'http' | 'socks';
export type SshAuthType = 'password' | 'publicKey';
export const MAX_HOPS = 4;
export const DEFAULT_DB_PROXY = { type: 'http' as const, host: '10.23.5.189', port: 3359, username: 'de_team' };
export const HOST_KEY_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

export interface ProxyForm { useDefault?: boolean; type: ProxyType; host: string; port: string; username: string; password: string }
export interface HopForm {
  host: string; port: string; username: string; authType: SshAuthType;
  password: string; keyId: string; passphrase: string;
  /** pinned server key fingerprint (SHA256:…), filled after the user confirmed it once */
  hostKey: string;
}
export interface NetworkForm { useProxy: boolean; proxy: ProxyForm; useSsh: boolean; hops: HopForm[]; keepAliveSec: string }

export const emptyHop = (): HopForm => ({ host: '', port: '22', username: '', authType: 'password', password: '', keyId: '', passphrase: '', hostKey: '' });
export const emptyNetwork = (): NetworkForm => ({
  useProxy: false, proxy: { type: 'socks', host: '', port: '1080', username: '', password: '' },
  useSsh: false, hops: [emptyHop()], keepAliveSec: '30',
});

export const isNetworkActive = (n: NetworkForm | undefined) => !!n && (n.useProxy || n.useSsh);

export type NetworkIssue =
  | 'proxy.host' | 'proxy.port' | 'proxy.username'
  | `hop.${number}.host` | `hop.${number}.port` | `hop.${number}.username` | `hop.${number}.keyId` | `hop.${number}.hostKey`
  | 'hops.count' | 'keepAlive';

const validPort = (s: string) => { const n = Number(s); return Number.isInteger(n) && n >= 1 && n <= 65535; };
const printable = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

/** @param proxyFromCatalog the admin catalog already fixes the proxy: the user's proxy fields are ignored */
export function validateNetwork(n: NetworkForm, proxyFromCatalog = false): NetworkIssue[] {
  const out: NetworkIssue[] = [];
  if (n.useProxy && !proxyFromCatalog && !n.proxy.useDefault) {
    if (!HOST_RE.test(n.proxy.host.trim())) out.push('proxy.host');
    if (!validPort(n.proxy.port)) out.push('proxy.port');
    if (n.proxy.password && !n.proxy.username.trim()) out.push('proxy.username');
    if (n.proxy.username.length > 255 || !printable(n.proxy.username)) out.push('proxy.username');
  }
  if (n.useSsh) {
    if (n.hops.length < 1 || n.hops.length > MAX_HOPS) out.push('hops.count');
    n.hops.slice(0, MAX_HOPS).forEach((h, i) => {
      if (!HOST_RE.test(h.host.trim())) out.push(`hop.${i}.host`);
      if (!validPort(h.port)) out.push(`hop.${i}.port`);
      const u = h.username.trim();
      if (!u || u.length > 128 || !printable(u)) out.push(`hop.${i}.username`);
      if (h.authType === 'publicKey' && !/^[A-Za-z0-9_-]{1,64}$/.test(h.keyId)) out.push(`hop.${i}.keyId`);
      if (h.hostKey && !HOST_KEY_RE.test(h.hostKey)) out.push(`hop.${i}.hostKey`);
    });
    const ka = Number(n.keepAliveSec);
    if (!Number.isInteger(ka) || ka < 0 || ka > 600) out.push('keepAlive');
  }
  return out;
}

/** Sidecar `ssh` + `options.proxy` for the form (secrets included: this goes straight to the local sidecar). */
export function buildNetwork(n: NetworkForm | undefined, proxyFromCatalog = false): NetworkSpec | undefined {
  if (!isNetworkActive(n)) return undefined;
  const f = n!;
  const out: NetworkSpec = {};
  if (f.useProxy && !proxyFromCatalog) {
    const u = f.proxy.username.trim();
    const proxy: ProxySpec = { type: f.proxy.type, host: f.proxy.host.trim(), port: Number(f.proxy.port) };
    if (u) { proxy.username = u; proxy.password = f.proxy.password; }
    out.proxy = f.proxy.useDefault ? { ...DEFAULT_DB_PROXY, useDefault: true } : proxy;
  }
  if (f.useSsh && f.hops.length > 0) {
    out.ssh = {
      keepAliveSec: Number(f.keepAliveSec),
      hops: f.hops.slice(0, MAX_HOPS).map((h): SshHopSpec => ({
        host: h.host.trim(), port: Number(h.port), username: h.username.trim(),
        auth: h.authType === 'publicKey'
          ? { type: 'publicKey', keyId: h.keyId, ...(h.passphrase ? { passphrase: h.passphrase } : {}) }
          : { type: 'password', password: h.password },
        ...(h.hostKey ? { hostKey: h.hostKey } : {}),
      })),
    };
  }
  return out.proxy || out.ssh ? out : undefined;
}

// ---- persistence: non-secret fields in localStorage, secrets (one JSON item) in the OS credential store ----

export interface NetworkProfileFields {
  useProxy: boolean; proxy: { useDefault?: boolean; type: ProxyType; host: string; port: string; username: string };
  useSsh: boolean; hops: Array<Omit<HopForm, 'password' | 'passphrase'>>; keepAliveSec: string;
}
export interface NetworkSecrets { proxy?: string; hops: Array<{ password?: string; passphrase?: string }> }

const s = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

/** Whitelist copy without secrets (safe for localStorage). */
export function networkFields(n: NetworkForm | NetworkProfileFields): NetworkProfileFields {
  const hops = (Array.isArray(n.hops) ? n.hops : []).slice(0, MAX_HOPS);
  return {
    useProxy: n.useProxy === true,
    proxy: { ...(n.proxy?.useDefault ? { useDefault: true } : {}), type: n.proxy?.type === 'http' ? 'http' : 'socks', host: s(n.proxy?.host), port: s(n.proxy?.port, '1080'), username: s(n.proxy?.username) },
    useSsh: n.useSsh === true,
    hops: hops.map((h) => ({
      host: s(h?.host), port: s(h?.port, '22'), username: s(h?.username), authType: h?.authType === 'publicKey' ? 'publicKey' : 'password',
      keyId: s(h?.keyId), hostKey: HOST_KEY_RE.test(s(h?.hostKey)) ? s(h?.hostKey) : '',
    })),
    keepAliveSec: s(n.keepAliveSec, '30'),
  };
}

export function networkSecrets(n: NetworkForm): NetworkSecrets | null {
  const hops = n.hops.map((h) => ({ ...(h.authType === 'password' && h.password ? { password: h.password } : {}), ...(h.authType === 'publicKey' && h.passphrase ? { passphrase: h.passphrase } : {}) }));
  const proxy = n.useProxy && !n.proxy.useDefault && n.proxy.password ? n.proxy.password : undefined;
  if (!proxy && !hops.some((h) => h.password || h.passphrase)) return null;
  return { ...(proxy ? { proxy } : {}), hops };
}

export function restoreNetwork(fields: NetworkProfileFields | undefined, secrets: NetworkSecrets | null): NetworkForm {
  const base = emptyNetwork();
  if (!fields) return base;
  const f = networkFields(fields);
  const hops = f.hops.length > 0 ? f.hops : [{ ...emptyHop() }];
  return {
    useProxy: f.useProxy, proxy: { ...f.proxy, password: s(secrets?.proxy) },
    useSsh: f.useSsh, keepAliveSec: f.keepAliveSec,
    hops: hops.map((h, i) => ({ ...emptyHop(), ...h, password: s(secrets?.hops?.[i]?.password), passphrase: s(secrets?.hops?.[i]?.passphrase) })),
  };
}

export function parseNetworkSecrets(raw: string | null): NetworkSecrets | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as NetworkSecrets;
    return v && typeof v === 'object' ? { ...(typeof v.proxy === 'string' ? { proxy: v.proxy } : {}), hops: Array.isArray(v.hops) ? v.hops.slice(0, MAX_HOPS) : [] } : null;
  } catch { return null; }
}

// ---- SSH host key confirmation (trust on first use) ----

export interface HostKeyPrompt { hop: number; host: string; port: number; keyType: string; fingerprint: string; reason: 'unknown' | 'mismatch'; expected?: string }

/** The structured part of an E_SSH_HOSTKEY error, or null for any other error. */
export function hostKeyPrompt(e: unknown): HostKeyPrompt | null {
  const g: GatewayError = toGatewayError(e);
  if (g.code !== 'E_SSH_HOSTKEY' || !g.details) return null;
  const d = g.details;
  const fp = typeof d.fingerprint === 'string' ? d.fingerprint : '';
  if (!HOST_KEY_RE.test(fp) || typeof d.hop !== 'number') return null;
  return {
    hop: d.hop, host: String(d.host ?? ''), port: Number(d.port ?? 22), keyType: String(d.keyType ?? '?'), fingerprint: fp,
    reason: d.reason === 'mismatch' ? 'mismatch' : 'unknown', ...(typeof d.expected === 'string' ? { expected: d.expected } : {}),
  };
}

/** Pin the confirmed key on the hop the sidecar reported. */
export function pinHostKey(n: NetworkForm, hop: number, fingerprint: string): NetworkForm {
  if (!HOST_KEY_RE.test(fingerprint) || hop < 0 || hop >= n.hops.length) return n;
  return { ...n, hops: n.hops.map((h, i) => (i === hop ? { ...h, hostKey: fingerprint } : h)) };
}

/** Short description for badges/audit, e.g. `SSH bastion:22 → jump:22` or `SOCKS5 px:1080`. Never includes credentials. */
export function routeLabel(n: NetworkForm | NetworkProfileFields | undefined, proxyFromCatalog?: { type: ProxyType; host: string; port: number } | null): string {
  if (!n || !(n.useProxy || n.useSsh)) return '';
  const parts: string[] = [];
  const px = proxyFromCatalog ?? (n.useProxy ? (n.proxy.useDefault ? DEFAULT_DB_PROXY : { type: n.proxy.type, host: n.proxy.host.trim(), port: n.proxy.port }) : null);
  if (px) parts.push(`${px.type === 'socks' ? 'SOCKS5' : 'HTTP'} ${px.host}:${px.port}`);
  if (n.useSsh) parts.push(`SSH ${n.hops.map((h) => `${h.host.trim()}:${h.port}`).join(' → ')}`);
  return parts.join(' → ');
}
