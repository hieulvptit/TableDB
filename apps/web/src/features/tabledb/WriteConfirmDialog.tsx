import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog } from '@vnpay/ui';
import type { SqlClassification } from '@vnpay/shared';
import type { BindValue } from '../../gateway';
import { t } from '../../i18n';
import { SqlKindBadge } from './SqlKindBadge';

export interface WriteConfirmDialogProps {
  open: boolean;
  sql: string;
  classification: SqlClassification;
  connectionName?: string;
  /** values bound to the statement's :name placeholders (shown with the statement) */
  binds?: { name: string; value: BindValue }[];
  /** script run: statement position; adds "Skip" and turns Cancel into "Stop script" */
  script?: { index: number; total: number };
  /** pending manual transaction: the write is not committed until the user commits */
  manualCommit?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onSkip?: () => void;
}

/** Explicit confirmation before any non-read statement is sent with confirmWrite:true. Shows the exact statement + classification. */
export function WriteConfirmDialog({ open, sql, classification, connectionName, binds, script, manualCommit, onConfirm, onCancel, onSkip }: WriteConfirmDialogProps) {
  const [ack, setAck] = useState(false);
  useEffect(() => { if (open) setAck(false); }, [open, sql]);
  return (
    <Dialog open={open} alert title={script ? t('write.titleScript', { i: script.index, n: script.total }) : t('write.title')} onClose={onCancel} wide
      footer={<>
        <Button data-autofocus onClick={onCancel}>{script ? t('write.stop') : t('common.cancel')}</Button>
        {script && onSkip && <Button onClick={onSkip}>{t('write.skip')}</Button>}
        <Button variant="danger" disabled={!ack} onClick={onConfirm}>{t('write.run')}</Button>
      </>}>
      <div className="ui-row" style={{ flexWrap: 'wrap' }}>
        <span>{t('write.classified')}</span> <SqlKindBadge kind={classification.kind} multi={classification.multi} />
        {connectionName && <span className="ui-muted">{t('write.on', { name: connectionName })}</span>}
      </div>
      <pre className="ui-mono" aria-label={t('write.statement')} style={{ whiteSpace: 'pre-wrap', background: 'var(--ui-surface-2)', padding: 8, borderRadius: 6, maxHeight: 260, overflow: 'auto', margin: 0 }}>{sql}</pre>
      {binds && binds.length > 0 && (
        <table className="ui-table" aria-label={t('bind.title')}>
          <tbody>{binds.map((b, i) => <tr key={i}><td className="ui-mono">:{b.name}</td><td className="ui-mono">{b.value.type === 'null' ? 'NULL' : b.value.value}</td><td className="ui-muted">{t(`bind.t.${b.value.type}`)}</td></tr>)}</tbody>
        </table>
      )}
      <p style={{ margin: 0 }}>{classification.kind === 'ddl' ? t('write.warnDdl') : classification.kind === 'other' ? t('write.warnOther') : t('write.warnWrite')}</p>
      {manualCommit && <p className="ui-muted" style={{ margin: 0 }}>{t('write.manualCommit')}</p>}
      <Checkbox label={t('write.ack')} checked={ack} onChange={(e) => setAck(e.target.checked)} />
    </Dialog>
  );
}
