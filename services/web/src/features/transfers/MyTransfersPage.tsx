import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Tabs } from '@vnpay/ui';
import { useAuth } from '../../auth/AuthContext';
import { t } from '../../i18n';
import { TicketList } from './TicketList';

/** BO portal: the sender's own tickets (revoke is on the detail page), the inbox with download, and "new" (office → jump upload). */
export default function MyTransfersPage() {
  const [tab, setTab] = useState('sent');
  const { can } = useAuth();
  return (
    <div className="tr-page">
      <div className="tr-page__head">
        <h1>{t('tr.title')}</h1>
        {can('transfer:create') && (
          <Link to="/transfers/new" className="ui-btn ui-btn--primary tr-page__new">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 4.5v15m7.5-7.5h-15" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {t('tr.new')}
          </Link>
        )}
      </div>
      <Tabs label={t('tr.title')} activeId={tab} onChange={setTab}
        items={[{ id: 'sent', label: t('tr.sent'), content: <TicketList view="sent" /> }, { id: 'inbox', label: t('tr.inbox'), content: <TicketList view="inbox" /> }]} />
    </div>
  );
}
