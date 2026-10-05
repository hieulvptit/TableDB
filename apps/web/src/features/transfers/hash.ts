import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/** Anything file-like we can read in slices (File/Blob in the browser; a tiny shim in tests). */
export interface ByteSource {
  readonly size: number;
  slice(start: number, end: number): Blob | ByteSlice;
}
export interface ByteSlice { arrayBuffer(): Promise<ArrayBuffer> }

export async function readSlice(src: ByteSource, start: number, end: number): Promise<Uint8Array> {
  const s = src.slice(start, end) as Blob;
  if (typeof s.arrayBuffer === 'function') return new Uint8Array(await s.arrayBuffer());
  // older WebViews / jsdom
  return new Promise<Uint8Array>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(s);
  });
}

export const sha256Hex = (data: Uint8Array): string => bytesToHex(sha256(data));

export interface HashOptions { chunkBytes?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }

/**
 * Whole-file SHA-256 computed incrementally: the file is read in `chunkBytes` slices (default 4 MiB) and fed to an
 * incremental hasher, so memory stays O(chunk) regardless of file size. Yields to the event loop between chunks.
 */
export async function sha256Source(src: ByteSource, o: HashOptions = {}): Promise<string> {
  const chunk = o.chunkBytes ?? 4 * 1024 * 1024;
  const h = sha256.create();
  for (let off = 0; off < src.size; off += chunk) {
    if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    h.update(await readSlice(src, off, Math.min(off + chunk, src.size)));
    o.onProgress?.(Math.min(off + chunk, src.size), src.size);
    await new Promise((r) => setTimeout(r, 0));
  }
  return bytesToHex(h.digest());
}
