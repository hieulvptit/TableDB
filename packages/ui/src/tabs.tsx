import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './primitives';

export interface TabItem { id: string; label: ReactNode; content?: ReactNode; closable?: boolean; closeLabel?: string }
export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  onClose?: (id: string) => void;
  trailing?: ReactNode;
  className?: string;
  /** render only active panel (default) or keep all mounted (state preserved, hidden) */
  keepMounted?: boolean;
  label?: string;
}
export function Tabs({ items, activeId, onChange, onClose, trailing, className, keepMounted, label }: TabsProps) {
  const base = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const idx = items.findIndex((i) => i.id === activeId);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      const it = items[next]!;
      onChange(it.id);
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(it.id)}"]`)?.focus());
    }
  };
  return (
    <div className={cx('ui-tabs', className)}>
      <div className="ui-row" style={{ gap: 0 }}>
        <div className="ui-tablist" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKey} style={{ flex: 1 }}>
          {items.map((it) => (
            <span key={it.id} className={cx('ui-tabitem', it.id === activeId && 'is-active')}>
              <button role="tab" id={`${base}-t-${it.id}`} data-tab={it.id} aria-selected={it.id === activeId} aria-controls={`${base}-p-${it.id}`}
                tabIndex={it.id === activeId ? 0 : -1} className="ui-tab" onClick={() => onChange(it.id)}>
                {it.label}
              </button>
              {it.closable && onClose && (
                <button className="ui-tab__close" aria-label={it.closeLabel ?? 'Đóng tab'} onClick={() => onClose(it.id)}>×</button>
              )}
            </span>
          ))}
        </div>
        {trailing}
      </div>
      {items.map((it) => {
        const active = it.id === activeId;
        if (!active && !keepMounted) return null;
        return (
          <div key={it.id} role="tabpanel" id={`${base}-p-${it.id}`} aria-labelledby={`${base}-t-${it.id}`} className="ui-tabpanel" hidden={!active}>
            {it.content}
          </div>
        );
      })}
    </div>
  );
}
