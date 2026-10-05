import { Spinner } from '@vnpay/ui';
import { t } from '../i18n';

export function PageFallback() {
  return <div style={{ display: 'grid', placeItems: 'center', height: '60vh' }}><Spinner size="lg" label={t('common.loading')} /></div>;
}
