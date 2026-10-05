import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

export interface TreeNode {
  id: string;
  label: ReactNode;
  /** accessible text label (defaults to id) */
  text?: string;
  icon?: ReactNode;
  /** expandable (children may be loaded lazily) */
  expandable?: boolean;
  children?: TreeNode[];
  loading?: boolean;
  error?: string;
  badge?: ReactNode;
}
export interface TreeProps {
  nodes: TreeNode[];
  expanded: ReadonlySet<string>;
  onToggle: (id: string, node: TreeNode) => void;
  selected?: ReadonlySet<string>;
  onSelect?: (id: string, node: TreeNode, ev: { ctrl: boolean; shift: boolean }) => void;
  onActivate?: (id: string, node: TreeNode) => void;
  /** right-click / ContextMenu key on a node */
  onContextMenu?: (id: string, node: TreeNode, pos: { x: number; y: number }) => void;
  label: string;
  emptyText?: ReactNode;
}
interface Flat { node: TreeNode; level: number; parent: string | null }

function flatten(nodes: TreeNode[], expanded: ReadonlySet<string>, level = 1, parent: string | null = null, out: Flat[] = []): Flat[] {
  for (const n of nodes) {
    out.push({ node: n, level, parent });
    if (n.expandable && expanded.has(n.id) && n.children) flatten(n.children, expanded, level + 1, n.id, out);
  }
  return out;
}

/** WAI-ARIA tree: arrows navigate, Right/Left expand/collapse, Enter activates, Space selects. Loading is the caller's job (onToggle). */
export function Tree({ nodes, expanded, onToggle, selected, onSelect, onActivate, onContextMenu, label, emptyText }: TreeProps) {
  const flat = useMemo(() => flatten(nodes, expanded), [nodes, expanded]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const rootRef = useRef<HTMLUListElement>(null);
  const current = flat.find((f) => f.node.id === focusId) ? focusId : flat[0]?.node.id ?? null;

  const focus = (id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLElement>, f: Flat) => {
    const i = flat.indexOf(f);
    const n = f.node;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (flat[i + 1]) focus(flat[i + 1]!.node.id); break;
      case 'ArrowUp': e.preventDefault(); if (i > 0) focus(flat[i - 1]!.node.id); break;
      case 'Home': e.preventDefault(); if (flat[0]) focus(flat[0].node.id); break;
      case 'End': e.preventDefault(); if (flat.length) focus(flat[flat.length - 1]!.node.id); break;
      case 'ArrowRight':
        e.preventDefault();
        if (n.expandable) { if (!expanded.has(n.id)) onToggle(n.id, n); else if (flat[i + 1]?.parent === n.id) focus(flat[i + 1]!.node.id); }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (n.expandable && expanded.has(n.id)) onToggle(n.id, n); else if (f.parent) focus(f.parent);
        break;
      case 'Enter': e.preventDefault(); onActivate?.(n.id, n); if (n.expandable) onToggle(n.id, n); break;
      case ' ': e.preventDefault(); onSelect?.(n.id, n, { ctrl: true, shift: e.shiftKey }); break;
      case 'ContextMenu': {
        e.preventDefault();
        const r = (e.currentTarget.querySelector('.ui-treeitem__row') ?? e.currentTarget).getBoundingClientRect();
        onContextMenu?.(n.id, n, { x: r.left + 24, y: r.bottom });
        break;
      }
    }
  };
  if (flat.length === 0) return <div className="ui-muted" style={{ padding: 8 }}>{emptyText}</div>;

  // Rendered flat with aria-level (valid ARIA tree pattern) but indented visually.
  return (
    <ul className="ui-tree" role="tree" aria-label={label} ref={rootRef} aria-multiselectable={onSelect ? true : undefined}>
      {flat.map((f) => {
        const n = f.node;
        const isOpen = n.expandable && expanded.has(n.id);
        const click = (e: MouseEvent) => {
          setFocusId(n.id);
          onSelect?.(n.id, n, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
        };
        return (
          <li key={n.id} role="treeitem" className="ui-treeitem" data-node-id={n.id} aria-level={f.level} aria-expanded={n.expandable ? !!isOpen : undefined}
            aria-selected={selected ? selected.has(n.id) : undefined} aria-busy={n.loading || undefined}
            tabIndex={n.id === current ? 0 : -1} onKeyDown={(e) => onKey(e, f)} onFocus={(e) => { if (e.target === e.currentTarget) setFocusId(n.id); }}>
            <div className="ui-treeitem__row" style={{ paddingLeft: 6 + (f.level - 1) * 14, '--lvl': f.level } as CSSProperties} onClick={click} onDoubleClick={() => onActivate?.(n.id, n)}
              onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); setFocusId(n.id); onContextMenu(n.id, n, { x: e.clientX, y: e.clientY }); } : undefined}>
              <span className="ui-tree__caret" onClick={(e) => { e.stopPropagation(); if (n.expandable) onToggle(n.id, n); }} aria-hidden="true">
                {n.expandable ? (isOpen ? '▾' : '▸') : ''}
              </span>
              {n.icon}
              <span className="ui-tree__label" title={n.text}>{n.label}</span>
              {n.loading && <span className="ui-spinner" role="status"><span className="ui-sr-only">…</span></span>}
              {n.error && <span className="ui-error-text" title={n.error}>!</span>}
              {n.badge}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
