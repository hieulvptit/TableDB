import { NavLink, Outlet } from 'react-router-dom';
import { Badge, Button } from '@vnpay/ui';
import { useAuth } from '../auth/AuthContext';
import { changeLocale, getLocale, LOCALE_LABELS, t } from '../i18n';
import { useTheme } from './theme';
import { ErrorBoundary } from './ErrorBoundary';

const svg = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const SunIcon = () => <svg {...svg}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>;
const MoonIcon = () => <svg {...svg}><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" /></svg>;

const LOCALE_CODES = { en: 'EN', vi: 'VN' } as const;

export interface NavItem { to: string; label: string; end?: boolean; show?: boolean }

/** App chrome: brand + navigation links, env badge, theme/locale toggles, user and logout. */
export function Layout({ brand, links }: { brand: string; links: NavItem[] }) {
  const { me, logout } = useAuth();
  const env = import.meta.env.VITE_ENV ?? (import.meta.env.DEV ? 'dev' : 'prod');
  const { theme, toggle } = useTheme();
  const link = ({ isActive }: { isActive: boolean }) => `app-nav__link${isActive ? ' is-active' : ''}`;
  return (
    <div className="app-shell">
      <a href="#main" className="app-skip">{t('nav.skip')}</a>
      <header className="app-header">
        <div className="app-brand">VNPAY <span>{brand}</span></div>
        <nav aria-label={t('nav.main')} className="app-nav">
          {links.filter((l) => l.show !== false).map((l) => <NavLink key={l.to} to={l.to} end={l.end} className={link}>{l.label}</NavLink>)}
        </nav>
        <div className="app-header__right">
          <Badge tone={env === 'prod' ? 'danger' : env === 'test' ? 'warning' : 'info'} title={t('env.title')}>{t('env.label', { env: env.toUpperCase() })}</Badge>
          <button type="button" className="app-icon-btn" onClick={toggle} aria-label={t('theme.toggle')} title={t('theme.toggle')}>{theme === 'dark' ? <SunIcon /> : <MoonIcon />}</button>
          <button type="button" className="app-icon-btn app-lang" onClick={() => changeLocale(getLocale() === 'en' ? 'vi' : 'en')} aria-label={t('lang.label')} title={`${t('lang.label')}: ${LOCALE_LABELS[getLocale()]}`}>{LOCALE_CODES[getLocale()]}</button>
          {me && <span className="app-user" title={me.user.email}>{me.user.name} <span className="ui-muted">({me.user.roles.join(', ')})</span></span>}
          <Button size="sm" onClick={() => void logout()}>{t('nav.logout')}</Button>
        </div>
      </header>
      <main id="main" className="app-main" tabIndex={-1}>
        <ErrorBoundary><Outlet /></ErrorBoundary>
      </main>
    </div>
  );
}
