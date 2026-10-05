// English desktop messages (only bundled in the desktop target). Assembled from parts; typecheck enforces key parity with vi.desktop.ts.
import type { viDesktop } from './vi.desktop';
import { enDesktopA } from './en.desktop.a';
import { enDesktopB } from './en.desktop.b';
import { enDesktopC } from './en.desktop.c';

export const enDesktop = { ...enDesktopA, ...enDesktopB, ...enDesktopC } as Record<keyof typeof viDesktop, string>;
