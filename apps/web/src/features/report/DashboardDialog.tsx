import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Spinner, useToast } from '@vnpay/ui';
import { errorMessage, t } from '../../i18n';
import { runAudited } from '../tabledb/exec';
import { useTableDb } from '../tabledb/store';
import { deleteWidget, useWidgets, type Widget } from '../tabledb/workspace';
import { ChartView } from './ChartView';
import { specFits } from './chart';

interface Run { state: 'idle' | 'running' | 'ok' | 'error'; columns: Array<{ name: string; typeName?: string }>; rows: unknown[][]; message?: string }
const idle: Run = { state: 'idle', columns: [], rows: [] };

/** Local dashboard: every widget re-runs its saved SELECT on the matching open connection (read-only, audited like the editor). */
export function DashboardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const db = useTableDb();
  const toast = useToast();
  const widgets = useWidgets();
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const gen = useRef(0);

  const connOf = useCallback((w: Widget) => db.connections.find((c) => (w.profileId ? c.profileId === w.profileId : c.name === w.connName)) ?? null, [db.connections]);

  const runOne = useCallback(async (w: Widget, g: number) => {
    const conn = connOf(w);
    const set = (r: Run) => { if (g === gen.current) setRuns((m) => ({ ...m, [w.id]: r })); };
    if (!conn) { set({ ...idle, state: 'error', message: t('dash.noConn', { name: w.connName ?? '?' }) }); return; }
    set({ ...idle, state: 'running' });
    try {
      if (w.schema) await conn.api.setSchema(w.schema);
      const r = await runAudited(conn, w.sql, 'read', { maxRows: w.maxRows });
      set({ state: 'ok', columns: r.columns.map((name, i) => ({ name, typeName: r.typeNames[i] })), rows: r.rows });
    } catch (e) { set({ ...idle, state: 'error', message: errorMessage(e) }); }
  }, [connOf]);

  const runAll = useCallback(() => {
    const g = ++gen.current;
    // sequential: widgets of one connection share a single JDBC session
    void (async () => { for (const w of widgets) await runOne(w, g); })();
  }, [widgets, runOne]);

  useEffect(() => { if (open) runAll(); else gen.current++; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  return (
    <Dialog open={open} wide title={t('dash.title')} onClose={onClose}
      footer={<><span className="ui-muted" style={{ flex: 1 }}>{t('dash.local')}</span><Button onClick={runAll} disabled={widgets.length === 0}>{t('dash.refreshAll')}</Button><Button onClick={onClose}>{t('common.close')}</Button></>}>
      {widgets.length === 0 ? <div className="ui-muted" style={{ padding: 16 }}>{t('dash.empty')}</div> : (
        <div className="rpt-grid">
          {widgets.map((w) => {
            const run = runs[w.id] ?? idle;
            const stale = run.state === 'ok' && !specFits(w.chart, run.columns);
            return (
              <section key={w.id} className="rpt-widget" aria-label={w.name}>
                <div className="rpt-widget__head">
                  <strong title={w.sql}>{w.name}</strong>
                  {run.state === 'ok' && <span className="ui-muted">{t('dash.rows', { n: run.rows.length })}</span>}
                  <Button size="sm" variant="ghost" disabled={run.state === 'running'} onClick={() => void runOne(w, gen.current)}>{t('dash.run')}</Button>
                  <Button size="sm" variant="ghost" aria-label={t('dash.remove')} title={t('dash.remove')} onClick={() => { deleteWidget(w.id); toast.push(t('dash.remove'), 'success'); }}>×</Button>
                </div>
                <div className="rpt-widget__body">
                  {run.state === 'running' && <div className="ui-row" style={{ padding: 12 }}><Spinner label={t('editor.running')} /> {t('editor.running')}</div>}
                  {run.state === 'error' && <div className="ui-error-text" role="alert" style={{ padding: 12 }}>{run.message}</div>}
                  {stale && <div className="ui-error-text" role="alert" style={{ padding: 12 }}>{t('dash.stale')}</div>}
                  {run.state === 'ok' && !stale && <ChartView spec={w.chart} columns={run.columns} rows={run.rows} compact />}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
