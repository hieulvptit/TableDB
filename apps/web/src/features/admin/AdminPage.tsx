import { useState } from 'react';
import { Button, EmptyState, Input, Table, useToast } from '@vnpay/ui';
import { apiClient } from '../../api/client';
import { asList } from '../../api/services';
import type { AuditEntry, AuditVerify } from '../../api/types';
import { AsyncView } from '../../components/AsyncView';
import { useAuth } from '../../auth/AuthContext';
import { useAsync } from '../../hooks';
import { errorMessage, t } from '../../i18n';
import { fmtDate } from '../../lib';

export function AuditPage() {
  const { can } = useAuth();
  const [f, setF] = useState({ actor: '', action: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const [extra, setExtra] = useState<AuditEntry[]>([]);
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [more, setMore] = useState(false);
  const toast = useToast();
  const q = (before?: string | number) => ({ actor: applied.actor || undefined, action: applied.action || undefined, from: applied.from ? new Date(applied.from).toISOString() : undefined, to: applied.to ? new Date(applied.to).toISOString() : undefined, limit: 100, before });
  const state = useAsync(async () => { setExtra([]); setMore(false); return asList<AuditEntry>(await apiClient.get<unknown>('/audit', { query: q() }), 'entries'); }, [applied]);
  const all = [...(state.data ?? []), ...extra];
  const loadMore = async () => {
    const last = all[all.length - 1];
    if (!last) return;
    try { const r = asList<AuditEntry>(await apiClient.get<unknown>('/audit', { query: q(last.seq) }), 'entries'); setExtra((e) => [...e, ...r]); setMore(r.length === 0); }
    catch (e) { toast.push(errorMessage(e), 'error'); }
  };
  const doVerify = async () => {
    setVerifying(true);
    try { setVerify(await apiClient.get<AuditVerify>('/audit/verify')); } catch (e) { toast.push(errorMessage(e), 'error'); } finally { setVerifying(false); }
  };
  if (!can('audit:read')) return <EmptyState title={t('forbidden.title')} />;
  return (
    <div className="tr-page ui-col">
      <h1>{t('audit.title')}</h1>
      <form className="ui-card ui-row ap-form"  onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <Input label={t('audit.actor')} value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value })} placeholder="UUID" error={f.actor && !/^[0-9a-f-]{36}$/i.test(f.actor) ? t('audit.actorUuid') : undefined} />
        <Input label={t('audit.action')} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} placeholder="db." />
        <Input label={t('audit.from')} type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label={t('audit.to')} type="datetime-local" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Button type="submit" variant="primary" disabled={!!f.actor && !/^[0-9a-f-]{36}$/i.test(f.actor)}>{t('audit.search')}</Button>
        <Button onClick={() => void doVerify()} loading={verifying}>{t('audit.verify')}</Button>
      </form>
      {verify && (
        <div role="status" className="ui-card" style={{ borderColor: verify.ok ? 'var(--ui-success)' : 'var(--ui-danger)' }}>
          {verify.ok ? t('audit.verifyOk', { n: verify.checked ?? '?' }) : t('audit.verifyBroken', { at: String(verify.brokenAtSeq ?? '?') })}
        </div>
      )}
      <AsyncView state={state}>{() => all.length === 0 ? <EmptyState title={t('admin.empty')} /> : (
        <>
          <Table className="tr-table" caption={t('audit.title')}>
            <thead><tr><th scope="col">{t('audit.time')}</th><th scope="col">{t('audit.actor')}</th><th scope="col">{t('audit.action')}</th><th scope="col">{t('audit.resource')}</th><th scope="col">{t('audit.detail')}</th></tr></thead>
            <tbody>{all.map((e) => (
              <tr key={e.seq}><td>{fmtDate(e.at)}</td><td title={e.actorId ?? undefined}>{e.actorLabel ?? e.actorId ?? ''}</td><td className="ui-mono">{e.action}</td><td className="ui-mono">{e.resourceType ? `${e.resourceType}${e.resourceId ? `:${String(e.resourceId).slice(0, 8)}` : ''}` : ''}</td>
                <td className="ui-mono" title={e.detail ? JSON.stringify(e.detail) : undefined} style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.detail ? JSON.stringify(e.detail) : ''}</td></tr>))}
            </tbody>
          </Table>
          <div><Button onClick={() => void loadMore()} disabled={more}>{more ? t('audit.noMore') : t('audit.loadMore')}</Button></div>
        </>
      )}</AsyncView>
    </div>
  );
}
