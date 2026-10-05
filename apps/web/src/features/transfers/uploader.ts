import { ApiError } from '../../api/errors';
import { readSlice, sha256Hex, type ByteSource } from './hash';

/** Part numbering used by PUT /transfers/:id/parts/:n. API doc does not say; 1-based (S3-style) is assumed. */
export const PART_BASE = Number(import.meta.env?.VITE_PART_BASE ?? 1);

export interface UploadApi {
  putPart(ticketId: string, n: number, data: Uint8Array, sha256: string, signal?: AbortSignal): Promise<void>;
  received(ticketId: string): Promise<{ receivedParts: number[]; totalParts: number }>;
  complete(ticketId: string, idempotencyKey: string): Promise<unknown>;
  abort(ticketId: string): Promise<unknown>;
}

export interface UploadProgress { uploadedBytes: number; totalBytes: number; donePartCount: number; totalParts: number }
export interface UploadOptions {
  source: ByteSource;
  ticketId: string;
  partBytes: number;
  totalParts: number;
  /** parts the server already has (resume) */
  received?: Iterable<number>;
  parallelism?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isRetryable(e: unknown): boolean {
  if (e instanceof ApiError) {
    if (e.code === 'NETWORK' || e.code === 'RATE_LIMITED' || e.code === 'UPSTREAM') return true;
    return e.status >= 500;
  }
  return false; // reading/hash errors and CONFLICT/VALIDATION/FORBIDDEN/STEPUP are fatal
}

export function partRange(n: number, partBytes: number, size: number): [number, number] {
  const i = n - PART_BASE;
  return [i * partBytes, Math.min((i + 1) * partBytes, size)];
}

export function expectedParts(size: number, partBytes: number): number { return Math.max(1, Math.ceil(size / partBytes)); }

/**
 * Upload the missing parts with bounded parallelism (default 3) and per-part retry with exponential backoff.
 * Parts already listed in `received` are skipped (resume). Rejects on the first fatal error and stops the other workers.
 */
export async function uploadParts(o: UploadOptions, api: UploadApi): Promise<void> {
  const { source, ticketId, partBytes, totalParts } = o;
  const parallelism = Math.max(1, o.parallelism ?? 3);
  const maxRetries = o.maxRetries ?? 3;
  const base = o.retryBaseMs ?? 500;
  const sleep = o.sleep ?? defaultSleep;
  const done = new Set(o.received ?? []);
  const todo: number[] = [];
  for (let i = 0; i < totalParts; i++) { const n = i + PART_BASE; if (!done.has(n)) todo.push(n); }

  let uploadedBytes = 0;
  for (const n of done) { const [a, b] = partRange(n, partBytes, source.size); if (b > a) uploadedBytes += b - a; }
  const report = () => o.onProgress?.({ uploadedBytes, totalBytes: source.size, donePartCount: done.size, totalParts });
  report();

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  o.signal?.addEventListener('abort', onAbort);
  let failure: unknown = null;
  let next = 0;

  const sendOne = async (n: number) => {
    const [a, b] = partRange(n, partBytes, source.size);
    const data = await readSlice(source, a, b);
    const digest = sha256Hex(data);
    for (let attempt = 0; ; attempt++) {
      if (ctrl.signal.aborted) throw new ApiError('ABORTED', 'upload aborted', 0);
      try {
        await api.putPart(ticketId, n, data, digest, ctrl.signal);
        return b - a;
      } catch (e) {
        if (ctrl.signal.aborted) throw new ApiError('ABORTED', 'upload aborted', 0);
        if (!isRetryable(e) || attempt >= maxRetries) throw e;
        await sleep(base * 2 ** attempt + Math.floor(Math.random() * base));
      }
    }
  };

  const worker = async () => {
    while (!failure && !ctrl.signal.aborted) {
      const n = todo[next++];
      if (n === undefined) return;
      try {
        const bytes = await sendOne(n);
        done.add(n);
        uploadedBytes += bytes;
        report();
      } catch (e) {
        failure ??= e;
        ctrl.abort();
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(parallelism, todo.length) }, worker));
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
  }
  if (o.signal?.aborted && !failure) throw new ApiError('ABORTED', 'upload aborted', 0);
  if (failure) throw failure;
}

/** Resume: ask the server which parts it already has, then upload only the rest and complete. */
export async function resumeUpload(o: Omit<UploadOptions, 'received' | 'totalParts'> & { idempotencyKey: string }, api: UploadApi): Promise<unknown> {
  const { receivedParts, totalParts } = await api.received(o.ticketId);
  await uploadParts({ ...o, received: receivedParts, totalParts }, api);
  return api.complete(o.ticketId, o.idempotencyKey);
}
