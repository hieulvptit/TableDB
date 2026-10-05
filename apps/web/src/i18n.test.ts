import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api/errors';
import { DEFAULT_LOCALE, errorMessage, getLocale, setLocale, t } from './i18n';
import { enCommon } from './i18n/en.common';
import { enDesktop } from './i18n/en.desktop';
import { enWeb } from './i18n/en.web';
import { viCommon } from './i18n/vi.common';
import { viDesktop } from './i18n/vi.desktop';
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

const DESKTOP_FILES = /(^|\/)(desktop\/|auth\/(desktopLogin|GenaiLoginPanel|SsoLogoutControl)|features\/tabledb\/|features\/agent\/|features\/report\/|gateway\/|features\/transfers\/(NewTransferPage|uploadFlow|uploader|DesktopMyTransfersPage|DesktopTicketDetailPage))/;
const WEB_FILES = /(^|\/)(web\/|features\/admin\/|features\/transfers\/(ApprovalsPage|DecisionPanel|TicketDetailPage|MyTransfersPage|download))/;
const dictFor = (rel: string): Record<string, string> => (DESKTOP_FILES.test(rel) ? { ...viCommon, ...viDesktop } : WEB_FILES.test(rel) ? { ...viCommon, ...viWeb } : viCommon);

describe('i18n', () => {
  it('every statically referenced key exists in the dictionary of the target(s) that bundle the file', () => {
    const missing = new Set<string>();
    for (const f of walk(join(__dirname))) {
      const rel = f.split('/src/')[1]!;
      const dict = dictFor(rel);
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g)) if (!(m[1]! in dict)) missing.add(`${m[1]} (${rel})`);
    }
    expect([...missing]).toEqual([]);
  });
  it('the target dictionaries do not overlap (each key is bundled once, in exactly one place)', () => {
    const dup = (a: object, b: object) => Object.keys(a).filter((k) => k in b);
    expect(dup(viCommon, viWeb)).toEqual([]);
    expect(dup(viCommon, viDesktop)).toEqual([]);
    expect(dup(viWeb, viDesktop)).toEqual([]);
  });
  it('web messages carry no TableDB/Agent strings; desktop messages carry no approval/admin strings', () => {
    for (const k of Object.keys({ ...viCommon, ...viWeb })) expect(k).not.toMatch(/^(tabledb|connect|agent|tree|editor|result|write|ctx|rows|dberr)\./);
    for (const k of Object.keys({ ...viCommon, ...viDesktop })) expect(k).not.toMatch(/^(ap|dec|admin|audit)\./);
  });
  it('dynamic key families are complete', () => {
    for (const k of ['read', 'write', 'ddl', 'other']) expect(vi).toHaveProperty(`sql.kind.${k}`);
    for (const k of ['hashing', 'creating', 'uploading', 'completing', 'done']) expect(viCommon).toHaveProperty(`nt.phase.${k}`);
    for (const k of ['SENT', 'PENDING', 'ERROR']) { expect(viCommon).toHaveProperty(`notify.${k}`); expect(viCommon).toHaveProperty(`notify.${k}Hint`); }
    for (const k of ['approval_sent', 'approval_failed', 'decision_sent', 'quarantine_sent']) expect(viCommon).toHaveProperty(`ev.email.${k}`);
    for (const k of ['empty', 'multi', 'not-read', 'write-not-allowed']) expect(viDesktop).toHaveProperty(`tabledb.reject.${k}`);
    for (const k of ['string', 'number', 'boolean', 'date', 'timestamp', 'null']) expect(viDesktop).toHaveProperty(`bind.t.${k}`);
    for (const k of ['ok', 'error', 'skipped', 'rejected', 'cancelled']) expect(viDesktop).toHaveProperty(`script.st.${k}`);
    for (const k of ['procedures', 'functions', 'packages', 'sequences', 'synonyms', 'triggers', 'mviews', 'types']) expect(viDesktop).toHaveProperty(`obj.kind.${k}`);
    for (const k of ['tables', 'columns', 'routines']) expect(viDesktop).toHaveProperty(`search.kind.${k}`);
    for (const k of ['changed', 'onlyLeft', 'onlyRight', 'same']) expect(viDesktop).toHaveProperty(`sc.st.${k}`);
    for (const k of ['added', 'removed', 'changed']) expect(viDesktop).toHaveProperty(`sc.col.${k}`);
    for (const k of ['monitor.cancelQuery', 'monitor.terminate', 'monitor.kill', 'tx.committed', 'tx.rolledBack', 'tt.import.warn', 'tt.import.warnReplace', 'tt.import.rolledBack', 'tt.import.failedManual']) expect(viDesktop).toHaveProperty([k]);
    for (const k of ['E_BAD_REQUEST', 'E_DRIVER_UNAVAILABLE', 'E_AUTH_FAILED', 'E_AUTH_INTERACTIVE_TIMEOUT', 'E_CONN', 'E_TIMEOUT', 'E_CANCELLED', 'E_READONLY_VIOLATION', 'E_POLICY', 'E_SQL', 'E_LIMIT', 'E_NOT_FOUND', 'E_INTERNAL']) expect(viDesktop).toHaveProperty(`dberr.${k}`);
  });
  it('interpolates and maps errors', () => {
    expect(t('grid.page', { p: 2, n: 5 })).toBe('Trang 2/5');
    expect(errorMessage(new ApiError('FORBIDDEN', 'x', 403))).toBe(vi['err.FORBIDDEN']);
    expect(errorMessage(new ApiError('VALIDATION', 'field x', 400))).toContain('field x');
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
  it('English is the default locale', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(document.documentElement.lang).toBeTruthy();
  });
  it('English dictionaries have exactly the same keys and placeholders as Vietnamese', () => {
    const pairs: [Record<string, string>, Record<string, string>][] = [[viCommon, enCommon], [viWeb, enWeb], [viDesktop, enDesktop]];
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
      expect(t('grid.page', { p: 2, n: 5 })).not.toBe('Trang 2/5');
      setLocale('vi');
      expect(t('grid.page', { p: 2, n: 5 })).toBe('Trang 2/5');
    } finally { setLocale('vi'); }
  });
});
