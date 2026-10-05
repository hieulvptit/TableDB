import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { cx } from './primitives';

export interface SplitPaneProps {
  direction?: 'horizontal' | 'vertical';
  /** which pane has the explicit pixel size; the other one flexes */
  primary?: 'first' | 'second';
  initial?: number;
  min?: number;
  max?: number;
  children: [ReactNode, ReactNode];
  label?: string;
  className?: string;
}
export function SplitPane({ direction = 'horizontal', primary = 'first', initial = 280, min = 120, max = 900, children, label = 'Thay đổi kích thước', className }: SplitPaneProps) {
  const [size, setSize] = useState(initial);
  const drag = useRef<{ start: number; size: number } | null>(null);
  const horiz = direction === 'horizontal';
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const sign = primary === 'first' ? 1 : -1;
  const onDown = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { start: horiz ? e.clientX : e.clientY, size };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const d = (horiz ? e.clientX : e.clientY) - drag.current.start;
    setSize(clamp(drag.current.size + sign * d));
  };
  const onUp = () => { drag.current = null; };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    const dec = horiz ? 'ArrowLeft' : 'ArrowUp', inc = horiz ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) { e.preventDefault(); setSize((s) => clamp(s - sign * step)); }
    else if (e.key === inc) { e.preventDefault(); setSize((s) => clamp(s + sign * step)); }
  };
  const fixedStyle = horiz ? { width: size, flex: '0 0 auto' } : { height: size, flex: '0 0 auto' };
  const flexStyle = { flex: '1 1 0' };
  return (
    <div className={cx('ui-split', !horiz && 'ui-split--vertical', className)}>
      <div className="ui-split__pane" style={primary === 'first' ? fixedStyle : flexStyle}>{children[0]}</div>
      <div className="ui-split__handle" role="separator" tabIndex={0} aria-label={label} aria-orientation={horiz ? 'vertical' : 'horizontal'}
        aria-valuenow={size} aria-valuemin={min} aria-valuemax={max}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onKeyDown={onKey} />
      <div className="ui-split__pane" style={primary === 'second' ? fixedStyle : flexStyle}>{children[1]}</div>
    </div>
  );
}
