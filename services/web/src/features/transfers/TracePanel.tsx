import { useState } from 'react';
import { Button } from '@vnpay/ui';
import { errorMessage, t } from '../../i18n';
import { fmtDate } from '../../lib';
import { transfersApi } from '../../api/services';
import type { AuditEntry } from '../../api/types';

/** Collapsible audit trace of one ticket (GET /transfers/:id/trace). Loaded on demand; 403/404 degrade to a notice. */
export function TracePanel({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || entries) return;
    setLoading(true); setMsg('');
    try { setEntries((await transfersApi.trace(ticketId)).entries ?? []); }
    catch (e) {
      const c = (e as { code?: string }).code;
      setMsg(c === 'FORBIDDEN' || c === 'NOT_FOUND' ? t('trc.unavailable') : errorMessage(e));
    } finally { setLoading(false); }
  };
  return (
    <section className="ui-card" aria-labelledby="tr-trace-title">
      <h2 id="tr-trace-title" style={{ marginTop: 0 }}>{t('trc.title')}</h2>
      <Button onClick={() => void toggle()} aria-expanded={open} aria-controls="tr-trace-body" loading={loading}>{open ? t('trc.hide') : t('trc.show')}</Button>
      <div id="tr-trace-body" hidden={!open} aria-live="polite">
        {msg && <div className="ui-muted">{msg}</div>}
        {entries && entries.length === 0 && <div className="ui-muted">{t('trc.empty')}</div>}
        {entries && entries.length > 0 && (
          <ol aria-label={t('trc.title')} className="td-timeline">
            {entries.map((e) => (
              <li key={e.seq}>
                <span aria-hidden className="td-timeline__dot" />
                <div><strong className="ui-mono">{e.action}</strong> <span className="ui-muted">{fmtDate(e.at)}</span></div>
                <div className="ui-muted">{e.actorLabel ?? ''}{e.ip ? ` · ${e.ip}` : ''}</div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
