import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, EmptyState, Spinner, cx, formatCell, useToast } from '@vnpay/ui';
import { intlLocale, t } from '../../i18n';
import { ChartPanel } from '../report/ChartPanel';
import { suggestSpec } from '../report/chart';
import { newWidgetId, saveWidget } from './workspace';
import { classifySql } from '@vnpay/shared';
import { RowsConsentDialog } from '../agent/RowsConsentDialog';
import { MAX_ROWS_TO_AGENT as MAX_AGENT_ROWS } from '../agent/context';
import { ContextMenu, runShortcut, type MenuItem } from './ContextMenu';
import { aggregate, inList, isBinary, matches, normRange, NUMERIC_TYPE, rangeTsv, viewOrder, type CellRange, type SortSpec } from './gridModel';
import { Rail, RailButton, RailSep } from './icons';
import { CompareDialog, EditReviewDialog, ExportResultDialog, MessagesView, PlanView, ScriptLogView, ValueViewer } from './resultExtras';
import { jsonLines, textLines } from './resultText';
import { useTableDb } from './store';
import { deleteRowSql, insertRowSql, quoteIdent, sqlLiteral, updateRowSql, type ColType } from './tableSql';
import type { TableRef } from './schemaStore';
import type { EditorTabState, OutputState, ResultViewMode } from './types';

const ROW_H = 28;          // grid row height (px) — rows are virtualized, so it must stay fixed (see .rv-table in app.css)
const LINE_H = 18;         // JSON / Text line height (px)
const OVERSCAN = 20;       // extra rows rendered above/below the viewport
const NEAR_END_PX = 400;   // start fetching the next page this close to the bottom
const BINARY_TYPE = /blob|bytea|binary|raw|image|lob/i;

const VIEWS: ResultViewMode[] = ['grid', 'json', 'text', 'chart'];

/** Editing of a table data view (needs a primary key; the sidecar still requires a write-enabled session). */
export interface EditCtx {
  table: TableRef;
  /** primary key column names; empty = not editable */
  pk: string[];
  canEdit: boolean;
  /** run the generated statements (confirmed by the user); true = saved */
  onSave: (stmts: string[]) => Promise<boolean>;
}

/** Scroll position + viewport height of the result area, and the "near the end → fetch next page" trigger. */
function useInfiniteScroll(opts: { hasMore: boolean; loading: boolean; onLoadMore: () => void; resetKey: unknown; contentKey: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, height: 0 });
  const o = useRef(opts); o.current = opts;

  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setPos((p) => (p.top === el.scrollTop && p.height === el.clientHeight ? p : { top: el.scrollTop, height: el.clientHeight }));
    const { hasMore, loading, onLoadMore } = o.current;
    if (hasMore && !loading && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX) onLoadMore();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({ top: el.scrollTop, height: el.clientHeight });
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [check]);

  // a new result (or another view mode) starts at the top
  useEffect(() => { if (ref.current) ref.current.scrollTop = 0; setPos((p) => ({ ...p, top: 0 })); }, [opts.resetKey]);
  // keep filling while the loaded rows do not reach the bottom of a tall viewport (only when laid out: height > 0)
  useEffect(() => {
    const el = ref.current;
    if (el && el.clientHeight > 0 && !opts.loading && opts.hasMore && el.scrollHeight - el.clientHeight < NEAR_END_PX) o.current.onLoadMore();
  }, [opts.contentKey, opts.loading, opts.hasMore]);

  return { ref, pos, onScroll: check };
}

/** Visible slice [first, last) of `count` fixed-height items. */
function windowOf(count: number, itemH: number, top: number, height: number) {
  const vh = height || 600; // not laid out yet (or jsdom): render a first screenful
  const first = Math.max(0, Math.floor(top / itemH) - OVERSCAN);
  const last = Math.min(count, Math.ceil((top + vh) / itemH) + OVERSCAN);
  return { first, last };
}

/** Column width estimated from the header and the first rows, then kept (a virtualized table must not re-layout while scrolling). */
function estimateWidths(columns: Array<{ name: string }>, rows: unknown[][]) {
  const sample = Math.min(rows.length, 200);
  return columns.map((c, i) => {
    let chars = c.name.length + 4;
    for (let r = 0; r < sample; r++) chars = Math.max(chars, formatCell(rows[r]![i]).text.length);
    return Math.round(Math.min(420, Math.max(64, chars * 7.4 + 24)));
  });
}

interface Col { name: string; typeName?: string; numeric: boolean; binary: boolean }
interface Edits { updates: Map<number, Map<number, unknown>>; deleted: Set<number>; inserted: unknown[][] }
const noEdits = (): Edits => ({ updates: new Map(), deleted: new Set(), inserted: [] });
const editCount = (e: Edits) => [...e.updates.keys()].filter((k) => !e.deleted.has(k)).length + e.deleted.size + e.inserted.length;

function LinesView({ lines, first, last, label }: { lines: string[]; first: number; last: number; label: string }) {
  return (
    <div role="region" aria-label={label} className="rv-lines" style={{ height: lines.length * LINE_H }}>
      <pre className="ui-mono" style={{ top: first * LINE_H, lineHeight: `${LINE_H}px` }}>{lines.slice(first, last).join('\n')}</pre>
    </div>
  );
}

