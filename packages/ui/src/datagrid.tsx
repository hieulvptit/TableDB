import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Spinner, cx } from './primitives';

export interface GridColumn { name: string; numeric?: boolean; title?: string }
export interface DataGridLabels {
  prev: string; next: string; rows: (from: number, to: number, total: number, more: boolean) => string; empty: string; selectRow: string; page: (p: number, n: number) => string;
}
const DEFAULT_LABELS: DataGridLabels = {
  prev: 'Trang trước', next: 'Trang sau', empty: 'Không có dữ liệu', selectRow: 'Chọn dòng',
  rows: (a, b, t, m) => `Dòng ${a}–${b} / ${t}${m ? '+' : ''}`, page: (p, n) => `Trang ${p}/${n}`,
};

export function formatCell(v: unknown): { text: string; isNull: boolean } {
  if (v === null || v === undefined) return { text: 'NULL', isNull: true };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$binary === 'string') return { text: `[binary ${String(o.length ?? '?')} B] ${o.$binary.slice(0, 24)}…`, isNull: false };
    return { text: JSON.stringify(v), isNull: false };
  }
  return { text: String(v), isNull: false };
}

export interface DataGridProps {
  columns: GridColumn[];
  rows: unknown[][];
  pageSize?: number;
  /** more rows available on the server (query.fetch); Next on the last loaded page triggers onLoadMore */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  selectable?: boolean;
  selected?: ReadonlySet<number>;
  maxSelect?: number;
  onSelectionChange?: (next: Set<number>) => void;
  labels?: Partial<DataGridLabels>;
  caption?: string;
  toolbar?: ReactNode;
  className?: string;
}

/** Paginated grid (client pages over the rows loaded so far; server paging via onLoadMore). Never renders more than pageSize rows. */
export function DataGrid({ columns, rows, pageSize = 100, hasMore, loadingMore, onLoadMore, selectable, selected, maxSelect, onSelectionChange, labels, caption, toolbar, className }: DataGridProps) {
  const L = { ...DEFAULT_LABELS, ...labels };
  const [page, setPage] = useState(0);
  const pending = useRef(false);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  useEffect(() => { if (page >= pages) setPage(pages - 1); }, [pages, page]);
  useEffect(() => { setPage(0); }, [columns]);
  useEffect(() => {
    if (pending.current && !loadingMore && rows.length > (page + 1) * pageSize) { pending.current = false; setPage((p) => p + 1); }
    else if (pending.current && !loadingMore && !hasMore) pending.current = false;
  }, [rows.length, loadingMore, hasMore, page, pageSize]);

  const start = page * pageSize;
  const view = useMemo(() => rows.slice(start, start + pageSize), [rows, start, pageSize]);
  const isLast = page >= pages - 1;
  const canNext = !isLast || !!hasMore;
  const next = () => {
    if (!isLast) setPage(page + 1);
    else if (hasMore && onLoadMore) { pending.current = true; onLoadMore(); }
  };
  const toggle = (idx: number) => {
    const s = new Set(selected ?? []);
    if (s.has(idx)) s.delete(idx);
    else { if (maxSelect !== undefined && s.size >= maxSelect) return; s.add(idx); }
    onSelectionChange?.(s);
  };

  return (
    <div className={cx('ui-grid', className)}>
      {toolbar && <div className="ui-grid__foot" style={{ borderTop: 0, borderBottom: '1px solid var(--ui-border)' }}>{toolbar}</div>}
      <div className="ui-grid__scroll">
        <table className="ui-table">
          {caption && <caption className="ui-sr-only">{caption}</caption>}
          <thead>
            <tr>
              {selectable && <th scope="col" style={{ width: 32 }}><span className="ui-sr-only">{L.selectRow}</span></th>}
              {columns.map((c, i) => <th key={`${c.name}-${i}`} scope="col" title={c.title}>{c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {view.length === 0 && (
              <tr><td colSpan={columns.length + (selectable ? 1 : 0)} className="ui-muted" style={{ textAlign: 'center', padding: 16 }}>{L.empty}</td></tr>
            )}
            {view.map((r, ri) => {
              const idx = start + ri;
              const sel = selected?.has(idx) ?? false;
              return (
                <tr key={idx} aria-selected={selectable ? sel : undefined}>
                  {selectable && (
                    <td><input type="checkbox" checked={sel} aria-label={`${L.selectRow} ${idx + 1}`} onChange={() => toggle(idx)} /></td>
                  )}
                  {columns.map((c, ci) => {
                    const f = formatCell(r[ci]);
                    return <td key={ci} className={cx(f.isNull && 'ui-null', c.numeric && !f.isNull && 'ui-num')} title={f.text.length > 40 ? f.text : undefined}>{f.text}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="ui-grid__foot">
        <span className="ui-grow" aria-live="polite">{rows.length === 0 ? '' : L.rows(start + 1, start + view.length, rows.length, !!hasMore)}</span>
        {loadingMore && <Spinner />}
        <Button size="sm" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>{L.prev}</Button>
        <span>{L.page(page + 1, pages)}</span>
        <Button size="sm" onClick={next} disabled={!canNext || !!loadingMore}>{L.next}</Button>
      </div>
    </div>
  );
}

/** Simple semantic table for small admin lists. */
export function Table({ children, caption, className }: { children: ReactNode; caption?: string; className?: string }) {
  return (
    <div style={{ overflow: 'auto' }}>
      <table className={cx('ui-table', className)}>{caption && <caption className="ui-sr-only">{caption}</caption>}{children}</table>
    </div>
  );
}
