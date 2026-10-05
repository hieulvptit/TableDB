import { Badge } from '@vnpay/ui';
import type { SqlKind } from '@vnpay/shared';
import { t } from '../../i18n';

const TONE = { read: 'success', write: 'warning', ddl: 'danger', other: 'neutral' } as const;
export function SqlKindBadge({ kind, multi }: { kind: SqlKind; multi?: boolean }) {
  return (
    <span className="ui-row" style={{ display: 'inline-flex', gap: 4 }}>
      <Badge tone={TONE[kind]} title={t('sql.kindTitle')}>{t(`sql.kind.${kind}`)}</Badge>
      {multi && <Badge tone="danger">{t('sql.multi')}</Badge>}
    </span>
  );
}
