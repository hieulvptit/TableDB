import { Button, useToast } from '@vnpay/ui';
import { classifySql, type SqlKind } from '@vnpay/shared';
import { t } from '../../i18n';
import { SqlKindBadge } from '../tabledb/SqlKindBadge';

const RANK: Record<SqlKind, number> = { read: 0, write: 1, ddl: 2, other: 3 };
export function worstKind(a: SqlKind, b?: SqlKind): SqlKind { return b && RANK[b] > RANK[a] ? b : a; }

/** SQL from the Agent: classified before display; the only action is inserting into the editor. There is deliberately no "run". */
export function SqlBlock({ sql, serverKind, onInsert }: { sql: string; serverKind?: SqlKind; onInsert: (sql: string) => void }) {
  const toast = useToast();
  const c = classifySql(sql);
  const kind = worstKind(c.kind, serverKind);
  return (
    <div className="ui-card" style={{ padding: 8 }} data-testid="sql-block">
      <div className="ui-row" style={{ marginBottom: 4 }}>
        <SqlKindBadge kind={kind} multi={c.multi} />
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="primary" onClick={() => onInsert(sql)}>{t('agent.insert')}</Button>
        <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(sql).then(() => toast.push(t('agent.copied'), 'success')).catch(() => {}); }}>{t('agent.copy')}</Button>
      </div>
      <pre className="ui-mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 220, overflow: 'auto' }}>{sql}</pre>
      {kind !== 'read' && <div className="ui-error-text" style={{ marginTop: 4 }}>{t('agent.notReadWarn')}</div>}
    </div>
  );
}
