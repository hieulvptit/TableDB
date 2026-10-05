import { Button } from '@vnpay/ui';
import { t } from '../i18n';
import { useAuth } from './AuthContext';
import { isGenaiSession } from './desktopLogin';

/** Desktop-only logout control. For a broker (genai) session logout also forgets the IdP cookies. */
export default function SsoLogoutControl() {
  const { logout } = useAuth();
  const genai = isGenaiSession();
  return <Button size="sm" onClick={() => void logout(genai ? { forgetSso: true } : undefined)}>{t('nav.logout')}</Button>;
}
