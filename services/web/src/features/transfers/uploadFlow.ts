import { ApiError } from '../../api/errors';
import type { UploadInitResult } from '../../api/types';
import { uid } from '../../lib';
import { sha256Source, type ByteSource } from './hash';
import { uploadParts, resumeUpload, expectedParts, type UploadApi, type UploadProgress } from './uploader';

export type UploadPhase = 'hashing' | 'creating' | 'uploading' | 'completing' | 'done';
export interface FlowDeps {
  upload: UploadApi;
  create: (b: { fileName: string; size: number; sha256: string; purpose: string; approverId: string }) => Promise<UploadInitResult>;
}
export interface FlowInput {
  file: ByteSource & { name: string };
  purpose: string;
  approverId: string;
  onPhase?: (p: UploadPhase) => void;
  onHashProgress?: (done: number, total: number) => void;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
  /** state kept between attempts so "retry" resumes instead of restarting */
  state?: { sha256?: string; ticketId?: string; partBytes?: number; totalParts?: number; idempotencyKey?: string };
  parallelism?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** hash -> create ticket -> upload parts (resumes when state.ticketId is set) -> complete. Returns the ticket id. */
export async function runUpload(inp: FlowInput, deps: FlowDeps): Promise<string> {
  const st = (inp.state ??= {});
  if (!st.sha256) {
    inp.onPhase?.('hashing');
    st.sha256 = await sha256Source(inp.file, { onProgress: inp.onHashProgress, signal: inp.signal });
  }
  if (!st.ticketId) {
    inp.onPhase?.('creating');
    const r = await deps.create({ fileName: inp.file.name, size: inp.file.size, sha256: st.sha256, purpose: inp.purpose, approverId: inp.approverId });
    st.ticketId = r.ticket.id; st.partBytes = r.partBytes; st.totalParts = r.totalParts;
    if (expectedParts(inp.file.size, r.partBytes) !== r.totalParts) throw new ApiError('VALIDATION', 'server totalParts does not match file size / partBytes', 0);
  }
  st.idempotencyKey ??= uid();
  inp.onPhase?.('uploading');
  await resumeUploadFlow(inp, st as Required<Pick<typeof st, 'ticketId' | 'partBytes' | 'totalParts' | 'idempotencyKey'>>, deps.upload);
  inp.onPhase?.('done');
  return st.ticketId;
}

async function resumeUploadFlow(inp: FlowInput, st: { ticketId: string; partBytes: number; idempotencyKey: string }, api: UploadApi) {
  // Always ask the server what it has (cheap, and makes retry == resume).
  await resumeUpload({
    source: inp.file, ticketId: st.ticketId, partBytes: st.partBytes, idempotencyKey: st.idempotencyKey,
    parallelism: inp.parallelism, maxRetries: inp.maxRetries, onProgress: inp.onProgress, signal: inp.signal, retryBaseMs: inp.retryBaseMs, sleep: inp.sleep,
  }, { ...api, complete: async (id, key) => { inp.onPhase?.('completing'); return api.complete(id, key); } });
}

export { uploadParts };
