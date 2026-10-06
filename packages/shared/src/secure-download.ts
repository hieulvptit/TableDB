/** Delegate an authenticated streaming download to a service worker navigation. */
export async function startSecureDownload(workerUrl: string, baseUrl: string, serverPublicKey: string, path: string): Promise<void> {
  if (!navigator.serviceWorker) throw new Error('Encrypted downloads require service workers and HTTPS');
  const registration = await navigator.serviceWorker.register(workerUrl, { type: 'module' });
  const worker = registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) throw new Error('Download worker unavailable');
  if (worker.state !== 'activated') await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('Download worker activation timed out')); }, 15000);
    function changed() { if (worker!.state === 'activated') { clearTimeout(timer); worker!.removeEventListener('statechange', changed); resolve(); } else if (worker!.state === 'redundant') { clearTimeout(timer); reject(new Error('Download worker failed')); } }
    worker.addEventListener('statechange', changed); changed();
  });
  const channel = new MessageChannel();
  const target = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('Download worker timed out')); }, 15000);
    channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); if (typeof event.data?.url === 'string') resolve(event.data.url); else reject(new Error('Download worker rejected request')); };
    worker.postMessage({ type: 'tabledb-download', baseUrl: new URL(baseUrl, location.href).href, serverPublicKey, path }, [channel.port2]);
  });
  const url = new URL(target);
  if (url.origin !== location.origin || !url.href.startsWith(registration.scope)) throw new Error('Unexpected download worker URL');
  window.location.assign(url.href);
}
