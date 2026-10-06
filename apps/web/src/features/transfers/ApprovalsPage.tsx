import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, Input, Select, Table, Tabs, useToast } from '@vnpay/ui';
import { AsyncView } from '../../components/AsyncView';
import { useAuth } from '../../auth/AuthContext';
import { useAsync } from '../../hooks';
import { errorMessage, t } from '../../i18n';
import { fmtBytes, fmtDate } from '../../lib';
import { transfersApi } from '../../api/services';
import { approvalsApi } from '../../api/services.web';
import type { TicketView } from '../../api/types';
import { DecisionPanel } from './DecisionPanel';
import { EventTimeline } from './TicketInfo';
import { TicketStatusBadge } from './TicketBadges';

function ApprovalDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const state = useAsync(() => transfersApi.get(id), [id]);
  return (
    <AsyncView state={state}>{(d) => (
      <div className="ui-col">
        <div className="ui-row" style={{ flexWrap: 'wrap' }}><h2 style={{ margin: 0 }}><Link to={`/transfers/${d.ticket.id}`}>{d.ticket.code}</Link></h2><TicketStatusBadge status={d.ticket.status} /></div>
        <dl className="nt-summary">
          <dt>{t('dir.label')}</dt><dd><strong>{t(`dir.${d.ticket.direction}`)}</strong></dd>
          <dt>{t('nt.file')}</dt><dd>{d.ticket.fileName} ({fmtBytes(d.ticket.size)})</dd>
          <dt>SHA-256</dt><dd className="ui-mono">{d.ticket.sha256}</dd>
          <dt>{t('nt.purpose')}</dt><dd className="nt-pre">{d.ticket.purpose}</dd>
          <dt>{t('tr.expires')}</dt><dd>{fmtDate(d.ticket.expiresAt)}</dd>
        </dl>
        {d.ticket.status === 'PENDING_APPROVAL' ? <DecisionPanel ticket={d.ticket} onDone={onChanged} /> : <div className="ui-muted">{t('ap.alreadyDecided')}</div>}
        <EventTimeline events={d.events} />
      </div>
    )}</AsyncView>
  );
}

function Approvals() {
  const [status, setStatus] = useState('PENDING_APPROVAL');
  const [sel, setSel] = useState<string | null>(null);
  const list = useAsync(() => transfersApi.list('approvals', status || undefined), [status], { pollMs: 20000 });
  return (
    <div className="ap-grid">
      <div className="ui-col">
        <div className="ui-row">
          <Select label={t('tr.filterStatus')} value={status} onChange={(e) => setStatus(e.target.value)}
            options={[{ value: 'PENDING_APPROVAL', label: t('ap.pending') }, { value: '', label: t('tr.allStatuses') }]} />
          <Button onClick={list.reload} style={{ alignSelf: 'flex-end' }}>{t('common.refresh')}</Button>
        </div>
        <AsyncView state={list}>{(rows: TicketView[]) => rows.length === 0 ? <EmptyState title={t('ap.empty')} /> : (
          <Table caption={t('ap.title')} className="tr-table">
            <thead><tr><th scope="col">{t('tr.code')}</th><th scope="col">{t('dir.label')}</th><th scope="col">{t('tr.file')}</th><th scope="col">{t('tr.status')}</th><th scope="col">{t('tr.created')}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} aria-selected={sel === r.id}>
                <td><Button variant="ghost" size="sm" onClick={() => setSel(r.id)} aria-pressed={sel === r.id}>{r.code}</Button></td>
                <td>{t(`dir.${r.direction}`)}</td><td>{r.fileName}</td><td><TicketStatusBadge status={r.status} /></td><td>{fmtDate(r.createdAt)}</td>
              </tr>))}
            </tbody>
          </Table>
        )}</AsyncView>
      </div>
      <div className="ui-card" aria-live="polite">
        {sel ? <ApprovalDetail key={sel} id={sel} onChanged={() => list.reload()} /> : <EmptyState title={t('ap.selectOne')} />}
      </div>
    </div>
  );
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function Delegations() {
  const toast = useToast();
  const { me } = useAuth();
  const state = useAsync(() => Promise.all([approvalsApi.delegations(), transfersApi.options()]), []);
  const [to, setTo] = useState('');
  const [from, setFrom] = useState(() => toLocalInput(new Date()));
  const [until, setUntil] = useState(() => toLocalInput(new Date(Date.now() + 7 * 864e5)));
  const [busy, setBusy] = useState(false);
  const spanMs = new Date(until).getTime() - new Date(from).getTime();
  const valid = to && from && until && spanMs > 0 && spanMs <= (state.data?.[1].approval.delegationMaxDays ?? 0) * 864e5;
  const add = async () => {
    setBusy(true);
    try { await approvalsApi.createDelegation({ toUserId: to, validFrom: new Date(from).toISOString(), validTo: new Date(until).toISOString() }); toast.push(t('ap.delegCreated'), 'success'); setTo(''); state.reload(); }
    catch (e) { toast.push(errorMessage(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <AsyncView state={state}>{([list, opts]) => (
      <div className="ui-col" style={{ gap: 16 }}>
        <form className="ui-card ui-row ap-form"  onSubmit={(e) => { e.preventDefault(); if (valid) void add(); }}>
          <Select label={t('ap.delegTo')} value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('common.choose')}
            options={opts.leaders.filter((l) => l.id !== me?.user.id).map((l) => ({ value: l.id, label: `${l.name} (${l.email})` }))} />
          <Input label={t('ap.validFrom')} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label={t('ap.validTo')} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} error={until && from && !(spanMs > 0 && spanMs <= (state.data?.[1].approval.delegationMaxDays ?? 0) * 864e5) ? t('ap.rangeInvalid', { days: state.data?.[1].approval.delegationMaxDays ?? 0 }) : undefined} />
          <Button type="submit" variant="primary" disabled={!valid} loading={busy}>{t('ap.delegAdd')}</Button>
        </form>
        {list.length === 0 ? <EmptyState title={t('ap.delegEmpty')} /> : (
          <Table caption={t('ap.delegations')} className="tr-table">
            <thead><tr><th scope="col">{t('ap.delegTo')}</th><th scope="col">{t('ap.validFrom')}</th><th scope="col">{t('ap.validTo')}</th><th scope="col" /></tr></thead>
            <tbody>{list.map((d) => (
              <tr key={d.id}>
                <td>{d.toUserName ?? opts.leaders.find((l) => l.id === d.toUserId)?.name ?? d.toUserId}</td><td>{fmtDate(d.validFrom)}</td><td>{fmtDate(d.validTo)}</td>
                <td>{d.revoked ? t('ap.revoked') : <Button size="sm" variant="danger" onClick={async () => { try { await approvalsApi.deleteDelegation(d.id); state.reload(); } catch (e) { toast.push(errorMessage(e), 'error'); } }}>{t('ap.delegRevoke')}</Button>}</td>
              </tr>))}
            </tbody>
          </Table>
        )}
      </div>
    )}</AsyncView>
  );
}

export default function ApprovalsPage() {
  const [tab, setTab] = useState('list');
  return (
    <div className="tr-page">
      <div className="tr-page__head"><h1>{t('ap.title')}</h1></div>
      <Tabs label={t('ap.title')} activeId={tab} onChange={setTab}
        items={[{ id: 'list', label: t('ap.tabList'), content: <Approvals /> }, { id: 'deleg', label: t('ap.tabDeleg'), content: <Delegations /> }]} />
    </div>
  );
}
