import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { EmptyState } from '@vnpay/ui';
import { RequireAuth, useAuth } from '../auth/AuthContext';
import LoginPage from '../auth/LoginPage';
import { Layout } from '../components/Layout';
import { PageFallback } from '../components/PageFallback';
import { t } from '../i18n';

// BO portal: approvals + download, and uploads going office → jump. No TableDB, no Agent (they are not imported here).
const MyTransfersPage = lazy(() => import('../features/transfers/MyTransfersPage'));
const NewTransferPage = lazy(() => import('../features/transfers/NewTransferPage'));
const TicketDetailPage = lazy(() => import('../features/transfers/TicketDetailPage'));
const ApprovalsPage = lazy(() => import('../features/transfers/ApprovalsPage'));
const AuditPage = lazy(() => import('../features/admin/AdminPage').then((m) => ({ default: m.AuditPage })));

function Home() {
  const { can } = useAuth();
  return <Navigate to={can('transfer:create') || can('transfer:download') ? '/transfers' : can('transfer:approve') ? '/approvals' : can('audit:read') ? '/audit' : '/transfers'} replace />;
}

function WebLayout() {
  const { can } = useAuth();
  return <Layout brand={t('brand.web')} links={[
    { to: '/transfers', label: t('nav.transfers'), show: can('transfer:create') || can('transfer:download') },
    { to: '/approvals', label: t('nav.approvals'), show: can('transfer:approve') },
    { to: '/audit', label: t('nav.audit'), show: can('audit:read') },
  ]} />;
}

export function WebRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth><WebLayout /></RequireAuth>}>
          <Route index element={<Home />} />
          <Route path="/transfers" element={<RequireAuth permission={['transfer:create', 'transfer:download']}><MyTransfersPage /></RequireAuth>} />
          <Route path="/transfers/new" element={<RequireAuth permission="transfer:create"><NewTransferPage /></RequireAuth>} />
          <Route path="/transfers/:id" element={<RequireAuth permission={['transfer:create', 'transfer:download', 'transfer:approve', 'audit:read']}><TicketDetailPage /></RequireAuth>} />
          <Route path="/approvals" element={<RequireAuth permission="transfer:approve"><ApprovalsPage /></RequireAuth>} />
          <Route path="/audit" element={<RequireAuth permission="audit:read"><AuditPage /></RequireAuth>} />
          <Route path="*" element={<EmptyState title={t('nf.title')} />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
