/** Build target of this bundle (`VITE_TARGET=web|desktop`, default web). The two targets share one codebase but not one bundle. */
export type Target = 'web' | 'desktop';
export const TARGET: Target = import.meta.env.VITE_TARGET === 'desktop' ? 'desktop' : 'web';
export const IS_DESKTOP_BUILD = TARGET === 'desktop';