/**
 * One output (result set) of an editor or table-data tab: error / status cards, then Grid · JSON · Text with infinite
 * scroll (the next server page is fetched when the user scrolls near the end). Grid: sort, column filters, resizable
 * columns, cell range selection + copy, value viewer, and in-place editing for table views with a primary key.
 */
export function ResultPanel({ tab, output, emptyDescription, edit }: { tab: EditorTabState; output?: OutputState; emptyDescription?: string; edit?: EditCtx }) {
  const db = useTableDb();
  const toast = useToast();
  const out: OutputState = output ?? { id: '', title: '', sql: '' };
  const outId = output?.id;
  const r = out.result;
  const running = !!out.running;
  const view = tab.view ?? 'grid';
  const conn = db.connections.find((c) => c.id === tab.connId) ?? null;
  const driver = conn?.driver ?? 'postgresql';
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [fetchingAll, setFetchingAll] = useState(false);
  const [consent, setConsent] = useState(false);
  const [range, setRange] = useState<CellRange | null>(null);
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [localSort, setLocalSort] = useState<SortSpec | null>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const [viewer, setViewer] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dlg, setDlg] = useState<null | 'export' | 'compare' | 'review'>(null);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [edits, setEdits] = useState<Edits>(noEdits);
  const [saving, setSaving] = useState(false);
  const dragging = useRef(false);
  useEffect(() => { setSelected(new Set()); setRange(null); setEditing(null); setEdits(noEdits()); setLocalSort(null); setFilters({}); }, [r?.columns]);

  const cols = useMemo<Col[]>(() => (r?.columns ?? []).map((c) => ({ name: c.name, typeName: c.typeName, numeric: NUMERIC_TYPE.test(c.typeName ?? ''), binary: BINARY_TYPE.test(c.typeName ?? '') })), [r?.columns]);
  const baseRows = r?.rows ?? [];
  // re-run / auto-refresh yields a new columns array: keep the widths the user dragged for columns that did not change
  const prevCols = useRef<Col[]>([]);
  useEffect(() => {
    const prev = prevCols.current;
    prevCols.current = cols;
    const est = estimateWidths(cols, baseRows);
    setWidths((w) => est.map((x, i) => (prev[i]?.name === cols[i]!.name && w[i] != null ? w[i]! : x)));
  }, [cols]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- editing model (table data view)
  const pkIdx = useMemo(() => (edit ? edit.pk.map((n) => cols.findIndex((c) => c.name === n)) : []), [edit, cols]);
  const editable = !!edit?.canEdit && pkIdx.length > 0 && pkIdx.every((i) => i >= 0) && view === 'grid';
  const valueAt = useCallback((orig: number, c: number): unknown => {
    if (orig >= baseRows.length) return edits.inserted[orig - baseRows.length]?.[c];
    const u = edits.updates.get(orig);
    return u && u.has(c) ? u.get(c) : baseRows[orig]?.[c];
  }, [baseRows, edits]);
  const rowAt = useCallback((orig: number) => cols.map((_, c) => valueAt(orig, c)), [cols, valueAt]);

  // ---- display order: column filters + sort (client side on loaded rows; table views sort on the server)
  const serverSort = tab.kind === 'table';
  const sort: SortSpec | null = serverSort
    ? (tab.orderBy ? { col: cols.findIndex((c) => c.name === tab.orderBy!.column), desc: tab.orderBy.desc } : null)
    : localSort;
  const order = useMemo(() => {
    const base = viewOrder(baseRows, cols.map((c) => c.numeric), filters, serverSort ? null : localSort);
    return [...base, ...edits.inserted.map((_, k) => baseRows.length + k)];
  }, [baseRows, cols, filters, localSort, serverSort, edits.inserted]);
  const filtering = Object.values(filters).some((v) => v.trim());

  const lines = useMemo(() => {
    const rows = order.map((i) => rowAt(i));
    return view === 'json' ? jsonLines(cols.map((c) => c.name), rows) : view === 'text' ? textLines(cols, rows) : [];
  }, [view, cols, order, rowAt]);
  const chartRows = useMemo(() => (view === 'chart' ? order.map((i) => rowAt(i)) : []), [view, order, rowAt]);
  const count = view === 'grid' ? order.length : lines.length;

  const loadMore = useCallback(() => { void db.loadMore(tab.id, outId); }, [db, tab.id, outId]);
  const { ref, pos, onScroll } = useInfiniteScroll({
    hasMore: !!r?.hasMore && !out.error && !filtering, loading: !!out.loadingMore || running, onLoadMore: loadMore,
    resetKey: `${String(r?.cursorId ?? r?.elapsedMs)}|${view}|${cols.length}`, contentKey: count,
  });
  const { first, last } = windowOf(count, view === 'grid' ? ROW_H : LINE_H, pos.top, pos.height);

  // auto refresh (read results only; skipped while something runs)
  useEffect(() => {
    if (!out.refreshSec || !outId) return;
    const h = setInterval(() => { void db.refreshOutput(tab.id, outId); }, out.refreshSec * 1000);
    return () => clearInterval(h);
  }, [out.refreshSec, outId, tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (idx: number) => setSelected((cur) => {
    const s = new Set(cur);
    if (s.has(idx)) s.delete(idx);
    else if (s.size < MAX_AGENT_ROWS) s.add(idx);
    return s;
  });

  const pickable = order.filter((o) => o < baseRows.length).slice(0, MAX_AGENT_ROWS);
  const allPicked = pickable.length > 0 && pickable.every((o) => selected.has(o));
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(pickable));

  const nr = range ? normRange(range) : null;
  const rangeRows = (rg: CellRange | null) => (rg ? order.slice(rg.r1, rg.r2 + 1) : []);
  const rangeValues = (rg: CellRange | null) => rangeRows(rg).map((o) => cols.slice(rg!.c1, rg!.c2 + 1).map((_, k) => valueAt(o, rg!.c1 + k)));
  const agg = useMemo(() => (nr && (nr.r2 > nr.r1 || nr.c2 > nr.c1) ? aggregate(rangeValues(nr).flat()) : null), [nr?.r1, nr?.r2, nr?.c1, nr?.c2, order, edits]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = (text: string, n: number) => void navigator.clipboard?.writeText(text).then(() => toast.push(t('result.copied', { n }), 'success'), () => {});
  const copyRange = (withHeader: boolean) => {
    if (!nr) return;
    copy(rangeTsv(cols.slice(nr.c1, nr.c2 + 1).map((c) => c.name), rangeValues(nr), withHeader), nr.r2 - nr.r1 + 1);
  };
  const copyLines = () => {
    if (nr && view === 'grid') { copyRange(false); return; }
    const text = (view === 'grid' ? textLines(cols, order.map(rowAt)) : lines).join('\n');
    copy(text, order.length);
  };
  const fetchAll = async () => { setFetchingAll(true); try { await db.loadAll(tab.id, outId); } finally { setFetchingAll(false); } };
  const pickedRows = r ? [...selected].sort((a, b) => a - b).map((i) => r.rows[i] ?? []) : [];

  // ---- editing actions
  const setCell = (orig: number, c: number, v: unknown) => setEdits((e) => {
    const next: Edits = { updates: new Map(e.updates), deleted: new Set(e.deleted), inserted: [...e.inserted] };
    if (orig >= baseRows.length) { const k = orig - baseRows.length; const row = [...next.inserted[k]!]; row[c] = v; next.inserted[k] = row; return next; }
    const m = new Map(next.updates.get(orig) ?? []);
    const original = baseRows[orig]?.[c];
    if (JSON.stringify(original ?? null) === JSON.stringify(v ?? null)) m.delete(c); else m.set(c, v);
    if (m.size) next.updates.set(orig, m); else next.updates.delete(orig);
    return next;
  });
  const addRow = (from?: number) => {
    setEdits((e) => ({ ...e, inserted: [...e.inserted, from !== undefined ? cols.map((_, c) => (pkIdx.includes(c) ? undefined : valueAt(from, c))) : cols.map(() => undefined)] }));
    setTimeout(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, 0);
  };
  const deleteRows = (origs: number[]) => setEdits((e) => {
    const next: Edits = { updates: new Map(e.updates), deleted: new Set(e.deleted), inserted: [...e.inserted] };
    const ins = new Set(origs.filter((o) => o >= baseRows.length).map((o) => o - baseRows.length));
    next.inserted = next.inserted.filter((_, k) => !ins.has(k));
    for (const o of origs) if (o < baseRows.length) { if (next.deleted.has(o)) next.deleted.delete(o); else next.deleted.add(o); }
    return next;
  });
  const statements = (): string[] => {
    if (!edit) return [];
    const types: ColType[] = cols.map((c) => ({ name: c.name, typeName: c.typeName ?? '' }));
    const out: string[] = [];
    for (const [o, m] of edits.updates) if (!edits.deleted.has(o)) out.push(updateRowSql(edit.table, driver, types, pkIdx, baseRows[o]!, m));
    for (const o of edits.deleted) out.push(deleteRowSql(edit.table, driver, types, pkIdx, baseRows[o]!));
    for (const row of edits.inserted) out.push(insertRowSql(edit.table, driver, types, row));
    return out;
  };
  const save = async () => {
    if (!edit) return;
    setSaving(true);
    try { if (await edit.onSave(statements())) { setEdits(noEdits()); setDlg(null); } } finally { setSaving(false); }
  };
  const pendingEdits = editCount(edits);

  // ---- header: sort + resize
  const onSort = (c: number) => {
    const cur = sort && sort.col === c ? sort : null;
    const next: SortSpec | null = !cur ? { col: c, desc: false } : !cur.desc ? { col: c, desc: true } : null;
    if (serverSort) { if (pendingEdits === 0) void db.setTableSort(tab.id, next ? { column: cols[c]!.name, desc: next.desc } : null); else toast.push(t('edit.saveFirst'), 'warning'); }
    else setLocalSort(next);
  };
  // Pointer capture keeps the drag alive when the cursor leaves the handle / webview; the click that follows a drag
  // (fired on the header) must not sort, hence `resized`.
  const resized = useRef(false);
  const startResize = (c: number, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget, id = e.pointerId;
    const x0 = e.clientX, w0 = widths[c] ?? 120;
    try { el.setPointerCapture(id); } catch { /* capture is best effort */ }
    resized.current = false;
    document.body.classList.add('rv-resizing');
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 2) resized.current = true;
      setWidths((w) => { const n = [...w]; n[c] = Math.max(40, Math.min(1200, w0 + ev.clientX - x0)); return n; });
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      try { el.releasePointerCapture(id); } catch { /* already released */ }
      document.body.classList.remove('rv-resizing');
      setTimeout(() => { resized.current = false; }, 0);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };

  // ---- cell selection
  useEffect(() => { const up = () => { dragging.current = false; }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up); }, []);
  const ensureVisible = (row: number) => {
    const el = ref.current;
    if (!el) return;
    const top = row * ROW_H, head = ROW_H * (showFilters ? 2 : 1);
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H + head > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H + head - el.clientHeight;
  };
  const onCellDown = (e: ReactMouseEvent, row: number, c: number) => {
    if (e.button !== 0) return;
    if (e.shiftKey && range) setRange({ ...range, r2: row, c2: c });
    else setRange({ r1: row, c1: c, r2: row, c2: c });
    dragging.current = true;
    ref.current?.focus({ preventScroll: true });
  };
  const onCellEnter = (row: number, c: number) => { if (dragging.current && range) setRange({ ...range, r2: row, c2: c }); };
  const cellText = (v: unknown) => (v === null || v === undefined ? '' : formatCell(v).text);

  const onKey = (e: ReactKeyboardEvent) => {
    if (view !== 'grid' || editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); if (order.length) setRange({ r1: 0, c1: 0, r2: order.length - 1, c2: cols.length - 1 }); return; }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copyRange(e.shiftKey); return; }
    const chord = e.altKey || mod || /^(F\d+|Insert|Delete|Enter)$/.test(e.key);
    if (chord && canRefresh && runShortcut(refreshItems, e)) return;
    if (!range) return;
    if (chord && runShortcut(gridItems(range.r2, range.c2), e)) return;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const r2 = Math.max(0, Math.min(order.length - 1, range.r2 + dr)), c2 = Math.max(0, Math.min(cols.length - 1, range.c2 + dc));
      setRange(e.shiftKey ? { ...range, r2, c2 } : { r1: r2, c1: c2, r2, c2 });
      ensureVisible(r2);
    };
    const page = Math.max(1, Math.floor((ref.current?.clientHeight ?? 600) / ROW_H) - 2);
    switch (e.key) {
      case 'ArrowDown': move(1, 0); break;
      case 'ArrowUp': move(-1, 0); break;
      case 'ArrowRight': move(0, 1); break;
      case 'ArrowLeft': move(0, -1); break;
      case 'PageDown': move(page, 0); break;
      case 'PageUp': move(-page, 0); break;
      case 'Home': move(mod ? -order.length : 0, mod ? 0 : -cols.length); break;
      case 'End': move(mod ? order.length : 0, mod ? 0 : cols.length); break;
      case 'Escape': setRange(null); break;
      case 'Enter': case 'F2':
        e.preventDefault();
        if (e.shiftKey || !editable) setViewer(true);
        else if (!cols[range.c2]!.binary) setEditing({ r: range.r2, c: range.c2 });
        break;
      case 'Delete':
        if (editable && nr) { e.preventDefault(); for (const o of rangeRows(nr)) for (let c = nr.c1; c <= nr.c2; c++) if (!cols[c]!.binary) setCell(o, c, null); }
        break;
      default:
    }
  };

  // ---- context menu
  const tableTab = tab.kind === 'table' && tab.table;
  const filterBy = (c: number, v: unknown, exclude: boolean) => {
    const col = cols[c]!;
    if (tableTab && conn) {
      const id = quoteIdent(col.name, driver);
      const cond = v === null || v === undefined ? `${id} IS ${exclude ? 'NOT ' : ''}NULL` : `${id} ${exclude ? '<>' : '='} ${sqlLiteral(v, col.typeName ?? '', driver)}`;
      const cur = (tab.filter ?? '').trim();
      if (pendingEdits) { toast.push(t('edit.saveFirst'), 'warning'); return; }
      void db.setTableFilter(tab.id, cur ? `(${cur}) AND ${cond}` : cond);
    } else {
      setShowFilters(true);
      setFilters((f) => ({ ...f, [c]: v === null || v === undefined ? (exclude ? '!null' : 'null') : `${exclude ? '!' : '='}${cellText(v).toLowerCase()}` }));
    }
  };
  const gridItems = (row: number, c: number): MenuItem[] => {
    const inRange = nr && row >= nr.r1 && row <= nr.r2 && c >= nr.c1 && c <= nr.c2;
    const rg = inRange ? nr! : { r1: row, c1: c, r2: row, c2: c };
    if (!inRange) setRange(rg);
    const orig = order[row]!;
    const v = valueAt(orig, c);
    const rowsOf = rangeRows(rg);
    const names = cols.map((x) => x.name);
    const items: MenuItem[] = [
      { key: 'copy', label: t('grid.copy'), shortcut: 'Mod+C', onSelect: () => copy(rangeTsv([], rangeValues(rg), false), rowsOf.length) },
      { key: 'copyH', label: t('grid.copyHeader'), shortcut: 'Mod+Shift+C', onSelect: () => copy(rangeTsv(cols.slice(rg.c1, rg.c2 + 1).map((x) => x.name), rangeValues(rg), true), rowsOf.length) },
      { key: 'copyRows', shortcut: 'Alt+R', label: t('grid.copyRows'), onSelect: () => copy(rangeTsv(names, rowsOf.map(rowAt), true), rowsOf.length) },
      { key: 'copyJson', shortcut: 'Alt+J', label: t('grid.copyJson'), onSelect: () => copy(JSON.stringify(rowsOf.map((o) => Object.fromEntries(names.map((n, k) => [n, valueAt(o, k) ?? null]))), null, 2), rowsOf.length) },
      { key: 'copyIn', shortcut: 'Alt+I', label: t('grid.copyIn'), onSelect: () => copy(inList(rowsOf.map((o) => valueAt(o, c)), cols[c]!.typeName ?? '', driver), rowsOf.length) },
      ...(tableTab ? [{ key: 'copyIns', shortcut: 'Alt+S', label: t('grid.copyInsert'), onSelect: () => copy(rowsOf.map((o) => `${insertRowSql(tab.table!, driver, cols.map((x) => ({ name: x.name, typeName: x.typeName ?? '' })), rowAt(o))};`).join('\n'), rowsOf.length) }] : []),
      { key: 's1', label: '', separator: true },
      { key: 'fEq', shortcut: 'Alt+F', label: t('grid.filterEq', { v: v === null || v === undefined ? 'NULL' : cellText(v).slice(0, 30) }), disabled: isBinary(v), onSelect: () => filterBy(c, v, false) },
      { key: 'fNe', shortcut: 'Alt+Shift+F', label: t('grid.filterNe'), disabled: isBinary(v), onSelect: () => filterBy(c, v, true) },
      ...(filtering && !tableTab ? [{ key: 'fClr', shortcut: 'Alt+X', label: t('grid.clearFilters'), onSelect: () => setFilters({}) }] : []),
      { key: 's2', label: '', separator: true },
      { key: 'view', label: t('grid.viewValue'), shortcut: 'Shift+Enter', onSelect: () => setViewer(true) },
    ];
    if (editable) {
      items.push(
        { key: 's3', label: '', separator: true },
        { key: 'edit', label: t('edit.cell'), shortcut: 'F2', disabled: cols[c]!.binary, onSelect: () => setEditing({ r: row, c }) },
        { key: 'null', label: t('edit.setNull'), shortcut: 'Delete', disabled: cols[c]!.binary, onSelect: () => { for (const o of rowsOf) for (let k = rg.c1; k <= rg.c2; k++) if (!cols[k]!.binary) setCell(o, k, null); } },
        { key: 'add', shortcut: 'Insert', label: t('edit.addRow'), onSelect: () => addRow() },
        { key: 'dup', shortcut: 'Mod+D', label: t('edit.duplicateRow'), onSelect: () => addRow(orig) },
        { key: 'del', shortcut: 'Mod+Delete', label: t('edit.deleteRows', { n: rowsOf.length }), danger: true, onSelect: () => deleteRows(rowsOf) },
      );
    }
    return items;
  };
  const openMenu = (e: ReactMouseEvent, row: number, c: number) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: gridItems(row, c) });
  };

  // ---- special outputs
  if (out.log) return <ScriptLogView log={out.log} running={running} />;
  if (out.plan || (running && out.title === t('explain.title'))) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {out.error && <ErrorCard error={out.error} />}
        {running && <div className="ui-row" style={{ padding: 12 }}><Spinner label={t('editor.running')} /> {t('editor.running')}</div>}
        {out.plan && <PlanView plan={out.plan} />}
      </div>
    );
  }

  const status = (
    <>
      {out.error && <ErrorCard error={out.error} />}
      {out.cancelled && <div className="ui-card" role="status" style={{ margin: 8 }}>{t('editor.cancelled')}</div>}
    </>
  );
  const messages = r && (r.messages?.length || r.serverOutput?.length) ? <MessagesView messages={r.messages} serverOutput={r.serverOutput} /> : null;

  if (!r || r.columns.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto' }}>
        {status}
        {running && !r && <div className="ui-row" style={{ padding: 12 }}><Spinner label={t('editor.running')} /> {t('editor.running')}</div>}
        {!r && !out.error && !out.cancelled && !running && <EmptyState title={t('result.emptyTitle')} description={emptyDescription ?? t('result.emptyDesc')} />}
        {r && <div className="ui-card" style={{ margin: 8 }} role="status">{t('result.updateCount', { n: r.updateCount ?? 0, kind: r.kind })} <span className="ui-muted">({r.elapsedMs} ms)</span>
          {conn?.tx && !conn.tx.autoCommit && r.kind !== 'read' && <span className="ui-muted"> · {t('tx.notCommitted')}</span>}</div>}
        {messages}
      </div>
    );
  }

  const pinChart = () => {
    const c = classifySql(out.sql);
    if (!out.sql.trim() || c.kind !== 'read' || c.multi || out.params?.length) { toast.push(t('chart.pinReadOnly'), 'error'); return; }
    const spec = out.chart ?? suggestSpec(r.columns, r.rows);
    if (!spec) return;
    const ok = saveWidget({
      id: newWidgetId(), name: (spec.title || out.title || out.sql.replace(/\s+/g, ' ').slice(0, 40)).trim(), sql: out.sql, chart: spec,
      ...(conn?.profileId ? { profileId: conn.profileId } : {}), ...(conn ? { connName: conn.name } : {}),
      ...(tab.schema ? { schema: tab.schema } : {}), ...(tab.catalog ? { catalog: tab.catalog } : {}), maxRows: Math.min(tab.maxRows, 10_000),
    });
    toast.push(t(ok ? 'chart.pinned' : 'chart.pinFull'), ok ? 'success' : 'error');
  };
  const rowNumW = Math.max(44, String(order.length).length * 8 + 20);
  const total = rowNumW + 32 + cols.reduce((a, _, i) => a + (widths[i] ?? 120), 0);
  const span = cols.length + 2;
  const focus = range ? { r: range.r2, c: range.c2 } : null;
  const focusOrig = focus ? order[focus.r] : undefined;
  const refreshItems: MenuItem[] = [
    { key: 'now', shortcut: 'F5', label: t('result.refreshNow'), disabled: running, onSelect: () => outId && void db.refreshOutput(tab.id, outId) },
    { key: 's', label: '', separator: true },
    ...[0, 5, 10, 30, 60, 300].map((s) => ({ key: `r${s}`, shortcut: `Alt+${[0, 5, 10, 30, 60, 300].indexOf(s)}`, label: `${out.refreshSec === s || (!out.refreshSec && s === 0) ? '✓ ' : ''}${s === 0 ? t('result.autoOff') : t('result.autoEvery', { s })}`, onSelect: () => outId && db.patchOutput(tab.id, outId, { refreshSec: s || undefined }) })),
  ];
  const canRefresh = tab.kind === 'table' || out.mode !== 'write';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {status}
      {edit && pendingEdits > 0 && (
        <div className="rv-editbar" role="status">
          <span>{t('edit.pending', { n: pendingEdits })}</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={() => setEdits(noEdits())}>{t('edit.discard')}</Button>
          <Button size="sm" variant="primary" onClick={() => setDlg('review')}>{t('edit.save')}</Button>
        </div>
      )}
      <div className="tb-with-rail" style={{ flex: 1 }}>
        <Rail label={t('result.toolbar')}>
          {VIEWS.map((v) => (
            <RailButton key={v} icon={v} label={t(`result.view.${v}`)} aria-pressed={v === view} onClick={() => db.updateTab(tab.id, { view: v })} />
          ))}
          <RailSep />
          <RailButton icon="filter" label={t('grid.filterRow')} aria-pressed={showFilters} disabled={view !== 'grid'} onClick={() => { setShowFilters((s) => !s); if (showFilters) setFilters({}); }} />
          <RailButton icon="eye" label={t('grid.viewer')} aria-pressed={viewer} disabled={view !== 'grid'} onClick={() => setViewer((s) => !s)} />
          {edit && <RailButton icon="plus" label={t('edit.addRow')} disabled={!editable} onClick={() => addRow()} />}
          <RailSep />
          <RailButton icon="copy" label={t('result.copy')} disabled={baseRows.length === 0} onClick={copyLines} />
          <RailButton icon="export" label={t('result.export')} onClick={() => setDlg('export')} />
          <RailButton icon="fetchAll" label={t('result.fetchAll')} disabled={!r.hasMore || fetchingAll || !!out.error} aria-busy={fetchingAll || undefined} onClick={() => void fetchAll()} />
          <RailSep />
          {tab.kind !== 'table' && <RailButton icon="pin" label={out.pinned ? t('result.unpin') : t('result.pin')} aria-pressed={!!out.pinned} onClick={() => outId && db.patchOutput(tab.id, outId, { pinned: !out.pinned })} />}
          <RailButton icon="refresh" label={out.refreshSec ? t('result.autoEvery', { s: out.refreshSec }) : t('result.refresh')} aria-pressed={!!out.refreshSec} disabled={!canRefresh}
            onClick={(e) => { const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: b.right + 2, y: b.top, items: refreshItems }); }} />
          <RailButton icon="compare" label={t('compare.title')} onClick={() => setDlg('compare')} />
          <RailSep />
          <RailButton icon="agent" label={`${t('result.attachRows', { n: selected.size })} (${t('result.attachHint', { n: MAX_AGENT_ROWS })})`} badge={selected.size}
            disabled={selected.size === 0} onClick={() => setConsent(true)} />
        </Rail>
        <div className="rv-body">
          <div className="ui-grid rv-flat">
            {view === 'chart' ? (
              <div className="ui-grid__scroll" data-testid="result-chart">
                <ChartPanel columns={r.columns} rows={chartRows} spec={out.chart} onSpec={(chart) => outId && db.patchOutput(tab.id, outId, { chart })} onPin={pinChart} />
              </div>
            ) : (
            <div className="ui-grid__scroll" ref={ref} onScroll={onScroll} data-testid="result-scroll" tabIndex={0} onKeyDown={onKey} aria-label={t('result.caption')}>
              {view === 'grid'
                ? (
                  <table className="ui-table rv-table" style={{ width: total }} aria-rowcount={order.length + 1}>
                    <caption className="ui-sr-only">{t('result.caption')}</caption>
                    <colgroup>
                      <col style={{ width: rowNumW }} />
                      <col style={{ width: 32 }} />
                      {cols.map((_, i) => <col key={i} style={{ width: widths[i] ?? 120 }} />)}
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col" className="rv-rownum">#</th>
                        <th scope="col" className="rv-check"><input type="checkbox" checked={allPicked} disabled={pickable.length === 0} aria-label={t('grid.selectAll')} title={t('grid.selectAll')} onChange={toggleAll} /></th>
                        {cols.map((c, i) => (
                          <th key={`${c.name}-${i}`} scope="col" className="rv-th" aria-sort={sort?.col === i ? (sort.desc ? 'descending' : 'ascending') : undefined}
                            title={`${c.name}${c.typeName ? ` : ${c.typeName}` : ''} — ${t('grid.sortHint')}`} onClick={() => { if (!resized.current) onSort(i); }}>
                            <span className="rv-th__name">{c.name}</span>
                            {sort?.col === i && <span className="rv-th__sort" aria-hidden>{sort.desc ? '▼' : '▲'}</span>}
                            <span className="rv-th__resize" role="separator" aria-orientation="vertical" aria-label={t('grid.resize', { c: c.name })} onPointerDown={(e) => startResize(i, e)} onClick={(e) => e.stopPropagation()}
                              onDoubleClick={(e) => { e.stopPropagation(); setWidths((w) => { const n = [...w]; n[i] = estimateWidths([c], baseRows.map((row) => [row[i]]))[0]!; return n; }); }} />
                          </th>
                        ))}
                      </tr>
                      {showFilters && (
                        <tr className="rv-filters">
                          <th className="rv-rownum" />
                          <th />
                          {cols.map((c, i) => (
                            <th key={i}>
                              <input className="ui-input rv-filter" aria-label={t('grid.filterCol', { c: c.name })} placeholder={t('grid.filterPh')} value={filters[i] ?? ''}
                                onChange={(e) => setFilters((f) => ({ ...f, [i]: e.target.value }))} onKeyDown={(e) => e.stopPropagation()} />
                            </th>
                          ))}
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {order.length === 0 && !out.loadingMore && <tr><td colSpan={span} className="ui-muted" style={{ textAlign: 'center' }}>{filtering ? t('grid.noMatch') : t('result.noRows')}</td></tr>}
                      {first > 0 && <tr className="rv-spacer" aria-hidden="true" style={{ height: first * ROW_H }}><td colSpan={span} /></tr>}
                      {order.slice(first, last).map((orig, k) => {
                        const row = first + k;
                        const inserted = orig >= baseRows.length;
                        const sel = !inserted && selected.has(orig);
                        const deleted = edits.deleted.has(orig);
                        const upd = edits.updates.get(orig);
                        return (
                          <tr key={orig} style={{ height: ROW_H }} aria-selected={sel} className={cx(deleted && 'rv-deleted', inserted && 'rv-inserted')}>
                            <td className="rv-rownum">{inserted ? '+' : row + 1}</td>
                            <td className="rv-check">{!inserted && <input type="checkbox" checked={sel} aria-label={`${t('grid.selectRow')} ${row + 1}`} onChange={() => toggle(orig)} />}</td>
                            {cols.map((c, ci) => {
                              const v = valueAt(orig, ci);
                              const f = v === undefined && inserted ? { text: t('edit.default'), isNull: true } : formatCell(v);
                              const inR = nr && row >= nr.r1 && row <= nr.r2 && ci >= nr.c1 && ci <= nr.c2;
                              const isFocus = focus && focus.r === row && focus.c === ci;
                              if (editing && editing.r === row && editing.c === ci) {
                                return (
                                  <td key={ci} className="rv-editing">
                                    <CellEditor initial={v === null || v === undefined ? '' : formatCell(v).text}
                                      onCommit={(val, moveRight) => { if (val !== (v === null || v === undefined ? '' : formatCell(v).text)) setCell(orig, ci, val); setEditing(moveRight && ci + 1 < cols.length ? { r: row, c: ci + 1 } : null); if (!moveRight) ref.current?.focus({ preventScroll: true }); }}
                                      onCancel={() => { setEditing(null); ref.current?.focus({ preventScroll: true }); }} />
                                  </td>
                                );
                              }
                              return (
                                <td key={ci} className={cx(f.isNull && 'ui-null', c.numeric && !f.isNull && 'ui-num', inR && 'rv-sel', isFocus && 'rv-focus', upd?.has(ci) && 'rv-edited')}
                                  title={f.text.length > 40 ? f.text.slice(0, 2000) : undefined}
                                  onMouseDown={(e) => onCellDown(e, row, ci)} onMouseEnter={() => onCellEnter(row, ci)} onContextMenu={(e) => openMenu(e, row, ci)}
                                  onDoubleClick={() => { if (editable && !c.binary && !deleted) setEditing({ r: row, c: ci }); else setViewer(true); }}>{f.text}</td>
                              );
                            })}
                          </tr>
                        );
                      })}
                      {last < order.length && <tr className="rv-spacer" aria-hidden="true" style={{ height: (order.length - last) * ROW_H }}><td colSpan={span} /></tr>}
                    </tbody>
                  </table>
                )
                : <LinesView lines={lines} first={first} last={last} label={t(`result.view.${view}`)} />}
              {out.loadingMore && <div className="rv-loading" role="status"><Spinner label="" /> {t('result.loadingMore')}</div>}
            </div>
            )}
            <div className="ui-grid__foot">
              <span className="ui-grow" aria-live="polite">
                {r.hasMore ? t('result.loadedSome', { n: baseRows.length }) : t('result.loadedAll', { n: baseRows.length })}
                {filtering && ` · ${t('grid.filtered', { n: order.length - edits.inserted.length })}`}
                {!serverSort && localSort && r.hasMore && ` · ${t('grid.sortedLoaded')}`}
              </span>
              {agg && (
                <span className="rv-agg" aria-label={t('grid.selectionStats')}>
                  {t('grid.agg.cells', { n: agg.cells })} · {t('grid.agg.distinct', { n: agg.distinct })}
                  {agg.sum !== undefined && ` · Σ ${fmtNum(agg.sum)} · ${t('grid.agg.avg')} ${fmtNum(agg.avg!)} · min ${fmtNum(agg.min!)} · max ${fmtNum(agg.max!)}`}
                </span>
              )}
              {(out.loadingMore || fetchingAll) && <Spinner label={t('result.loadingMore')} />}
              <span className="ui-muted">{r.elapsedMs} ms{r.truncated ? ` · ${t('result.truncated', { n: tab.maxRows })}` : ''}</span>
            </div>
          </div>
          {viewer && view === 'grid' && (
            <ValueViewer conn={conn} tab={tab} output={out} column={focus ? cols[focus.c] ?? null : null} value={focusOrig !== undefined && focus ? valueAt(focusOrig, focus.c) : undefined}
              rowIndex={focusOrig !== undefined && focusOrig < baseRows.length ? focusOrig : null} row={focusOrig !== undefined ? rowAt(focusOrig) : null} columns={cols} edit={edit} pkIdx={pkIdx}
              onClose={() => setViewer(false)} />
          )}
        </div>
      </div>
      {messages}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dlg === 'export' && (
        <ExportResultDialog tab={tab} output={out} columns={cols} visibleRows={() => order.map(rowAt)} selectionRows={nr ? () => rangeValues(nr) : undefined}
          selectionColumns={nr ? cols.slice(nr.c1, nr.c2 + 1) : undefined} driver={driver} onClose={() => setDlg(null)} />
      )}
      {dlg === 'compare' && <CompareDialog current={{ tab, output: out }} onClose={() => setDlg(null)} />}
      {dlg === 'review' && <EditReviewDialog statements={statements()} saving={saving} manualCommit={!!conn?.tx && !conn.tx.autoCommit} onCancel={() => setDlg(null)} onConfirm={() => void save()} />}
      <RowsConsentDialog open={consent} columns={cols.map((c) => c.name)} rows={pickedRows}
        onCancel={() => setConsent(false)}
        onConfirm={() => { db.setAgentRows({ columns: cols.map((c) => c.name), rows: pickedRows }); setConsent(false); toast.push(t('rows.attached', { n: pickedRows.length }), 'success'); }} />
    </div>
  );
}

const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString(intlLocale()) : n.toLocaleString(intlLocale(), { maximumFractionDigits: 6 }));

function ErrorCard({ error }: { error: NonNullable<OutputState['error']> }) {
  return (
    <div className="ui-card" role="alert" style={{ margin: 8, borderColor: 'var(--ui-danger)' }}>
      <strong>{error.title}</strong>
      {error.detail && <div className="ui-mono" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{error.detail}</div>}
      {error.sqlState && <div className="ui-muted">SQLSTATE {error.sqlState}</div>}
    </div>
  );
}

/** In-cell text editor: Enter / Tab commit, Escape cancels. */
function CellEditor({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string, moveRight: boolean) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  return (
    <input className="rv-cellinput ui-mono" autoFocus value={v} aria-label={t('edit.cell')} onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); done.current = true; onCommit(v, e.key === 'Tab'); }
        else if (e.key === 'Escape') { e.preventDefault(); done.current = true; onCancel(); }
      }}
      onBlur={() => { if (!done.current) { done.current = true; onCommit(v, false); } }} />
  );
}

export { matches };
