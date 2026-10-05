import { EmptyState } from '@vnpay/ui';
import { t } from '../i18n';

export function ForbiddenPage() {
  return <EmptyState title={t('forbidden.title')} />;
}
