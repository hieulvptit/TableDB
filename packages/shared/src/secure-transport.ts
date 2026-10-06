/** Versioned streaming AES-256-GCM API transport. Session keys never leave this closure. */
export const SECURE_VERSION = 'tabledb-aes-v1';
const CONTENT_TYPE = 'application/vnd.tabledb.aesgcm';
const FRAME_BYTES = 64 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
export type SecureClientKind = 'desktop' | 'web';
export interface SecureFetchOptions { baseUrl: string; clientKind: SecureClientKind; serverPublicKey: string; fetchImpl?: typeof fetch; cryptoImpl?: Crypto }
interface Welcome { version: string; sessionId: string; publicKey: string; nonce: string; expiresAt: number; signature: string; finished: string }
interface Session { id: string; expiresAt: number; send: CryptoKey; receive: CryptoKey; sequence: bigint }
export const encodeBase64 = (v: Uint8Array): string => { let s = ''; for (const byte of v) s += String.fromCharCode(byte); return btoa(s); };
export const decodeBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), x => x.charCodeAt(0));
const bytes = (v: Uint8Array): ArrayBuffer => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
function nonce(seq: bigint, index: number): Uint8Array { const b = new Uint8Array(12); const view = new DataView(b.buffer); view.setBigUint64(0, seq); view.setUint32(8, index); return b; }
function aad(id: string, seq: bigint, index: number, direction: string): Uint8Array { return enc.encode(`${SECURE_VERSION}|${id}|${seq}|${index}|${direction}`); }
const fail = (): never => { throw new Error('Encrypted API transport validation failed'); };

