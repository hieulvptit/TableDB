import { setDbRuntimeConfig } from '../features/tabledb/runtimeConfig';
import { TEST_DB_CONFIG } from './dbConfig';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { WS_PREFIX, reloadWorkspaceForTests } from '../features/tabledb/workspace';

import { setLocale } from '../i18n';

// Existing feature tests assert Vietnamese copy; the product default (English) is covered in i18n.test.ts.
setLocale('vi');
try { localStorage.setItem('tabledb.locale', 'vi'); } catch { /* no storage */ } // survives vi.resetModules() re-imports of the i18n module
setDbRuntimeConfig(TEST_DB_CONFIG);
reloadWorkspaceForTests();

afterEach(() => {
  cleanup();
  // editor tabs / history / snippets persisted by one test must not leak into the next
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(WS_PREFIX)) localStorage.removeItem(k); } catch { /* no storage */ }
  setDbRuntimeConfig(TEST_DB_CONFIG);
reloadWorkspaceForTests();
});

if (!globalThis.requestAnimationFrame) {
  (globalThis as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0) as unknown as number;
}
if (typeof window !== 'undefined' && !window.CSS?.escape) {
  (window as unknown as { CSS: { escape: (s: string) => string } }).CSS = { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
}
// jsdom lacks these; CodeMirror touches them
if (typeof document !== 'undefined') {
  const r = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Range.prototype.getBoundingClientRect ??= r;
  Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
}
