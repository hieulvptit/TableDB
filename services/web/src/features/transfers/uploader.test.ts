import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { sha256Hex, sha256Source, type ByteSlice, type ByteSource } from './hash';
import { PART_BASE, partRange, resumeUpload, uploadParts, type UploadApi } from './uploader';
import { runUpload } from './uploadFlow';

class MemSource implements ByteSource {
  reads: Array<[number, number]> = [];
  constructor(readonly data: Uint8Array) {}
  get size() { return this.data.length; }
  slice(a: number, b: number): ByteSlice { this.reads.push([a, b]); const part = this.data.slice(a, b); return { arrayBuffer: async () => part.buffer as ArrayBuffer }; }
}
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
const nodeSha = (u: Uint8Array) => createHash('sha256').update(u).digest('hex');
const noSleep = async () => {};

function fakeApi(over: Partial<UploadApi> = {}) {
  const stored = new Map<number, string>();
  let inflight = 0, maxInflight = 0;
  const api: UploadApi = {
    putPart: vi.fn(async (_id, n, data, sha) => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      expect(sha).toBe(nodeSha(data)); // per-part hash header matches the bytes sent
      stored.set(n, sha);
    }),
    received: vi.fn(async () => ({ receivedParts: [...stored.keys()], totalParts: 0 })),
    complete: vi.fn(async () => ({ ok: true })),
    abort: vi.fn(async () => ({})),
    ...over,
  };
  return { api, stored, maxInflight: () => maxInflight };
}

describe('sha256Source (incremental)', () => {
  it('matches node crypto across multiple chunks without reading the file at once', async () => {
    const src = new MemSource(bytes(10_000));
    const h = await sha256Source(src, { chunkBytes: 1024 });
    expect(h).toBe(nodeSha(src.data));
    expect(src.reads.length).toBe(10);
    expect(Math.max(...src.reads.map(([a, b]) => b - a))).toBeLessThanOrEqual(1024);
  });
  it('handles empty input and reports progress', async () => {
    expect(await sha256Source(new MemSource(new Uint8Array()))).toBe(nodeSha(new Uint8Array()));
    const p = vi.fn();
    await sha256Source(new MemSource(bytes(2500)), { chunkBytes: 1000, onProgress: p });
    expect(p).toHaveBeenLastCalledWith(2500, 2500);
  });
  it('aborts', async () => {
    const c = new AbortController(); c.abort();
    await expect(sha256Source(new MemSource(bytes(10)), { signal: c.signal })).rejects.toThrow();
  });
});

