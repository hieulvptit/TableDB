import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSecureFetch } from '../src/secure-transport';
let server: ChildProcess;
let keys: { url: string; desktop: string; web: string };
beforeAll(async () => {
 server = spawn('go', ['run', './internal/securetransport/testserver'], { cwd: fileURLToPath(new URL('../../../services/api', import.meta.url)), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
 keys = await new Promise((resolve, reject) => { let output = ''; let err = ''; server.stderr!.on('data', data => { err += String(data); }); server.once('exit', () => reject(new Error(err || 'Test server exited'))); server.stdout!.on('data', data => { output += String(data); if (output.includes('\n')) { try { resolve(JSON.parse(output.split('\n')[0]!)); } catch (e) { reject(e); } } }); });
}, 30000);
afterAll(() => { if (server?.pid) { if (process.platform === 'win32') server.kill(); else process.kill(-server.pid, 'SIGTERM'); } });
function client(kind: 'web' | 'desktop', direct?: typeof fetch, pin?: string) { return createSecureFetch({ baseUrl: keys.url, clientKind: kind, serverPublicKey: pin ?? keys[kind], cryptoImpl: webcrypto as unknown as Crypto, fetchImpl: direct }); }
describe('Go server ↔ WebCrypto clients', () => {
 it.each(['SECURE_SESSION_EXPIRED', 'SECURE_KEY_MISMATCH'])('resets session and retries a rejected request once for %s', async code => {
  let handshakes = 0; let requests = 0; let dispatched = 0;
  const ids: string[] = [];
  const direct: typeof fetch = async (url, init) => {
   if (String(url).endsWith('/handshake')) handshakes++;
   if (String(url).endsWith('/request')) {
    ids.push(new Headers(init?.headers).get('x-tabledb-session')!);
    if (++requests === 1) return Response.json({ error: { code } }, { status: code === 'SECURE_SESSION_EXPIRED' ? 410 : 400 });
    dispatched++;
   }
   return fetch(url, init);
  };
  const f = client('desktop', direct);
  expect(await (await f(keys.url + '/echo', { method: 'POST', body: 'retry-body' })).text()).toBe('retry-body');
  expect(handshakes).toBe(2); expect(dispatched).toBe(1); expect(ids[0]).not.toBe(ids[1]);
 });
 it('limits session recovery to one retry', async () => {
  let requests = 0;
  const direct: typeof fetch = (url, init) => {
   if (String(url).endsWith('/request')) { requests++; return Promise.resolve(Response.json({ error: { code: 'SECURE_KEY_MISMATCH' } }, { status: 400 })); }
   return fetch(url, init);
  };
  await expect(client('desktop', direct)(keys.url + '/echo', { method: 'POST', body: 'test' })).rejects.toMatchObject({ code: 'SECURE_KEY_MISMATCH' });
  expect(requests).toBe(2);
 });
 it('uses canonical encrypted routes behind a /c reverse-proxy mount', async () => {
  const baseUrl = keys.url.replace('/api/v1', '/c/api/v1');
  const endpoints: string[] = [];
  const proxy: typeof fetch = (url, init) => {
   endpoints.push(String(url));
   return fetch(String(url).replace('/c/api/v1/', '/api/v1/'), init);
  };
  const f = createSecureFetch({ baseUrl, clientKind: 'web', serverPublicKey: keys.web, cryptoImpl: webcrypto as unknown as Crypto, fetchImpl: proxy });
  const response = await f(baseUrl + '/echo?value=1', { method: 'POST', body: 'mounted-api' });
  expect(response.headers.get('x-request-path')).toBe('/api/v1/echo?value=1');
  expect(await response.text()).toBe('mounted-api');
  expect(endpoints).toEqual([baseUrl + '/secure/handshake', baseUrl + '/secure/request']);
 });
 it('uses independent web and desktop pins and authenticates encrypted headers/body', async () => {
  for (const kind of ['web', 'desktop'] as const) {
   const f = client(kind); const payload = 'private-data'.repeat(15000);
   const response = await f(keys.url + '/echo', { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' }, body: payload });
   expect(response.headers.get('x-client-kind')).toBe(kind); expect(response.headers.get('x-auth')).toBe('Bearer secret'); expect(await response.text()).toBe(payload);
   expect((await f(keys.url + '/empty')).status).toBe(204);
   const download = await f(keys.url + '/download'); expect((await download.arrayBuffer()).byteLength).toBe(4 * 65536);
  }
 });
 it('rejects the other client signing key and tampered handshake before sending data', async () => {
  await expect(client('web', undefined, keys.desktop)(keys.url + '/echo')).rejects.toThrow();
  await expect(client('desktop', undefined, keys.web)(keys.url + '/echo')).rejects.toThrow();
  const malicious: typeof fetch = async (url, init) => { const r = await fetch(url, init); if (String(url).endsWith('/handshake')) { const w = await r.json(); w.sessionId = 'x'.repeat(32); return Response.json(w); } return r; };
  await expect(client('web', malicious)(keys.url + '/echo')).rejects.toThrow();
 });
 it('rejects replay and truncated/tampered request records without dispatching a mutation', async () => {
  let replay: { url: RequestInfo | URL; init?: RequestInit } | undefined;
  const capture: typeof fetch = async (url, init) => { if (String(url).endsWith('/request')) replay = { url, init }; return fetch(url, init); };
  expect(await (await client('desktop', capture)(keys.url + '/echo', { method: 'POST', body: 'test' })).text()).toBe('test');
  expect((await fetch(replay!.url, replay!.init)).status).toBe(409);
  for (const truncate of [true, false]) {
   const tamper: typeof fetch = async (url, init) => { if (String(url).endsWith('/request')) { const b = new Uint8Array(await new Response(init?.body).arrayBuffer()); if (truncate) return fetch(url, { ...init, body: b.slice(0, b.length - 21) }); b[b.length - 1] = b[b.length - 1]! ^ 1; return fetch(url, { ...init, body: b }); } return fetch(url, init); };
   await expect(client('web', tamper)(keys.url + '/echo', { method: 'POST', body: 'must-not-execute' })).rejects.toThrow();
  }
 });
 it('does not treat a truncated or tampered response as successful EOF', async () => {
  for (const truncate of [true, false]) {
   const tamper: typeof fetch = async (url, init) => { const r = await fetch(url, init); if (!String(url).endsWith('/request')) return r; const b = new Uint8Array(await r.arrayBuffer()); if (!truncate) b[b.length - 1] = b[b.length - 1]! ^ 1; return new Response(truncate ? b.slice(0, b.length - 21) : b, { headers: r.headers }); };
   const r = await client('desktop', tamper)(keys.url + '/echo'); await expect(r.arrayBuffer()).rejects.toThrow();
  }
 });
 it('shares a single handshake and assigns unique concurrent nonces', async () => {
  let handshakes = 0; const direct: typeof fetch = (url, init) => { if (String(url).endsWith('/handshake')) handshakes++; return fetch(url, init); };
  const f = client('web', direct); const result = await Promise.all(Array.from({ length: 20 }, async (_, i) => (await f(keys.url + '/echo', { method: 'POST', body: String(i) })).text()));
  expect(handshakes).toBe(1); expect(result).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
 });
 it('requires encryption and refuses a different origin', async () => {
  expect((await fetch(keys.url + '/echo')).status).toBe(426);
  await expect(client('web')('http://untrusted.invalid/api/v1/echo')).rejects.toThrow();
 });
});
