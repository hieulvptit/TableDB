import { useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Button } from '@vnpay/ui';
import { apiClient } from '../api/client';
import type { AuthConfig } from '../api/types';
import { useAsync } from '../hooks';
import { t } from '../i18n';
import { AsyncView } from '../components/AsyncView';
import { useAuth } from './AuthContext';
import { fetchAuthConfig, safeReturnTo, webLoginUrl, WEB_OIDC_PROVIDER } from './login';

export default function LoginPage() {
  const [sp] = useSearchParams();
  const { status } = useAuth();
  const path = safeReturnTo(sp.get('returnTo'));
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const returnTo = path === base ? '/' : path.startsWith(`${base}/`) || path.startsWith(`${base}?`) ? path.slice(base.length) : path;
  const stepup = sp.get('stepup') === '1';
  const cfg = useAsync(() => fetchAuthConfig(), []);
  const signIn = () => {
    window.location.assign(webLoginUrl(apiClient, returnTo, stepup));
  };

  // There is one permitted provider, including reauthentication.
  useEffect(() => {
    if (stepup && cfg.data?.providers.some((x) => x.id === WEB_OIDC_PROVIDER)) window.location.assign(webLoginUrl(apiClient, returnTo, true));
  }, [stepup, cfg.data, returnTo]);

  if (status === 'authenticated' && !stepup) return <Navigate to={returnTo} replace />;
  return (
    <div className="login-page">
      <div className="ui-card nt-card login-card">
        <h1>VNPAY {t('brand.web')}</h1>
        {stepup && <p className="ui-muted">{t('login.stepup')}</p>}
        <AsyncView state={cfg}>{(c: AuthConfig) => {
          const provider = c.providers.find((p) => p.id === WEB_OIDC_PROVIDER);
          return (
            <div className="ui-col">
              {provider
                ? <Button variant="primary" onClick={signIn}>{t('login.with', { name: provider.label })}</Button>
                : <div className="ui-muted">{t('login.noProviders')}</div>}
            </div>
          );
        }}</AsyncView>
      </div>
    </div>
  );
}
