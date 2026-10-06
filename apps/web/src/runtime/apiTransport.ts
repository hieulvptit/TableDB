import { decodeBase64, encodeBase64 } from '@vnpay/shared';
import { desktopCommands } from './tauri';

let sequence = 0;
/** HTTP for encrypted envelopes, with proxy selection pinned by the native core. */
export function nativeApiFetch(baseUrl: string): typeof fetch {
  const base = new URL(baseUrl.replace(/\/+$/, '') + '/');
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), base);
    const endpoint = url.pathname.slice(base.pathname.length);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || !['secure/handshake', 'secure/request'].includes(endpoint) || url.search || url.hash || url.username || url.password || init.method !== 'POST') {
      throw new Error('Invalid native API envelope');
    }
    init.signal?.throwIfAborted();
    const requestId = `api-${Date.now().toString(36)}-${++sequence}`;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    const body = encodeBase64(new Uint8Array(await new Response(init.body).arrayBuffer()));
    init.signal?.throwIfAborted();
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      init.signal?.removeEventListener('abort', abort);
      void desktopCommands.apiHttpClose(requestId).catch(() => {});
    };
    const abort = () => { controller?.error(new DOMException('Aborted', 'AbortError')); close(); };
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      const head = await desktopCommands.apiHttpStart(requestId, endpoint.slice('secure/'.length), headers, body);
      // An abort may overtake IPC before native start registered the request.
      if (closed) void desktopCommands.apiHttpClose(requestId).catch(() => {});
      init.signal?.throwIfAborted();
      const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull(value) {
          if (closed) return;
          try {
            const bytes = await desktopCommands.apiHttpRead(requestId);
            if (closed) return;
            if (bytes === null) { value.close(); close(); }
            else value.enqueue(decodeBase64(bytes));
          } catch (error) { if (!closed) { value.error(error); close(); } }
        },
        cancel() { close(); },
      });
      return new Response(stream, { status: head.status, headers: { 'Content-Type': head.contentType } });
    } catch (error) { close(); throw error; }
  }) as typeof fetch;
}
