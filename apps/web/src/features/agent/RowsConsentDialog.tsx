import { Button, DataGrid, Dialog } from '@vnpay/ui';
import { t } from '../../i18n';
import { MAX_ROWS_TO_AGENT } from './context';

/** The only way rows can reach the Agent: user picked them in the grid AND confirms here, for the next message only. */
export function RowsConsentDialog({ open, columns, rows, onConfirm, onCancel }: { open: boolean; columns: string[]; rows: unknown[][]; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog open={open} alert wide title={t('rows.title')} onClose={onCancel}
      footer={<><Button data-autofocus onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" onClick={onConfirm}>{t('rows.confirm', { n: rows.length })}</Button></>}>
      <p style={{ margin: 0 }}>{t('rows.warn', { n: rows.length, max: MAX_ROWS_TO_AGENT })}</p>
      <div style={{ height: 240 }}>
        <DataGrid columns={columns.map((c) => ({ name: c }))} rows={rows} pageSize={20} caption={t('rows.title')} />
      </div>
    </Dialog>
  );
}
