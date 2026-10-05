import { useCallback, useEffect, useState } from 'react';
import { Button, Input, useToast } from '@vnpay/ui';
import type { OpenMetadataTokenState } from '../../api/types';
import { errorMessage, t } from '../../i18n';
import { agentApi } from './api';

/** Per-user OpenMetadata token. Stored encrypted by the API; the Agent then gets read-only metadata tools on this user's behalf. */
export function OpenMetadataSetup() {
  const toast = useToast();
  const [state, setState] = useState<OpenMetadataTokenState | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => { agentApi.omState().then(setState).catch(() => setState(null)); }, []);
  useEffect(load, [load]);
  if (!state) return null;
  if (!state.enabled) return (
    <div className="ui-col" style={{ padding: '0 12px 12px' }}>
      <strong>{t('agent.om.title')}</strong>
      <span className="ui-muted">{t('agent.om.disabled')}</span>
    </div>
  );

  const save = async () => {
    setBusy(true); setErr('');
    try { await agentApi.saveOmToken(token.trim()); setToken(''); toast.push(t('agent.om.saved'), 'success'); load(); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  const del = async () => {
    setBusy(true);
    try { await agentApi.deleteOmToken(); toast.push(t('agent.om.deleted'), 'success'); load(); }
    catch (e) { toast.push(errorMessage(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="ui-col" style={{ padding: '0 12px 12px' }}>
      <strong>{t('agent.om.title')}</strong>
      {state.configured ? (
        <div className="ui-row" style={{ flexWrap: 'wrap' }}>
          <span className="ui-muted">{t('agent.om.configured')}</span>
          <Button size="sm" variant="danger" onClick={() => void del()} loading={busy}>{t('agent.deleteToken')}</Button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="ui-col">
          <Input label={t('agent.om.token')} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} error={err} />
          <div><Button type="submit" variant="primary" loading={busy} disabled={token.trim().length < 8}>{t('agent.om.save')}</Button></div>
        </form>
      )}
    </div>
  );
}
