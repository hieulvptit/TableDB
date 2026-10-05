import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

import { setLocale } from '../i18n';

// Existing feature tests assert Vietnamese copy; the product default (English) is covered in i18n.test.ts.
setLocale('vi');
try { localStorage.setItem('tabledb.locale', 'vi'); } catch { /* no storage */ } // survives vi.resetModules() re-imports of the i18n module

afterEach(() => { cleanup(); });

if (!globalThis.requestAnimationFrame) {
  (globalThis as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0) as unknown as number;
}
if (typeof window !== 'undefined' && !window.CSS?.escape) {
  (window as unknown as { CSS: { escape: (s: string) => string } }).CSS = { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
}
