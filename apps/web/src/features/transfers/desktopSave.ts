import { ApiError } from '../../api/errors';
import { apiClient } from '../../api/client';
import { transfersApi } from '../../api/services';
import type { TicketView } from '../../api/types';
import { desktopCommands } from '../../runtime/tauri';

export interface SaveBridge {
  begin: typeof desktopCommands.transferSaveBegin;
  chunk: typeof desktopCommands.transferSaveChunk;
  finish: typeof desktopCommands.transferSaveFinish;
  abort: typeof desktopCommands.transferSaveAbort;
}
const defaultBridge: SaveBridge = {
  begin: (p) => desktopCommands.transferSaveBegin(p),
  chunk: (h, b) => desktopCommands.transferSaveChunk(h, b),
  finish: (h) => desktopCommands.transferSaveFinish(h),
  abort: (h) => desktopCommands.transferSaveAbort(h),
};

const CHUNK = 4 * 1024 * 1024;

/**
 * Desktop download of an approved office → jump ticket. Order matters: the save dialog opens first, so cancelling it does not
 * spend one of the ticket's downloads; then the one-time token is fetched and the body is streamed (bearer auth) to Rust in
 * chunks. Rust checks size + SHA-256 before the file appears under the chosen name. Returns the saved file name, or null if cancelled.
 */
export async function saveTicketToDisk(tk: TicketView, onProgress?: (done: number, total: number) => void, bridge: SaveBridge = defaultBridge): Promise<string | null> {
  let handle: string;
  try { handle = await bridge.begin({ fileName: tk.fileName, size: tk.size, sha256: tk.sha256 }); }
  catch (e) { if ((e as { code?: string }).code === 'E_CANCELLED') return null; throw e; }
  try {
    const { url } = await transfersApi.downloadToken(tk.id);
    // only path + token are trusted; the request goes through apiClient (its base URL, bearer)
    const u = new URL(url, 'http://placeholder');
    const token = u.searchParams.get('t');
    if (!u.pathname.endsWith(`/transfers/${tk.id}/download`) || !token) throw new ApiError('VALIDATION', 'unexpected download URL', 0);
    const res = await apiClient.request<Response>('GET', `/transfers/${encodeURIComponent(tk.id)}/download`, { query: { t: token }, raw: true, headers: { Accept: 'application/octet-stream' } });
    const sum = res.headers.get('x-content-sha256');
    if (sum && sum !== tk.sha256) throw new ApiError('VALIDATION', 'server sent a different file than the approved one', 0);
    if (!res.body) throw new ApiError('NETWORK', 'empty response', 0);
    const reader = res.body.getReader();
    const buf = new Uint8Array(CHUNK);
    let fill = 0, done = 0;
    const flush = async () => { if (fill) { await bridge.chunk(handle, buf.slice(0, fill)); done += fill; fill = 0; onProgress?.(done, tk.size); } };
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      let v = r.value;
      while (v.length) {
        const n = Math.min(v.length, CHUNK - fill);
        buf.set(v.subarray(0, n), fill); fill += n; v = v.subarray(n);
        if (fill === CHUNK) await flush();
      }
    }
    await flush();
    return await bridge.finish(handle);
  } catch (e) {
    await bridge.abort(handle).catch(() => {});
    throw e;
  }
}
