import { useEffect, useState } from 'react';
import { Button, Dialog } from '@vnpay/ui';
import type { BindValue } from '../../gateway';
import { t } from '../../i18n';
import type { PendingBinds } from './store';

const TYPES: BindValue['type'][] = ['string', 'number', 'date', 'timestamp', 'boolean', 'null'];

/** Values for the :name placeholders of a statement (remembered per tab). Values are sent as bind parameters, never spliced into SQL. */
export function BindDialog({ pending }: { pending: PendingBinds }) {
  const [vals, setVals] = useState<Record<string, BindValue>>(pending.values);
  useEffect(() => { setVals(pending.values); }, [pending]);
  const set = (n: string, patch: Partial<BindValue>) => setVals((v) => ({ ...v, [n]: { ...v[n]!, ...patch } }));
  const submit = () => pending.resolve(Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.type === 'null' ? { type: 'null' } : { type: v.type, value: v.value ?? '' }])));
  return (
    <Dialog open wide title={t('bind.title')} onClose={() => pending.resolve(null)}
      footer={<><Button onClick={() => pending.resolve(null)}>{t('common.cancel')}</Button><Button variant="primary" onClick={submit}>{t('bind.run')}</Button></>}>
      <form className="ui-col" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <pre className="ui-mono" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 140, overflow: 'auto', background: 'var(--ui-surface-2)', padding: 6, borderRadius: 6, fontSize: 12 }}>{pending.sql}</pre>
        <table className="ui-table">
          <thead><tr><th scope="col">{t('bind.name')}</th><th scope="col">{t('bind.type')}</th><th scope="col">{t('bind.value')}</th></tr></thead>
          <tbody>
            {pending.names.map((n, i) => {
              const v = vals[n] ?? { type: 'string', value: '' };
              return (
                <tr key={n}>
                  <td className="ui-mono">:{n}</td>
                  <td>
                    <select className="ui-select" aria-label={`${t('bind.type')} ${n}`} value={v.type} onChange={(e) => set(n, { type: e.target.value as BindValue['type'] })}>
                      {TYPES.map((x) => <option key={x} value={x}>{t(`bind.t.${x}`)}</option>)}
                    </select>
                  </td>
                  <td>
                    <input className="ui-input ui-mono" style={{ width: '100%' }} aria-label={`${t('bind.value')} ${n}`} autoFocus={i === 0} disabled={v.type === 'null'}
                      value={v.type === 'null' ? '' : v.value ?? ''} placeholder={v.type === 'date' ? 'YYYY-MM-DD' : v.type === 'timestamp' ? 'YYYY-MM-DD HH:MM:SS' : v.type === 'boolean' ? 'true / false' : ''}
                      onChange={(e) => set(n, { value: e.target.value })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="ui-muted">{t('bind.hint')}</div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
