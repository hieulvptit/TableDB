import { createSecureFetch } from './secure-transport.js';
// A minimal worker surface keeps DOM and worker TypeScript projects compatible.
interface Message { data: { type?: string; baseUrl?: string; serverPublicKey?: string; path?: string }; ports: MessagePort[]; source?: { url?: string } | null }
interface FetchEvent { request: Request; respondWith(response: Promise<Response>): void }
interface WorkerSurface { location: Location; registration: { scope: string }; skipWaiting(): Promise<void>; addEventListener(type: string, callback: (event: any) => void): void }
export function installSecureDownloadWorker(scope: WorkerSurface): void {
  const tickets = new Map<string, { fetch: typeof fetch; url: string; expires: number }>();
  scope.addEventListener('install', () => { void scope.skipWaiting(); });
  scope.addEventListener('message', (event: Message) => {
    const d = event.data; const port = event.ports[0]; if (!port || d?.type !== 'tabledb-download') return;
    try {
      if (!event.source?.url || new URL(event.source.url).origin !== scope.location.origin || !d.baseUrl || !d.serverPublicKey || !d.path) throw new Error('Invalid client');
      const base = new URL(d.baseUrl); const apiPath = base.pathname.replace(/\/$/, '');
      if (base.origin !== scope.location.origin || !['/api/v1', '/c/api/v1'].includes(apiPath)) throw new Error('Invalid API');
      const url = new URL(d.path, base.origin); const downloadPath = url.pathname.slice(apiPath.length);
      if (url.origin !== base.origin || !url.pathname.startsWith(`${apiPath}/`) || !/^\/transfers\/[^/]+\/download$/.test(downloadPath) || !url.searchParams.get('t')) throw new Error('Invalid download');
      for (const [key, t] of tickets) if (t.expires < Date.now()) tickets.delete(key);
      if (tickets.size >= 16) throw new Error('Too many downloads');
      const key = crypto.randomUUID(); tickets.set(key, { fetch: createSecureFetch({ baseUrl: base.href, clientKind: 'web', serverPublicKey: d.serverPublicKey }), url: url.href, expires: Date.now() + 60000 });
      port.postMessage({ url: scope.registration.scope + 'tabledb-download/' + key });
    } catch { port.postMessage({ error: true }); }
  });
  scope.addEventListener('fetch', (event: FetchEvent) => {
    const prefix = scope.registration.scope + 'tabledb-download/'; if (!event.request.url.startsWith(prefix)) return;
    event.respondWith((async () => {
      const key = event.request.url.slice(prefix.length); const ticket = tickets.get(key); tickets.delete(key);
      if (!ticket || ticket.expires < Date.now()) return new Response('Download expired. Please try again.', { status: 410 });
      try {
        const response = await ticket.fetch(ticket.url, { signal: event.request.signal });
        if (!response.ok) { await response.body?.cancel(); return new Response('Download rejected. Please try again from TableDB.', { status: response.status }); }
        const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store');
        return new Response(response.body, { status: response.status, headers });
      } catch { return new Response('Encrypted download failed. Please try again.', { status: 502 }); }
    })());
  });
}
