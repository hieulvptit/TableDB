import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem { key: string; label: ReactNode; onSelect?: () => void; disabled?: boolean; danger?: boolean; separator?: boolean; /** display-only hint of an existing key binding, e.g. 'F2' or 'Mod+C' (Mod → ⌘ on macOS, Ctrl elsewhere) */ shortcut?: string }

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const fmtShortcut = (s: string) => s.replace(/Mod\+/g, IS_MAC ? '⌘' : 'Ctrl+').replace(/Shift\+/g, IS_MAC ? '⇧' : 'Shift+');

/** Does the keyboard event match a shortcut spec like 'Mod+Shift+C', 'Alt+Enter', 'F5'? Letters/digits compare by physical key (e.code) so Option/Alt chords work on macOS. */
export function matchShortcut(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, spec: string): boolean {
  const parts = spec.split('+');
  const k = parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1));
  if (mods.has('Mod') !== (e.ctrlKey || e.metaKey) || mods.has('Alt') !== e.altKey || mods.has('Shift') !== e.shiftKey) return false;
  if (/^[A-Z]$/.test(k)) return e.code === `Key${k}`;
  if (/^[0-9]$/.test(k)) return e.code === `Digit${k}`;
  return e.key === k;
}

/** Runs the first enabled item whose shortcut matches the event (so menu and keyboard can never drift apart). */
export function runShortcut(items: MenuItem[], e: { preventDefault(): void; stopPropagation(): void } & Parameters<typeof matchShortcut>[0]): boolean {
  const it = items.find((x) => x.shortcut && !x.separator && matchShortcut(e, x.shortcut));
  if (!it) return false;
  e.preventDefault(); e.stopPropagation();
  if (!it.disabled) it.onSelect?.();
  return true;
}

/** Right-click menu (DBeaver style) rendered at the pointer position; closes on outside click, Escape, scroll or blur. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
      const i = els.indexOf(document.activeElement as HTMLElement);
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
    };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose); window.removeEventListener('resize', onClose); document.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} role="menu" onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1000, minWidth: 210, padding: 4, background: 'var(--ui-surface)', border: '1px solid var(--ui-border)', borderRadius: 6, boxShadow: '0 6px 20px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column' }}>
      {items.map((it) => it.separator
        ? <div key={it.key} role="separator" style={{ height: 1, margin: '4px 0', background: 'var(--ui-border)' }} />
        : (
          <button key={it.key} type="button" role="menuitem" aria-keyshortcuts={it.shortcut?.replace(/Mod\+/g, 'Control+')} disabled={it.disabled} onClick={() => { onClose(); it.onSelect?.(); }}
            style={{ textAlign: 'left', padding: '6px 10px', border: 0, borderRadius: 4, background: 'transparent', color: it.danger ? 'var(--ui-danger)' : 'inherit', cursor: it.disabled ? 'default' : 'pointer', opacity: it.disabled ? 0.5 : 1, font: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}
            onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.focus(); }}>
            <span>{it.label}</span>
            {it.shortcut && <span aria-hidden="true" style={{ opacity: 0.6, fontSize: '0.85em', whiteSpace: 'nowrap' }}>{fmtShortcut(it.shortcut)}</span>}
          </button>
        ))}
    </div>,
    document.body,
  );
}