describe('uploadParts', () => {
  it('uploads every part once, max 3 in parallel, and reports progress to 100%', async () => {
    const src = new MemSource(bytes(10 * 100 + 37)); // 11 parts, last one short
    const { api, stored, maxInflight } = fakeApi();
    const prog = vi.fn();
    await uploadParts({ source: src, ticketId: 't', partBytes: 100, totalParts: 11, onProgress: prog, sleep: noSleep }, api);
    expect([...stored.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 11 }, (_, i) => i + PART_BASE));
    expect(maxInflight()).toBe(3);
    expect(prog).toHaveBeenLastCalledWith(expect.objectContaining({ uploadedBytes: 1037, totalBytes: 1037, donePartCount: 11 }));
  });

  it('partRange handles the short last part', () => {
    expect(partRange(PART_BASE + 10, 100, 1037)).toEqual([1000, 1037]);
  });

  it('resume: skips parts the server already has', async () => {
    const src = new MemSource(bytes(500));
    const { api, stored } = fakeApi();
    await uploadParts({ source: src, ticketId: 't', partBytes: 100, totalParts: 5, received: [PART_BASE, PART_BASE + 1, PART_BASE + 4], sleep: noSleep }, api);
    expect([...stored.keys()].sort()).toEqual([PART_BASE + 2, PART_BASE + 3]);
    expect(api.putPart).toHaveBeenCalledTimes(2);
  });

  it('retries a failing part (network / 5xx / 429) with backoff, then succeeds', async () => {
    const src = new MemSource(bytes(300));
    const sleep = vi.fn(async () => {});
    let fails = 0;
    const { api, stored } = fakeApi();
    const inner = api.putPart as ReturnType<typeof vi.fn>;
    (api as { putPart: UploadApi['putPart'] }).putPart = async (id, n, d, s, sig) => {
      if (n === PART_BASE + 1 && fails < 2) { fails++; throw fails === 1 ? new ApiError('NETWORK', 'reset', 0) : new ApiError('UPSTREAM', 'bad gw', 502); }
      return inner(id, n, d, s, sig);
    };
    await uploadParts({ source: src, ticketId: 't', partBytes: 100, totalParts: 3, sleep, retryBaseMs: 10 }, api);
    expect(stored.size).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries', async () => {
    const src = new MemSource(bytes(100));
    const putPart = vi.fn(async () => { throw new ApiError('NETWORK', 'down', 0); });
    await expect(uploadParts({ source: src, ticketId: 't', partBytes: 100, totalParts: 1, maxRetries: 2, sleep: noSleep }, fakeApi({ putPart }).api)).rejects.toMatchObject({ code: 'NETWORK' });
    expect(putPart).toHaveBeenCalledTimes(3);
  });

  it('does not retry 409 (different hash for same part) and stops other workers', async () => {
    const src = new MemSource(bytes(1000));
    const putPart = vi.fn(async (_i: string, n: number) => { if (n === PART_BASE) throw new ApiError('CONFLICT', 'hash differs', 409); await new Promise((r) => setTimeout(r, 20)); });
    await expect(uploadParts({ source: src, ticketId: 't', partBytes: 100, totalParts: 10, sleep: noSleep }, fakeApi({ putPart }).api)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(putPart.mock.calls.length).toBeLessThan(10);
    expect(putPart.mock.calls.filter((c) => c[1] === PART_BASE)).toHaveLength(1);
  });

  it('abort signal stops the upload', async () => {
    const src = new MemSource(bytes(1000));
    const c = new AbortController();
    const putPart = vi.fn(async () => { c.abort(); await new Promise((r) => setTimeout(r, 5)); });
    await expect(uploadParts({ source: src, ticketId: 't', partBytes: 100, totalParts: 10, signal: c.signal, sleep: noSleep }, fakeApi({ putPart }).api)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(putPart.mock.calls.length).toBeLessThan(10);
  });
});

describe('resumeUpload / runUpload', () => {
  it('resume asks the server for receivedParts, uploads only missing ones, then completes with the idempotency key', async () => {
    const src = new MemSource(bytes(400));
    const { api, stored } = fakeApi({ received: vi.fn(async () => ({ receivedParts: [PART_BASE, PART_BASE + 3], totalParts: 4 })) });
    await resumeUpload({ source: src, ticketId: 't', partBytes: 100, idempotencyKey: 'K1', sleep: noSleep }, api);
    expect([...stored.keys()].sort()).toEqual([PART_BASE + 1, PART_BASE + 2]);
    expect(api.complete).toHaveBeenCalledWith('t', 'K1');
  });

  it('hash -> create -> upload -> complete; retry after failure resumes (no re-hash, no new ticket, same idempotency key)', async () => {
    const data = bytes(350);
    const src = Object.assign(new MemSource(data), { name: 'a.csv' });
    const created: unknown[] = [];
    const { api, stored } = fakeApi();
    let failOnce = true;
    const put = api.putPart as ReturnType<typeof vi.fn>;
    (api as { putPart: UploadApi['putPart'] }).putPart = async (...a) => { if (failOnce && a[1] === PART_BASE + 3) { failOnce = false; throw new ApiError('VALIDATION', 'nope', 400); } return put(...a); };
    (api as { received: UploadApi['received'] }).received = async () => ({ receivedParts: [...stored.keys()], totalParts: 4 });
    const deps = { upload: api, create: vi.fn(async (b: { sha256: string }) => { created.push(b); return { ticket: { id: 'T1' } as never, partBytes: 100, totalParts: 4 }; }) };
    const state = {} as NonNullable<Parameters<typeof runUpload>[0]['state']>;
    const base = { file: src, purpose: 'purpose text', approverId: 'y', state, sleep: noSleep, parallelism: 1 };
    await expect(runUpload(base, deps)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(state.sha256).toBe(nodeSha(data));
    const readsAfterFirst = src.reads.length;
    const id = await runUpload(base, deps);
    expect(id).toBe('T1');
    expect(deps.create).toHaveBeenCalledTimes(1);
    expect((created[0] as { sha256: string }).sha256).toBe(nodeSha(data));
    expect(stored.size).toBe(4);
    // second run only re-read the missing part(s), not the whole file for hashing
    expect(src.reads.length - readsAfterFirst).toBeLessThanOrEqual(2);
    expect(api.complete).toHaveBeenCalledTimes(1);
  });

  it('sha256Hex helper equals node crypto', () => { expect(sha256Hex(bytes(64))).toBe(nodeSha(bytes(64))); });
});
