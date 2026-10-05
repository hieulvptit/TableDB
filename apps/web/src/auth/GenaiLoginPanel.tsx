import { useEffect, useRef, useState } from 'react';
import { Button, Spinner, useToast } from '@vnpay/ui';
import { t } from '../i18n';
import { cancelGenaiLogin, desktopGenaiLogin, genaiErrorMessage, isGenaiCancelled } from './desktopLogin';
import { desktopCommands } from '../runtime/tauri';

type Phase = 'idle' | 'waiting' | 'exchanging';

/** Desktop-only: single "VNPAY SSO" button (broker flow) with a waiting state and cancel. */
export default function GenaiLoginPanel({ loginUrl, onDone }: { loginUrl: string; onDone: () => Promise<void> | void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const running = useRef(false);
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [savingProxy, setSavingProxy] = useState(false);
  useEffect(() => {
    let active = true;
    void desktopCommands.appInfo().then(info => {
      if (active && typeof info.genaiProxyUrl === 'string') setProxyUrl(info.genaiProxyUrl);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const saveProxy = async () => {
    setSavingProxy(true);
    try {
      await desktopCommands.secretSet('proxy.sso.credentials', JSON.stringify({ username: username.trim(), password }));
      setPassword('');
      setProxyOpen(false);
      toast.push(t('login.proxy.saved'), 'success');
    } catch (e) {
      toast.push(genaiErrorMessage(e), 'error');
    } finally { setSavingProxy(false); }
  };

  const start = async () => {
    if (running.current) return;
    running.current = true;
    setPhase('waiting');
    try {
      await desktopGenaiLogin(loginUrl, undefined, () => setPhase('exchanging'));
      await onDone();
    } catch (e) {
      if ((e as { code?: string })?.code === 'E_PROXY_AUTH_REQUIRED') setProxyOpen(true);
      if (!isGenaiCancelled(e)) toast.push(genaiErrorMessage(e), 'error');
    } finally {
      running.current = false;
      setPhase('idle');
    }
  };

  return (
    <div className="ui-col">
      {proxyUrl && (
        <details open={proxyOpen} onToggle={e => setProxyOpen(e.currentTarget.open)}>
          <summary>{t('login.proxy.title')}</summary>
          <div className="ui-col">
            <small>{proxyUrl} · {t('login.proxy.note')}</small>
            <label>{t('login.proxy.username')}<input autoComplete="off" maxLength={128} value={username} onChange={e => setUsername(e.target.value)} disabled={phase !== 'idle' || savingProxy} /></label>
            <label>{t('login.proxy.password')}<input type="password" autoComplete="new-password" maxLength={256} value={password} onChange={e => setPassword(e.target.value)} disabled={phase !== 'idle' || savingProxy} /></label>
            <Button onClick={() => void saveProxy()} disabled={!username.trim() || username.includes(':') || !password || phase !== 'idle'} loading={savingProxy}>{t('login.proxy.save')}</Button>
          </div>
        </details>
      )}
      <Button variant="primary" onClick={() => void start()} loading={phase !== 'idle'} disabled={phase !== 'idle' || savingProxy}>{t('login.genai.button')}</Button>
      {phase !== 'idle' && (
        <div className="ui-row" role="status"><Spinner label="" /> {phase === 'waiting' ? t('login.genai.waiting') : t('login.genai.exchanging')}</div>
      )}
      {phase === 'waiting' && <Button onClick={() => void cancelGenaiLogin().catch(() => {})}>{t('login.genai.cancel')}</Button>}
    </div>
  );
}
