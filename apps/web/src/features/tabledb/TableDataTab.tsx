import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Spinner, useToast } from '@vnpay/ui';
import { t } from '../../i18n';
import { ResultPanel, type EditCtx } from './ResultView';
import { useStoreVersion } from './SchemaTree';
import { SessionControls } from './QueryTab';
import { useTableDb } from './store';
import { Icon } from './icons';
import type { EditorTabState } from './types';

/** Data view of one table (opened by clicking it in the tree): WHERE filter + refresh, then the paged, editable result. */
export function TableDataTab({ tab }: { tab: EditorTabState }) {
  const db = useTableDb();
  const toast = useToast();
  const [filter, setFilter] = useState(tab.filter ?? '');
  useEffect(() => { setFilter(tab.filter ?? ''); }, [tab.filter]);
  const ref = tab.table!;
  const conn = db.connections.find((c) => c.id === tab.connId) ?? null;
  useStoreVersion(conn);
  useEffect(() => { if (conn) void conn.store.loadColumns(ref); }, [conn, ref]);
  const meta = conn?.store.columns(ref)?.value;
  const info = conn?.store.tables(ref.catalog, ref.schema)?.value?.find((x) => x.name === ref.name);
  const isView = !!info && /view/i.test(info.type);
  const output = tab.outputs.find((o) => o.id === tab.activeOutputId) ?? tab.outputs[tab.outputs.length - 1];
  const apply = () => void db.setTableFilter(tab.id, filter);
  const writable = !!conn?.allowWrite && !isView;
  const pk = meta?.primaryKey ?? [];

  const edit = useMemo<EditCtx | undefined>(() => (!conn ? undefined : {
    table: ref, pk, canEdit: writable && pk.length > 0,
    onSave: async (stmts) => {
      const r = await db.runWrites(conn.id, stmts, { atomic: true });
      if (r.error) {
        toast.push(`${t('edit.failed', { i: (r.failedIndex ?? 0) + 1 })} ${r.error.detail || r.error.title}`, 'error');
        return false;
      }
      toast.push(r.pending ? t('edit.savedPending', { n: r.done }) : t('edit.saved', { n: r.done }), 'success');
      void db.run(tab.id);
      return true;
    },
  }), [conn, ref, pk.join('|'), writable, tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <form className="ui-row" style={{ padding: '6px 8px', borderBottom: '1px solid var(--ui-border)', flexWrap: 'wrap' }}
        onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <strong className="ui-mono" title={tab.sql}>{ref.catalog ? `${ref.catalog}.` : ''}{ref.schema}.{ref.name}</strong>
        {edit?.canEdit
          ? <Badge tone="warning" title={t('edit.hint')}>{t('edit.editable')}</Badge>
          : <Badge tone="success" title={writable && pk.length === 0 && meta ? t('edit.noPk') : undefined}>{t('mode.readOnly')}</Badge>}
        <label className="ui-row" style={{ flex: 1, minWidth: 240, gap: 4 }}>
          <span className="ui-label">WHERE</span>
          <input className="ui-input ui-mono" style={{ flex: 1 }} value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={t('table.filterPlaceholder')} aria-label={t('table.filter')} disabled={tab.running} />
        </label>
        {tab.orderBy && (
          <Badge tone="info">ORDER BY {tab.orderBy.column}{tab.orderBy.desc ? ' DESC' : ''}
            <button type="button" className="ui-tab__close" aria-label={t('table.clearSort')} onClick={() => void db.setTableSort(tab.id, null)}>×</button>
          </Badge>
        )}
        {tab.running ? (
          <>
            <Spinner label={t('editor.running')} />
            <Button variant="danger" size="sm" onClick={() => void db.cancel(tab.id)}>{t('editor.cancel')}</Button>
          </>
        ) : (
          <>
            <Button type="submit" size="sm" variant="primary">{t('table.apply')}</Button>
            {tab.filter && <Button size="sm" variant="ghost" onClick={() => { setFilter(''); void db.setTableFilter(tab.id, ''); }}>{t('table.clearFilter')}</Button>}
            <Button size="sm" onClick={() => void db.run(tab.id)} title={t('table.refresh')} aria-label={t('table.refresh')}><Icon name="refresh" /></Button>
          </>
        )}
      </form>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResultPanel tab={tab} output={output} edit={edit} />
      </div>
      {conn && <div className="tb-status"><span>{conn.name}</span><span style={{ flex: 1 }} /><SessionControls conn={conn} /></div>}
    </div>
  );
}
