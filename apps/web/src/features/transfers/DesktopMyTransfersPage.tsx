import { Link } from 'react-router-dom';
import { t } from '../../i18n';
import { TicketList } from './TicketList';

/** Desktop: "Lượt gửi của tôi" (view=sent). No inbox/download/approvals on the desktop. */
export default function DesktopMyTransfersPage() {
  return (
    <div className="tr-page">
      <div className="tr-page__head">
        <h1>{t('tr.mine')}</h1>
        <Link to="/transfers/new" className="ui-btn ui-btn--primary tr-page__new">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 4.5v15m7.5-7.5h-15" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {t('tr.new')}
        </Link>
      </div>
      <TicketList view="sent" />
    </div>
  );
}
