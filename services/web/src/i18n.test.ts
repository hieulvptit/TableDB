import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api/errors';
import { DEFAULT_LOCALE, errorMessage, getLocale, setLocale, t } from './i18n';
import { enCommon } from './i18n/en.common';
import { enWeb } from './i18n/en.web';
import { viCommon } from './i18n/vi.common';
import { viWeb } from './i18n/vi.web';
import { vi } from './i18n/vi';

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && !p.includes('/i18n/')) out.push(p);
  }
  return out;
}

const dict: Record<string, string> = { ...viCommon, ...viWeb };

describe('i18n', () => {
  it('every statically referenced key exists in the dictionary of the bundle', () => {
    const missing = new Set<string>();
    for (const f of walk(join(__dirname))) {
      const rel = f.split('/src/')[1]!;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g)) if (!(m[1]! in dict)) missing.add(`${m[1]} (${rel})`);
    }
    expect([...missing]).toEqual([]);
  });
  it('the dictionaries do not overlap (each key is defined once)', () => {
    expect(Object.keys(viCommon).filter((k) => k in viWeb)).toEqual([]);
  });
  it('messages carry no TableDB/Agent strings', () => {
    for (const k of Object.keys(dict)) expect(k).not.toMatch(/^(tabledb|connect|agent|tree|editor|result|write|ctx|rows|dberr)\./);
  });
  it('dynamic key families are complete', () => {
    for (const k of ['hashing', 'creating', 'uploading', 'completing', 'done']) expect(viCommon).toHaveProperty(`nt.phase.${k}`);
    for (const k of ['SENT', 'PENDING', 'ERROR']) { expect(viCommon).toHaveProperty(`notify.${k}`); expect(viCommon).toHaveProperty(`notify.${k}Hint`); }
    for (const k of ['approval_sent', 'approval_failed', 'decision_sent', 'quarantine_sent']) expect(viCommon).toHaveProperty(`ev.email.${k}`);
  });
  it('interpolates and maps errors', () => {
    expect(t('env.label', { env: 'PROD' })).toBe(viCommon['env.label']!.replace('{env}', 'PROD'));
    expect(errorMessage(new ApiError('FORBIDDEN', 'x', 403))).toBe(vi['err.FORBIDDEN']);
    expect(errorMessage(new ApiError('VALIDATION', 'field x', 400))).toContain('field x');
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
  it('English is the default locale', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(document.documentElement.lang).toBeTruthy();
  });
  it('English dictionaries have exactly the same keys and placeholders as Vietnamese', () => {
    const pairs: [Record<string, string>, Record<string, string>][] = [[viCommon, enCommon], [viWeb, enWeb]];
    const ph = (m: string) => (m.match(/(?<!\$)\{\w+\}/g) ?? []).sort().join(',');
    for (const [v, e] of pairs) {
      expect(Object.keys(e).sort()).toEqual(Object.keys(v).sort());
      for (const k of Object.keys(v)) {
        expect(typeof e[k], k).toBe('string');
        expect(ph(e[k]!), k).toBe(ph(v[k]!));
      }
    }
  });
  it('switches between English and Vietnamese', () => {
    try {
      setLocale('en');
      expect(getLocale()).toBe('en');
      expect(t('nav.logout')).toBe(enCommon['nav.logout']);
      setLocale('vi');
      expect(t('nav.logout')).toBe(viCommon['nav.logout']);
    } finally { setLocale('vi'); }
  });
});
