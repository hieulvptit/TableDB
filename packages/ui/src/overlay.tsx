import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from './primitives';

/* ---------- Dialog ---------- */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** role=alertdialog for destructive confirmations */
  alert?: boolean;
  closeOnBackdrop?: boolean;
  closeLabel?: string;
}
export function Dialog({ open, title, onClose, children, footer, wide, alert, closeOnBackdrop = false, closeLabel = 'Đóng' }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    return () => { prev?.focus?.(); };
  }, [open]);
  if (!open) return null;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key === 'Tab' && ref.current) {
      const f = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (f.length === 0) { e.preventDefault(); return; }
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  return createPortal(
    <div className="ui-overlay" onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={cx('ui-dialog', wide && 'ui-dialog--wide')} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="ui-dialog__head" id={titleId}>{title}</div>
        <div className="ui-dialog__body">{children}</div>
        <div className="ui-dialog__foot">{footer ?? <Button onClick={onClose}>{closeLabel}</Button>}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Toast ---------- */
export type ToastKind = 'info' | 'success' | 'error' | 'warning';
interface ToastItem { id: number; kind: ToastKind; message: string }
interface ToastApi { push: (message: string, kind?: ToastKind, ttlMs?: number) => void }
const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children, dismissLabel = 'Đóng thông báo' }: { children: ReactNode; dismissLabel?: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback((message: string, kind: ToastKind = 'info', ttlMs = kind === 'error' ? 8000 : 4000) => {
    const id = ++seq.current;
    setItems((l) => [...l.slice(-4), { id, kind, message }]);
    if (ttlMs > 0) setTimeout(() => dismiss(id), ttlMs);
  }, [dismiss]);
  const api = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="ui-toasts" role="region" aria-label="Thông báo" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('ui-toast', `ui-toast--${t.kind}`)} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="ui-toast__msg">{t.message}</span>
            <button className="ui-tab__close" onClick={() => dismiss(t.id)} aria-label={dismissLabel}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast(): ToastApi {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('useToast must be used inside <ToastProvider>');
  return c;
}
