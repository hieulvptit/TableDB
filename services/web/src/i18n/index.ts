// Single i18n module. Add a locale by creating en.*-style dictionaries (same keys) and registering it in LOCALES. Default: English.
import { ApiError } from '../api/errors';
import { viCommon } from './vi.common';
import { viWeb } from './vi.web';
import { enCommon } from './en.common';
import { enWeb } from './en.web';

type Messages = Record<string, string>;

const vi: Messages = { ...viCommon, ...viWeb };
const en: Messages = { ...enCommon, ...enWeb };

export type Locale = 'en' | 'vi';
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_LABELS: Record<Locale, string> = { en: 'English', vi: 'Tiếng Việt' };
const LOCALES: Record<Locale, Messages> = { en, vi };
const BCP47: Record<Locale, string> = { en: 'en-US', vi: 'vi-VN' };
const STORAGE_KEY = 'tabledb.locale';

const isLocale = (v: unknown): v is Locale => v === 'en' || v === 'vi';
function readStored(): Locale {
  try { const v = localStorage.getItem(STORAGE_KEY); if (isLocale(v)) return v; } catch { /* no storage */ }
  return DEFAULT_LOCALE;
}
let current: Locale = readStored();
if (typeof document !== 'undefined') document.documentElement.lang = current;

/** Switch the active locale (not persisted). `t()` is not reactive: callers re-render the whole tree (see `changeLocale`). */
export function setLocale(l: Locale) {
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}
export function getLocale(): Locale { return current; }
/** BCP-47 tag of the active locale, for Intl / toLocale*String. */
export function intlLocale(): string { return BCP47[current]; }
/** Persist the choice and reload so every already-rendered string is re-resolved. */
export function changeLocale(l: Locale) {
  try { localStorage.setItem(STORAGE_KEY, l); } catch { /* no storage */ }
  setLocale(l);
  if (typeof window !== 'undefined') window.location.reload();
}

/** t('key', {n: 3}) — `{n}` placeholders. Unknown keys return the key (visible in UI, caught by i18n.test). */
export function t(key: string, vars?: Record<string, string | number>): string {
  const msg = LOCALES[current][key] ?? LOCALES.en[key] ?? key;
  return vars ? msg.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`)) : msg;
}

const CODE_MSG: Record<string, string> = {
  FORBIDDEN: 'err.FORBIDDEN', UNAUTHENTICATED: 'err.UNAUTHENTICATED', NOT_FOUND: 'err.NOT_FOUND', RATE_LIMITED: 'err.RATE_LIMITED',
  UPSTREAM: 'err.UPSTREAM', INTERNAL: 'err.INTERNAL', STEPUP_REQUIRED: 'err.STEPUP_REQUIRED', NETWORK: 'err.NETWORK', CONFLICT: 'err.CONFLICT',
  INSUFFICIENT_STORAGE: 'err.INSUFFICIENT_STORAGE',
};

/** User-facing message for any thrown value. VALIDATION/CONFLICT keep the server's (specific) message. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const generic = CODE_MSG[e.code];
    if (e.code === 'VALIDATION') return e.message ? `${t('err.VALIDATION')}: ${e.message}` : t('err.VALIDATION');
    if ((e.code === 'CONFLICT' || e.code === 'UPSTREAM') && e.message) return `${t(generic!)}: ${e.message}`;
    return generic ? t(generic) : e.message;
  }
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') return (e as { message: string }).message;
  return t('err.unknown');
}
