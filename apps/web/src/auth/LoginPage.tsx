import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input, Spinner, useToast } from '@vnpay/ui';
import { apiClient } from '../api/client';
import type { AuthConfig } from '../api/types';
import { useAsync } from '../hooks';
import { errorMessage, t } from '../i18n';
import { AsyncView } from '../components/AsyncView';
import { useAuth } from './AuthContext';
import { fetchAuthConfig, lastProvider, rememberProvider, safeReturnTo, webLoginUrl } from './login';

// Desktop-only (build-time constant): the VNPAY SSO broker panel is not part of the web bundle.
const GenaiLoginPanel = import.meta.env.VITE_TARGET === 'desktop' ? lazy(() => import('./GenaiLoginPanel')) : null;

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
  const desktop = apiClient.isDesktop;

  const signIn = async (provider: string) => {
    rememberProvider(provider);
    if (import.meta.env.VITE_TARGET === 'desktop') {
      setBusy(provider);
      try { await (await import('./desktopLogin')).desktopLogin(provider, { stepup }); await refresh(); nav(returnTo, { replace: true }); }
      catch (e) { toast.push(errorMessage(e), 'error'); } finally { setBusy(''); }
    } else window.location.assign(webLoginUrl(apiClient, provider, returnTo, stepup));
  };

  // Step-up on web: skip the chooser when we know which provider was used.
  useEffect(() => {
    const p = lastProvider();
    if (stepup && !desktop && p && cfg.data?.providers.some((x) => x.id === p)) window.location.assign(webLoginUrl(apiClient, p, returnTo, true));
  }, [stepup, desktop, cfg.data, returnTo]);

  const devLogin = async () => {
    setBusy('dev');
    try { await apiClient.post('/auth/dev-login', { email: devEmail }, { public: true }); await refresh(); nav(returnTo, { replace: true }); }
    catch (e) { toast.push(errorMessage(e), 'error'); } finally { setBusy(''); }
  };

  if (status === 'authenticated' && !stepup) return <Navigate to={returnTo} replace />;
  return (
    <div className="login-page">
      <div className="ui-card nt-card login-card">
        <h1>VNPAY {t(desktop ? 'brand.desktop' : 'brand.web')}</h1>
        {stepup && <p className="ui-muted">{t('login.stepup')}</p>}
        <AsyncView state={cfg}>{(c: AuthConfig) => GenaiLoginPanel && desktop && c.desktopLoginUrl ? (
          <Suspense fallback={null}>
            <GenaiLoginPanel loginUrl={c.desktopLoginUrl} onDone={async () => { await refresh({ strict: true }); nav(returnTo, { replace: true }); }} />
          </Suspense>
        ) : (
          <div className="ui-col">
            {c.providers.map((p) => (
              <Button key={p.id} variant="primary" onClick={() => void signIn(p.id)} loading={busy === p.id} disabled={!!busy}>{t('login.with', { name: p.label })}</Button>
            ))}
            {desktop && busy && busy !== 'dev' && <div className="ui-row" role="status"><Spinner label="" /> {t('login.waitingBrowser')}</div>}
            {c.providers.length === 0 && <div className="ui-muted">{t('login.noProviders')}</div>}
            {c.devLogin && !desktop && (
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
