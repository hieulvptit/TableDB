import type { ReactNode } from 'react';
import type { ContextManifest } from '@vnpay/shared';
import { Badge, Spinner } from '@vnpay/ui';
import { t } from '../../i18n';
import { Icon } from '../tabledb/icons';

export interface ContextDisclosureProps {
  manifest: ContextManifest | null;
  /** "before": preview of what WOULD be sent; "after": what WAS sent with a given message */
  phase: 'before' | 'after';
  loading?: boolean;
  error?: string | null;
  defaultOpen?: boolean;
  /** single-line button-style summary (used above the chat input) */
  compact?: boolean;
  /** compact only: extra controls shown at the top of the popover (e.g. the selected tables) */
  extra?: ReactNode;
  /** compact only: number of selected tables, drives the pill label */
  selectedCount?: number;
}

/** Discloses exactly which tables/columns/DDL (and whether any rows) go to the LLM. */
export function ContextDisclosure({ manifest, phase, loading, error, defaultOpen, compact, extra, selectedCount = 0 }: ContextDisclosureProps) {
  const title = phase === 'before' ? t('ctx.titleBefore') : t('ctx.titleAfter');
  const rows = manifest?.rowsIncluded;
  const totalCols = manifest?.included.reduce((n, e) => n + e.columns, 0) ?? 0;
  const ddlCount = manifest?.included.filter((e) => e.ddlIncluded).length ?? 0;
  const body = (<>
    {error && <div className="ui-error-text" role="alert">{error}</div>}
    {!manifest && !error && !loading && <div className="ui-muted">{t('ctx.none')}</div>}
    {manifest && (
      <div className="ui-col" style={{ marginTop: compact ? 0 : 6 }}>
        {manifest.included.length === 0 ? <div className="ui-muted">{t('ctx.noTables')}</div> : (
          <table className="ui-table" aria-label={t('ctx.tablesAria')}>
            <thead><tr><th scope="col">{t('ctx.table')}</th><th scope="col">{t('ctx.level')}</th><th scope="col">{t('ctx.columns')}</th><th scope="col">DDL</th><th scope="col">{t('ctx.chars')}</th></tr></thead>
            <tbody>
              {manifest.included.map((e) => (
                <tr key={`${e.schema}.${e.table}`}>
                  <td className="ui-mono">{e.schema}.{e.table}</td>
                  <td>{e.level === 0 ? t('ctx.selected') : t('ctx.related')}</td>
                  <td>{e.columns}</td>
                  <td>{e.ddlIncluded ? t('common.yes') : t('common.no')}</td>
                  <td>{e.chars}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {manifest.denied.length > 0 && (
          <div><Badge tone="danger">{t('ctx.denied')}</Badge> <span className="ui-mono">{manifest.denied.map((d) => `${d.schema}.${d.table}`).join(', ')}</span></div>
        )}
        {manifest.droppedForBudget.length > 0 && (
          <div><Badge tone="warning">{t('ctx.dropped')}</Badge> <span className="ui-mono">{manifest.droppedForBudget.map((d) => `${d.schema}.${d.table}`).join(', ')}</span></div>
        )}
        {manifest.suspiciousFields > 0 && <div><Badge tone="warning">{t('ctx.suspicious', { n: manifest.suspiciousFields })}</Badge></div>}
        <div className="ui-muted">{t('ctx.budget', { used: manifest.usedChars, total: manifest.budgetChars })}</div>
        <div>{t('ctx.rows')}: {rows ? <Badge tone="warning">{t('ctx.rowsN', { n: rows.count })}</Badge> : <Badge tone="success">{t('ctx.rowsNone')}</Badge>}</div>
      </div>
    )}
  </>);
  if (compact) {
    const value = selectedCount === 0 ? t('ctx.pillNone') : t('ctx.pillTables', { n: selectedCount });
    return (
      <details className="agent-ctx" open={defaultOpen} data-testid={`context-${phase}`}>
        <summary className={`agent-pill${selectedCount === 0 ? ' agent-pill--warn' : ' agent-pill--ok'}`}>
          <Icon name="database" />
          <span className="agent-pill__label">{t('ctx.pillLabel')}:</span>
          <span className="agent-pill__value">{value}</span>
          {loading && <Spinner label={t('common.loading')} />}
          <span className="agent-pill__chev"><Icon name="chevron" /></span>
        </summary>
        <div className="agent-ctx__panel">
          <div className="agent-ctx__title">{title}</div>
          {manifest && !loading && (
            <div className="ui-muted">{t('ctx.summary', { tables: manifest.included.length, cols: totalCols, ddl: ddlCount })}{' · '}{rows ? t('ctx.rowsN', { n: rows.count }) : t('ctx.rowsNone')}</div>
          )}
          {extra}
          {body}
        </div>
      </details>
    );
  }
  return (
    <details className="ui-card" open={defaultOpen} data-testid={`context-${phase}`} style={{ padding: 8 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        {title}
        {loading && <> <Spinner label={t('common.loading')} /></>}
        {manifest && !loading && (
          <span className="ui-muted" style={{ fontWeight: 400 }}>
            {' — '}{t('ctx.summary', { tables: manifest.included.length, cols: totalCols, ddl: ddlCount })}
            {' · '}{rows ? t('ctx.rowsN', { n: rows.count }) : t('ctx.rowsNone')}
          </span>
        )}
      </summary>
      {body}
    </details>
  );
}