export function createSecureFetch(o: SecureFetchOptions): typeof fetch {
  const crypto = o.cryptoImpl ?? globalThis.crypto;
  if (!crypto?.subtle || !o.serverPublicKey) throw new Error('Secure API requires WebCrypto and a trusted server public key');
  const direct = o.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const base = new URL(o.baseUrl.replace(/\/+$/, '') + '/', globalThis.location?.href ?? 'http://localhost/');
  const endpoint = (suffix: string) => new URL(suffix, base).href;
  let current: Session | null = null;
  let pending: Promise<Session> | null = null;
  async function handshake(): Promise<Session> {
    const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = encodeBase64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
    const challenge = encodeBase64(crypto.getRandomValues(new Uint8Array(32)));
    const res = await direct(endpoint('secure/handshake'), { method: 'POST', credentials: o.clientKind === 'web' ? 'include' : 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: SECURE_VERSION, clientKind: o.clientKind, publicKey, nonce: challenge }), redirect: 'error' });
    if (!res.ok) throw new Error('Secure API handshake failed');
    const w = await res.json() as Welcome;
    if (w.version !== SECURE_VERSION || !/^[\w-]{32}$/.test(w.sessionId) || !Number.isSafeInteger(w.expiresAt) || w.expiresAt * 1000 <= Date.now() || w.expiresAt * 1000 > Date.now() + 3600000) fail();
    const transcript = enc.encode([SECURE_VERSION, w.sessionId, o.clientKind, publicKey, w.publicKey, challenge, w.nonce, String(w.expiresAt)].join('|'));
    const signing = await crypto.subtle.importKey('raw', bytes(decodeBase64(o.serverPublicKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, signing, bytes(decodeBase64(w.signature)), bytes(transcript))) fail();
    if (decodeBase64(w.nonce).length !== 32) fail();
    const server = await crypto.subtle.importKey('raw', bytes(decodeBase64(w.publicKey)), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: server }, keys.privateKey, 256);
    const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const salt = await crypto.subtle.digest('SHA-256', bytes(transcript));
    const derive = (direction: string, usage: KeyUsage) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: bytes(enc.encode(`${SECURE_VERSION}|${direction}`)) }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
    const [send, receive] = await Promise.all([derive('c2s', 'encrypt'), derive('s2c', 'decrypt')]);
    const finished = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(nonce(0n, 0)), additionalData: bytes(transcript), tagLength: 128 }, receive, bytes(decodeBase64(w.finished)));
    if (dec.decode(finished) !== 'server-finished') fail();
    return { id: w.sessionId, expiresAt: w.expiresAt * 1000, send, receive, sequence: 0n };
  }
  async function session(): Promise<Session> {
    if (current && current.expiresAt - Date.now() > 15000 && current.sequence < (1n << 48n)) return current;
    if (!pending) pending = handshake().then(s => (current = s)).finally(() => { pending = null; });
    return pending;
  }
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (input instanceof Request) throw new Error('Secure fetch requires a URL and explicit request options');
    const url = new URL(String(input), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.pathname.startsWith(base.pathname + 'secure/')) fail();
    const s = await session();
    const seq = ++s.sequence;
    let index = 0;
    const chunks: ArrayBuffer[] = [];
    const append = async (kind: number, payload: Uint8Array) => {
      init.signal?.throwIfAborted();
      const plain = new Uint8Array(payload.length + 1); plain[0] = kind; plain.set(payload, 1);
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytes(nonce(seq, index)), additionalData: bytes(aad(s.id, seq, index++, 'c2s')), tagLength: 128 }, s.send, bytes(plain));
      const prefix = new ArrayBuffer(4); new DataView(prefix).setUint32(0, sealed.byteLength); chunks.push(prefix, sealed);
    };
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { if (!['authorization', 'content-type', 'accept', 'x-csrf-token', 'idempotency-key', 'x-part-sha256'].includes(k)) throw new Error('Unsupported encrypted request header'); headers[k] = v; });
    const method = (init.method ?? 'GET').toUpperCase();
    await append(1, enc.encode(JSON.stringify({ method, path: url.pathname + url.search, headers })));
    if (init.body !== undefined && init.body !== null) {
      const body = new Uint8Array(await new Response(init.body).arrayBuffer());
      for (let i = 0; i < body.length; i += FRAME_BYTES) await append(2, body.subarray(i, i + FRAME_BYTES));
    }
    await append(3, new Uint8Array());
    const response = await direct(endpoint('secure/request'), { method: 'POST', credentials: o.clientKind === 'web' ? 'include' : 'omit', headers: { 'Content-Type': CONTENT_TYPE, 'X-TableDB-Session': s.id, 'X-TableDB-Sequence': String(seq) }, body: new Blob(chunks), signal: init.signal, redirect: 'error' });
    // Never retry a mutation in response to an unauthenticated transport error.
    if (!response.ok || response.headers.get('content-type') !== CONTENT_TYPE || !response.body) { if (current === s) current = null; await response.body?.cancel(); throw new Error('Encrypted API request failed'); }
    const reader = response.body.getReader();
    let buffer = new Uint8Array();
    async function exact(n: number): Promise<Uint8Array> {
      while (buffer.length < n) { const chunk = await reader.read(); if (chunk.done || !chunk.value) return fail(); const joined = new Uint8Array(buffer.length + chunk.value.length); joined.set(buffer); joined.set(chunk.value, buffer.length); buffer = joined; }
      const out = buffer.slice(0, n); buffer = buffer.slice(n); return out;
    }
    let responseIndex = 0;
    async function record(): Promise<Uint8Array> {
      const prefix = await exact(4); const length = new DataView(prefix.buffer).getUint32(0);
      if (length < 17 || length > FRAME_BYTES + 1024 || responseIndex >= 0xffffffff) fail();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(nonce(seq, responseIndex)), additionalData: bytes(aad(s.id, seq, responseIndex++, 's2c')), tagLength: 128 }, s.receive, bytes(await exact(length)));
      return new Uint8Array(plain);
    }
    const first = await record(); if (first[0] !== 1 || first.length > 16385) fail();
    const meta = JSON.parse(dec.decode(first.subarray(1))) as { status: number; headers: Record<string, string[]> };
    const responseHeaders = new Headers();
    for (const [name, values] of Object.entries(meta.headers)) { if (name.toLowerCase() === 'set-cookie') continue; for (const value of values) responseHeaders.append(name, value); }
    const length = responseHeaders.get('content-length');
    const expected = length === null ? null : Number(length);
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) fail();
    let received = 0;
    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const plain = await record(); if (plain[0] === 2 && plain.length > 1) { received += plain.length - 1; if (expected !== null && received > expected) fail(); controller.enqueue(plain.subarray(1)); } else if (plain[0] === 3 && plain.length === 1) { if ((expected !== null && received !== expected) || buffer.length || !(await reader.read()).done) fail(); ended = true; controller.close(); } else fail(); }
        catch (error) { controller.error(error); await reader.cancel(error).catch(() => {}); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    if ([204, 205, 304].includes(meta.status)) { const drain = stream.getReader(); while (!(await drain.read()).done) {} if (!ended) fail(); return new Response(null, { status: meta.status, headers: responseHeaders }); }
    return new Response(stream, { status: meta.status, headers: responseHeaders });
  }) as typeof fetch;
}
