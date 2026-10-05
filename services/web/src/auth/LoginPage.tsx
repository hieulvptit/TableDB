import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input, useToast } from '@vnpay/ui';
import { apiClient } from '../api/client';
import type { AuthConfig } from '../api/types';
import { useAsync } from '../hooks';
import { errorMessage, t } from '../i18n';
import { AsyncView } from '../components/AsyncView';
import { useAuth } from './AuthContext';
import { fetchAuthConfig, lastProvider, rememberProvider, safeReturnTo, webLoginUrl } from './login';

export default function LoginPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { status, refresh } = useAuth();
  const returnTo = safeReturnTo(sp.get('returnTo'));
  const stepup = sp.get('stepup') === '1';
  const cfg = useAsync(() => fetchAuthConfig(), []);
  const [busy, setBusy] = useState('');
  const [devEmail, setDevEmail] = useState('');

  const signIn = (provider: string) => {
    rememberProvider(provider);
    window.location.assign(webLoginUrl(apiClient, provider, returnTo, stepup));
  };

  // Step-up: skip the chooser when we know which provider was used.
  useEffect(() => {
    const p = lastProvider();
    if (stepup && p && cfg.data?.providers.some((x) => x.id === p)) window.location.assign(webLoginUrl(apiClient, p, returnTo, true));
  }, [stepup, cfg.data, returnTo]);

  const devLogin = async () => {
    setBusy('dev');
    try { await apiClient.post('/auth/dev-login', { email: devEmail }, { public: true }); await refresh(); nav(returnTo, { replace: true }); }
    catch (e) { toast.push(errorMessage(e), 'error'); } finally { setBusy(''); }
  };

  if (status === 'authenticated' && !stepup) return <Navigate to={returnTo} replace />;
  return (
    <div className="login-page">
      <div className="ui-card nt-card login-card">
        <h1>VNPAY {t('brand.web')}</h1>
        {stepup && <p className="ui-muted">{t('login.stepup')}</p>}
        <AsyncView state={cfg}>{(c: AuthConfig) => (
          <div className="ui-col">
            {c.providers.map((p) => (
              <Button key={p.id} variant="primary" onClick={() => signIn(p.id)} loading={busy === p.id} disabled={!!busy}>{t('login.with', { name: p.label })}</Button>
            ))}
            {c.providers.length === 0 && <div className="ui-muted">{t('login.noProviders')}</div>}
            {c.devLogin && (
              <form className="ui-col" onSubmit={(e) => { e.preventDefault(); void devLogin(); }}>
                <hr style={{ width: '100%' }} />
                <Input label={t('login.devEmail')} type="email" value={devEmail} onChange={(e) => setDevEmail(e.target.value)} />
                <Button type="submit" loading={busy === 'dev'} disabled={!devEmail || !!busy}>{t('login.dev')}</Button>
              </form>
            )}
          </div>
        )}</AsyncView>
      </div>
    </div>
  );
}
