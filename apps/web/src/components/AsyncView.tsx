import type { ReactNode } from 'react';
import { Button, EmptyState, Spinner } from '@vnpay/ui';
import { t } from '../i18n';
import type { AsyncState } from '../hooks';

/** Loading / 403 / error wrapper: a 403 from the server is shown as a normal "no access" state, not a crash. */
export function AsyncView<T>({ state, children }: { state: AsyncState<T>; children: (data: T) => ReactNode }) {
  if (state.forbidden) return <EmptyState title={t('forbidden.title')} />;
  if (state.error && state.data === undefined) return <EmptyState title={t('common.error')} description={state.error} action={<Button onClick={state.reload}>{t('common.retry')}</Button>} />;
  if (state.data === undefined) return <div style={{ display: 'grid', placeItems: 'center', padding: 32 }}><Spinner size="lg" label={t('common.loading')} /></div>;
  return <>{children(state.data)}</>;
}
