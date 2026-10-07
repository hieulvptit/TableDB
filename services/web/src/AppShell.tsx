import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { ToastProvider, TooltipLayer } from '@vnpay/ui';
import { AuthProvider } from './auth/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { t } from './i18n';

const future = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

/** Providers + browser router for the BO portal's configured base path. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <ToastProvider dismissLabel={t('toast.dismiss')}>
        <BrowserRouter basename={import.meta.env.BASE_URL} future={future}>
          <AuthProvider>{children}</AuthProvider>
        </BrowserRouter>
        <TooltipLayer />
      </ToastProvider>
    </ErrorBoundary>
  );
}
