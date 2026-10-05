import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Dialog, useToast } from '@vnpay/ui';
import { intlLocale, t } from '../../i18n';
import { clearHistory, clearWorkspace, deleteHistory, setSettings, useHistory, useWorkspaceSettings, workspaceStorage, type HistoryEntry } from './workspace';

const fmtTime = (ms: number) => new Date(ms).toLocaleString(intlLocale(), { hour12: false });

/** Local query history: search, re-open in the editor, delete; recording can be switched off. */
export function HistoryDialog({ onClose, onInsert, onOpenTab }: { onClose: () => void; onInsert: (sql: string) => void; onOpenTab: (sql: string) => void }) {
  const toast = useToast();
  const all = useHistory();
  const settings = useWorkspaceSettings();
  const [q, setQ] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [conn, setConn] = useState('');
  const [sel, setSel] = useState<HistoryEntry | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const conns = useMemo(() => [...new Set(all.map((e) => e.connName))].sort(), [all]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter((e) => (!s || e.sql.toLowerCase().includes(s)) && (!onlyErrors || !e.ok) && (!conn || e.connName === conn)).slice(0, 300);
  }, [all, q, onlyErrors, conn]);
  const pick = sel && shown.some((x) => x.id === sel.id) ? sel : shown[0] ?? null;

  return (
    <Dialog open wide title={t('history.title')} onClose={onClose}
      footer={<>
        <Button variant="danger" disabled={all.length === 0} onClick={() => setConfirmClear(true)}>{t('history.clear')}</Button>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>{t('common.close')}</Button>
        <Button disabled={!pick} onClick={() => { if (pick) { onOpenTab(pick.sql); onClose(); } }}>{t('history.openTab')}</Button>
        <Button variant="primary" disabled={!pick} onClick={() => { if (pick) { onInsert(pick.sql); onClose(); } }}>{t('history.insert')}</Button>
      </>}>
      <div className="ui-col" style={{ gap: 8 }}>
        <div className="ui-row" style={{ flexWrap: 'wrap' }}>
          <input className="ui-input" type="search" style={{ flex: 1, minWidth: 200 }} placeholder={t('history.search')} aria-label={t('history.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <select className="ui-select" aria-label={t('history.connection')} value={conn} onChange={(e) => setConn(e.target.value)}>
            <option value="">{t('history.allConnections')}</option>
            {conns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <Checkbox label={t('history.onlyErrors')} checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8, minHeight: 300 }}>
          <div role="listbox" aria-label={t('history.title')} style={{ overflow: 'auto', maxHeight: '50vh', border: '1px solid var(--ui-border)', borderRadius: 6 }}>
            {shown.length === 0 && <div className="ui-muted" style={{ padding: 8 }}>{all.length === 0 ? t('history.empty') : t('history.noMatch')}</div>}
            {shown.map((e) => (
              <div key={e.id} role="option" aria-selected={pick?.id === e.id} tabIndex={0} className={`tb-list__item${pick?.id === e.id ? ' is-selected' : ''}`}
                onClick={() => setSel(e)} onDoubleClick={() => { onInsert(e.sql); onClose(); }} onKeyDown={(ev) => { if (ev.key === 'Enter') { onInsert(e.sql); onClose(); } }}>
                <div className="ui-row" style={{ gap: 6 }}>
                  <Badge tone={e.ok ? 'success' : 'danger'}>{e.ok ? 'OK' : e.errorCode ?? 'ERR'}</Badge>
                  {e.mode === 'write' && <Badge tone="warning">{t('mode.write')}</Badge>}
                  <span className="ui-muted" style={{ fontSize: 12 }}>{fmtTime(e.at)} · {e.connName}{e.ms !== undefined ? ` · ${e.ms} ms` : ''}{e.rows !== undefined ? ` · ${e.rows}` : ''}</span>
                </div>
                <div className="ui-mono" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.sql.replace(/\s+/g, ' ')}</div>
              </div>
            ))}
          </div>
          <div className="ui-col" style={{ gap: 6, minWidth: 0 }}>
            <pre className="ui-mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, flex: 1, overflow: 'auto', maxHeight: '45vh', background: 'var(--ui-surface-2)', padding: 8, borderRadius: 6 }}>{pick?.sql ?? ''}</pre>
            {pick && (
              <div className="ui-row">
                <Button size="sm" onClick={() => void navigator.clipboard?.writeText(pick.sql).then(() => toast.push(t('tree.copied'), 'success'), () => {})}>{t('tt.copy')}</Button>
                <Button size="sm" variant="ghost" onClick={() => deleteHistory([pick.id])}>{t('history.delete')}</Button>
              </div>
            )}
          </div>
        </div>
        <Checkbox label={t('history.record')} checked={settings.recordHistory} onChange={(e) => setSettings({ recordHistory: e.target.checked })} />
        <Checkbox label={t('history.persistTabs')} checked={settings.persistTabs} onChange={(e) => setSettings({ persistTabs: e.target.checked })} />
        <div className="ui-muted" style={{ fontSize: 12 }}>{t(workspaceStorage() === 'encrypted' ? 'history.noteEncrypted' : 'history.note')}</div>
        <div><Button size="sm" variant="ghost" onClick={() => setConfirmWipe(true)}>{t('history.wipe')}</Button></div>
      </div>
      <Dialog open={confirmWipe} alert title={t('history.wipe')} onClose={() => setConfirmWipe(false)}
        footer={<><Button onClick={() => setConfirmWipe(false)}>{t('common.cancel')}</Button><Button variant="danger" onClick={() => { setConfirmWipe(false); void clearWorkspace().then(() => toast.push(t('history.wiped'), 'success'), () => toast.push(t('history.wipeFailed'), 'error')); }}>{t('common.delete')}</Button></>}>
        {t('history.wipeConfirm')}
      </Dialog>
      <Dialog open={confirmClear} alert title={t('history.clear')} onClose={() => setConfirmClear(false)}
        footer={<><Button onClick={() => setConfirmClear(false)}>{t('common.cancel')}</Button><Button variant="danger" onClick={() => { clearHistory(); setConfirmClear(false); }}>{t('history.clear')}</Button></>}>
        {t('history.clearConfirm', { n: all.length })}
      </Dialog>
    </Dialog>
  );
}
