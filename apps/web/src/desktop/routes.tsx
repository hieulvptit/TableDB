import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { EmptyState } from '@vnpay/ui';
import { RequireAuth, useAuth } from '../auth/AuthContext';
import LoginPage from '../auth/LoginPage';
import { ForbiddenPage } from '../components/ForbiddenPage';
import { Layout } from '../components/Layout';
import { PageFallback } from '../components/PageFallback';
import { t } from '../i18n';

// Desktop: TableDB (+ Agent panel) and file upload only. No approvals, download or admin (they are not imported here).
const TableDbPage = lazy(() => import('../features/tabledb/TableDbPage'));
const MyTransfersPage = lazy(() => import('../features/transfers/DesktopMyTransfersPage'));
const NewTransferPage = lazy(() => import('../features/transfers/NewTransferPage'));
const TicketDetailPage = lazy(() => import('../features/transfers/DesktopTicketDetailPage'));

function Home() {
  const { can } = useAuth();
  if (can('db:connect')) return <Navigate to="/tabledb" replace />;
  if (can('transfer:create')) return <Navigate to="/transfers" replace />;
  return <ForbiddenPage />;
}

function DesktopLayout() {
  const { can } = useAuth();
  return <Layout brand={t('brand.desktop')} links={[
    { to: '/tabledb', label: t('nav.tabledb'), show: can('db:connect') },
    { to: '/transfers', label: t('nav.transfers'), end: true, show: can('transfer:create') },
    { to: '/transfers/new', label: t('nav.newTransfer'), show: can('transfer:create') },
  ]} />;
}

export function DesktopRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth><DesktopLayout /></RequireAuth>}>
          <Route index element={<Home />} />
          <Route path="/tabledb" element={<RequireAuth permission="db:connect"><TableDbPage /></RequireAuth>} />
          <Route path="/transfers" element={<RequireAuth permission="transfer:create"><MyTransfersPage /></RequireAuth>} />
          <Route path="/transfers/new" element={<RequireAuth permission="transfer:create"><NewTransferPage /></RequireAuth>} />
          <Route path="/transfers/:id" element={<RequireAuth permission="transfer:create"><TicketDetailPage /></RequireAuth>} />
          <Route path="*" element={<EmptyState title={t('nf.title')} />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
