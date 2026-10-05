import { useState } from 'react';
import { Button, Dialog, Input, Select, useToast } from '@vnpay/ui';
import type { AgentSettings, AgentTokenState } from '../../api/types';
import { errorMessage, t } from '../../i18n';
import { fmtDate } from '../../lib';
import { agentApi } from './api';

/** LLM token management. The token is only sent to our API (encrypted at rest there); the field is cleared right after saving. */
export function TokenSetup({ settings, state, onChanged }: { settings: AgentSettings; state: AgentTokenState; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(!state.configured);
  const [endpointId, setEndpointId] = useState(state.endpointId ?? settings.defaultEndpointId);
  const ep = settings.endpoints.find((e) => e.id === endpointId) ?? settings.endpoints[0];
  const [model, setModel] = useState(state.model ?? settings.defaultModel);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState('');
  const modelOk = ep?.models.includes(model) ? model : ep?.models[0] ?? '';

  const save = async () => {
    if (!ep) return;
    setBusy(true); setErr('');
    try {
      await agentApi.saveToken({ token: token.trim(), endpointId: ep.id, model: modelOk });
      setToken(''); setEditing(false);
      toast.push(t('agent.tokenSaved'), 'success');
      onChanged();
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true);
    try {
      const r = await agentApi.verify();
      toast.push(r.ok ? t('agent.verifyOk') : t('agent.verifyFail', { reason: r.reason ?? '' }), r.ok ? 'success' : 'error');
      onChanged();
    } catch (e) { toast.push(errorMessage(e), 'error'); } finally { setBusy(false); }
  };
  const del = async () => {
    setConfirmDel(false); setBusy(true);
    try { await agentApi.deleteToken(); toast.push(t('agent.tokenDeleted'), 'success'); setEditing(true); onChanged(); }
    catch (e) { toast.push(errorMessage(e), 'error'); } finally { setBusy(false); }
  };

  if (settings.endpoints.length === 0) return <div className="ui-muted" style={{ padding: 12 }}>{t('agent.noEndpoints')}</div>;

  return (
    <div className="ui-col" style={{ padding: 12 }}>
      {state.configured && !editing ? (
        <>
          <div>{t('agent.configured')}: <strong>{settings.endpoints.find((e) => e.id === state.endpointId)?.label ?? state.endpointId}</strong> / <span className="ui-mono">{state.model}</span></div>
          <div className="ui-muted">{t('agent.lastVerified', { at: fmtDate(state.lastVerifiedAt) })}</div>
          <div className="ui-row" style={{ flexWrap: 'wrap' }}>
            <Button size="sm" onClick={() => void verify()} loading={busy}>{t('agent.verify')}</Button>
            <Button size="sm" onClick={() => setEditing(true)}>{t('agent.change')}</Button>
            <Button size="sm" variant="danger" onClick={() => setConfirmDel(true)}>{t('agent.deleteToken')}</Button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="ui-col">
          <strong>{t('agent.setupTitle')}</strong>
          <Select label={t('agent.endpoint')} value={ep?.id ?? ''} onChange={(e) => { setEndpointId(e.target.value); setModel(settings.endpoints.find((x) => x.id === e.target.value)?.models[0] ?? ''); }}
            options={settings.endpoints.map((e) => ({ value: e.id, label: e.label }))} />
          <Select label={t('agent.model')} value={modelOk} onChange={(e) => setModel(e.target.value)} options={(ep?.models ?? []).map((m) => ({ value: m, label: m }))} />
          <Input label={t('agent.token')} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} error={err} />
          <div className="ui-row">
            <Button type="submit" variant="primary" loading={busy} disabled={token.trim().length < 8}>{t('agent.saveVerify')}</Button>
            {state.configured && <Button onClick={() => { setEditing(false); setToken(''); setErr(''); }}>{t('common.cancel')}</Button>}
          </div>
        </form>
      )}
      <Dialog open={confirmDel} alert title={t('agent.deleteToken')} onClose={() => setConfirmDel(false)}
        footer={<><Button data-autofocus onClick={() => setConfirmDel(false)}>{t('common.cancel')}</Button><Button variant="danger" onClick={() => void del()}>{t('common.delete')}</Button></>}>
        {t('agent.deleteConfirm')}
      </Dialog>
    </div>
  );
}
