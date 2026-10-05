import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '@vnpay/ui';

/** 16px stroke icons for the DBeaver-style vertical tool rails (inline so the app needs no icon dependency). */
const paths: Record<string, ReactNode> = {
  run: <path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" />,
  runNew: <><path d="M3 3.5v8l6-4z" fill="currentColor" stroke="none" /><path d="M12.5 9v5M10 11.5h5" /></>,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  unlock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" /></>,
  grid: <><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M2.5 6.5h11M2.5 10h11M6.5 6.5v7" /></>,
  json: <path d="M6 2.5c-1.5 0-2 .7-2 2v1.5c0 1-.5 2-1.5 2 1 0 1.5 1 1.5 2v1.5c0 1.3.5 2 2 2M10 2.5c1.5 0 2 .7 2 2v1.5c0 1 .5 2 1.5 2-1 0-1.5 1-1.5 2v1.5c0 1.3-.5 2-2 2" />,
  chart: <><path d="M2.5 2.5v11h11" /><path d="M5.5 11V8M8.5 11V5M11.5 11V7" /></>,
  dashboard: <><rect x="2.5" y="2.5" width="4.5" height="5" rx="1" /><rect x="9" y="2.5" width="4.5" height="3" rx="1" /><rect x="2.5" y="9.5" width="4.5" height="4" rx="1" /><rect x="9" y="7.5" width="4.5" height="6" rx="1" /></>,
  text: <path d="M3 4h10M3 7h10M3 10h7M3 13h5" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  export: <><path d="M8 2.5v8M4.8 7.3 8 10.5l3.2-3.2" /><path d="M2.5 11v2.5h11V11" /></>,
  fetchAll: <path d="M4 3.5 8 7.5l4-4M4 8.5l4 4 4-4" />,
  search: <><circle cx="7" cy="7" r="4.2" /><path d="m10.3 10.3 3.2 3.2" /></>,
  agent: <path d="M8 2l1.4 4.1L13.5 7.5 9.4 8.9 8 13l-1.4-4.1L2.5 7.5l4.1-1.4z" />,
  script: <><path d="M3 3.5v9l4.5-3z" fill="currentColor" stroke="none" /><path d="M9 4.5h4.5M9 8h4.5M9 11.5h4.5" /></>,
  explain: <><circle cx="4" cy="4" r="1.6" /><circle cx="4" cy="12" r="1.6" /><circle cx="12" cy="8" r="1.6" /><path d="M5.6 4H8v8H5.6M8 8h2.4" /></>,
  format: <path d="M2.5 3.5h11M4.5 6.5h9M4.5 9.5h7M2.5 12.5h11" />,
  open: <path d="M2.5 4.5v8h10l1.5-5.5H5L3.5 12.5M2.5 4.5V3h4l1 1.5h5V7" />,
  save: <><path d="M3 2.5h8l2 2v9H3z" /><path d="M5.5 2.5v3.5h5V2.5M5 13.5V9.5h6v4" /></>,
  history: <><path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7" /><path d="M2.5 2.5v2.5H5M8 5v3.2l2 1.3" /></>,
  snippet: <><path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" /><path d="M9 3 7 13" /></>,
  output: <><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="m5 6.5 2 1.5-2 1.5M8.5 10.5h3" /></>,
  commit: <path d="m3 8.5 3 3 7-7" />,
  rollback: <><path d="M4.5 5.5h6a3 3 0 0 1 0 6H6" /><path d="M6.5 3.3 4.3 5.5l2.2 2.2" /></>,
  pin: <><path d="M9.5 2.5 13.5 6.5l-2 .8-2.3 2.3-.5 2.9L3.8 7.6l2.9-.5L9 4.8z" /><path d="m5.3 10.7-2.8 2.8" /></>,
  compare: <><rect x="2.5" y="3" width="4.5" height="10" rx="1" /><rect x="9" y="3" width="4.5" height="10" rx="1" /><path d="M4 6h1.5M10.5 6H12M4 9h1.5M10.5 10H12" /></>,
  refresh: <><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.8v2.7h-2.7" /></>,
  filter: <path d="M2.5 3.5h11L9.2 8.6v4.4l-2.4-1.2V8.6z" />,
  edit: <><path d="m10.5 2.8 2.7 2.7-7.5 7.5H3v-2.7z" /><path d="m9 4.3 2.7 2.7" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /><path d="M7 7v4M9 7v4" /></>,
  eye: <><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" /><circle cx="8" cy="8" r="2" /></>,
  diagram: <><rect x="2" y="2.5" width="5" height="4" rx=".8" /><rect x="9" y="9.5" width="5" height="4" rx=".8" /><path d="M4.5 6.5v5H9M7 4.5h4.5v5" /></>,
  database: <><ellipse cx="8" cy="4" rx="5" ry="1.8" /><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" /></>,
  activity: <path d="M1.5 8.5h2.8l1.7-5 3 10 1.8-5h3.7" />,
  schemaDiff: <><path d="M3 3.5h4M3 6.5h4M3 9.5h4M3 12.5h4" /><path d="M10 5h4M12 3v4M10 11h4" /></>,
  code: <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" />,
  dbAdd: <><ellipse cx="7" cy="4" rx="4.5" ry="1.6" /><path d="M2.5 4v7c0 .9 2 1.6 4.5 1.6M11.5 4v3.5M2.5 7.5c0 .9 2 1.6 4.5 1.6" /><path d="M12 10v5M9.5 12.5h5" /></>,
  eject: <><path d="M3 9.5h10L8 3.5z" /><path d="M3 12.5h10" /></>,
  settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" /></>,
  send: <path d="M2.5 2.8 13.5 8 2.5 13.2 4 8zM4 8h5" />,
  bolt: <path d="M9 1.8 3.5 9h4l-.5 5.2L12.5 7h-4z" />,
  shield: <><path d="M8 1.8 3 3.6v4c0 3 2 5 5 6.6 3-1.6 5-3.6 5-6.6v-4z" /><path d="m5.8 8 1.7 1.7L10.5 6.5" /></>,
  trend: <path d="M2 11.5 6 7.5l2.5 2.5L14 4.5M10.5 4.5H14V8" />,
  chevron: <path d="m4 6 4 4 4-4" />,
  undo: <><path d="M4.5 5.5h6a3 3 0 0 1 0 6H6" /><path d="M6.5 3.3 4.3 5.5l2.2 2.2" /></>,
};

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

/** Square icon-only button of a tool rail; `label` is both the tooltip and the accessible name. */
export function RailButton({ icon, label, tone, badge, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName; label: string; tone?: 'run' | 'danger' | 'warn'; badge?: number;
}) {
  return (
    <button type="button" className={cx('tb-rail__btn', tone && `tb-rail__btn--${tone}`, className)} title={label} aria-label={label} {...rest}>
      <Icon name={icon} />
      {!!badge && <span className="tb-rail__badge" aria-hidden="true">{badge}</span>}
    </button>
  );
}

export function Rail({ label, children }: { label: string; children: ReactNode }) {
  return <div role="toolbar" aria-orientation="vertical" aria-label={label} className="tb-rail">{children}</div>;
}

export const RailSep = () => <span className="tb-rail__sep" aria-hidden="true" />;
