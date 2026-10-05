import type { AgentTraceEvent } from '../../api/types';
import { t } from '../../i18n';

/** Friendly label of one harness event (tool names come from our own allow-list; anything else falls back to the raw name). */
export function stepLabel(e: AgentTraceEvent): string {
  if (e.kind === 'thinking') return t('trace.thinking');
  if (e.kind === 'nudge') return t('trace.nudge');
  if (e.kind === 'compact') return t('trace.compact');
  const key = `trace.tool.${e.name}`;
  const label = t(key);
  return label === key ? e.name : label;
}

/** The latest live step while the Agent works (SSE). */
export function LiveStatus({ events }: { events: AgentTraceEvent[] }) {
  const last = events[events.length - 1];
  const label = last ? stepLabel(last) : t('agent.thinking');
  const sub = last && last.depth > 0 ? ' · sub-agent' : '';
  return <span role="status" className="ui-muted">{label}{sub}…</span>;
}

/** Collapsible record of what the Agent did for one answer (finished tool / sub-agent steps only). */
export function TraceSummary({ trace }: { trace: AgentTraceEvent[] }) {
  const steps = trace.filter((e) => (e.kind === 'tool' || e.kind === 'subagent' || e.kind === 'nudge' || e.kind === 'compact') && e.note !== 'start');
  if (steps.length === 0) return null;
  return (
    <details className="agent-trace" style={{ fontSize: 'var(--ui-fs-sm)' }}>
      <summary>{t('trace.title')} · {t('trace.steps', { n: steps.length })}</summary>
      <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
        {steps.map((e, i) => (
          <li key={i} style={{ marginLeft: e.depth * 12, color: e.ok ? undefined : 'var(--ui-danger)' }}>
            {stepLabel(e)}{!e.ok ? ` (${t('trace.failed')})` : ''}{e.ms ? ` · ${e.ms} ms` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}
