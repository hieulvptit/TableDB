import type { ReactNode } from 'react';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { ToastProvider, TooltipLayer } from '@vnpay/ui';
import { AuthProvider } from './auth/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { t } from './i18n';

const future = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

/** Providers + router shared by both targets. Desktop serves from tauri://localhost with a relative base: hash routing. */
export function AppShell({ router, children }: { router: 'browser' | 'hash'; children: ReactNode }) {
  const Router = router === 'hash' ? HashRouter : BrowserRouter;
  return (
    <ErrorBoundary>
      <ToastProvider dismissLabel={t('toast.dismiss')}>
        <Router future={future}>
          <AuthProvider>{children}</AuthProvider>
        </Router>
        <TooltipLayer />
      </ToastProvider>
    </ErrorBoundary>
  );
}
