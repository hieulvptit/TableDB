import { Button, useToast } from '@vnpay/ui';
import { t } from '../../i18n';
import { parseChartSpec } from '../report/chart';
import { useTableDb } from '../tabledb/store';

/** Chart proposed by the Agent: checked against the real columns of the current result and applied only on click. */
export function ChartBlock({ code }: { code: string }) {
  const db = useTableDb();
  const toast = useToast();
  let raw: unknown = null;
  try { raw = JSON.parse(code); } catch { /* shown as text below */ }
  const apply = () => {
    const tab = db.activeTab;
    const out = tab?.outputs.find((o) => o.id === tab.activeOutputId) ?? tab?.outputs[0];
    const cols = out?.result?.columns;
    if (!tab || !out || !cols?.length) { toast.push(t('chart.applyNone'), 'error'); return; }
    const spec = parseChartSpec(raw, cols);
    if (!spec) { toast.push(t('chart.applyBad'), 'error'); return; }
    db.patchOutput(tab.id, out.id, { chart: spec });
    db.updateTab(tab.id, { view: 'chart' });
    toast.push(t('chart.applied'), 'success');
  };
  return (
    <div className="ui-card" style={{ padding: 8 }}>
      <pre className="ui-mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{code}</pre>
      {!!raw && typeof raw === 'object' && <div className="ui-row" style={{ marginTop: 6 }}><Button size="sm" variant="primary" onClick={apply}>{t('chart.apply')}</Button></div>}
    </div>
  );
}
