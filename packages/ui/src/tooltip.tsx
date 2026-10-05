import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Elements that get the styled tooltip: explicit `data-tooltip`, a button/link/menu item carrying a `title`, or an
 * icon-only button (a glyph such as × ＋ ⟳ or an SVG) named by `aria-label`.
 */
const SELECTOR = '[data-tooltip],button[title],a[title],[role="button"][title],[role="menuitem"][title],[role="tab"][title],button[aria-label]';
const iconOnly = (el: HTMLElement) => (el.textContent ?? '').trim().length <= 2;

/**
 * One tooltip for the whole app (mount once). Shows the `data-tooltip` / `title` text of the control under the pointer
 * (also disabled buttons, which get no mouse events of their own) or with keyboard focus, after a short delay. While it
 * shows, the native `title` is moved aside so the browser's own tooltip does not appear on top; it is put back on leave,
 * so accessible names and tests that read `title` are unchanged.
 */
export function TooltipLayer({ delayMs = 350 }: { delayMs?: number }) {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const textOf = (el: HTMLElement) => (el.dataset.tooltip || el.getAttribute('title') || el.dataset.tipTitle
      || (el.tagName === 'BUTTON' && iconOnly(el) ? el.getAttribute('aria-label') : '') || '').trim();
    const restore = (el: HTMLElement | null) => {
      if (el && el.dataset.tipTitle !== undefined) { el.setAttribute('title', el.dataset.tipTitle); delete el.dataset.tipTitle; }
    };
    const hide = () => {
      clearTimeout(timer);
      restore(current);
      current = null;
      setTip(null);
    };
    const show = (el: HTMLElement, wait: number) => {
      if (el === current) return;
      hide();
      const text = textOf(el);
      if (!text) return;
      current = el;
      const t = el.getAttribute('title');
      if (t !== null) { el.dataset.tipTitle = t; el.removeAttribute('title'); }
      timer = setTimeout(() => { if (current === el && el.isConnected) setTip({ text, rect: el.getBoundingClientRect() }); }, wait);
    };
    const at = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      const el = hit instanceof Element ? hit.closest<HTMLElement>(SELECTOR) : null;
      if (el) show(el, delayMs);
      else if (current && !(hit && current.contains(hit))) hide();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => at(e.clientX, e.clientY));
    };
    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>(SELECTOR) : null;
      if (el && el.matches(':focus-visible')) show(el, 0);
    };
    const onBlur = (e: FocusEvent) => { if (current && e.target === current) hide(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    const onLeave = (e: PointerEvent) => { if (!e.relatedTarget) hide(); };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('pointerout', onLeave, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onBlur, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      cancelAnimationFrame(frame);
      hide();
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('pointerout', onLeave, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onBlur, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [delayMs]);

  // below the control (above when there is no room), centred, kept inside the window
  useLayoutEffect(() => {
    if (!tip || !boxRef.current) { setPos(null); return; }
    const b = boxRef.current.getBoundingClientRect();
    const gap = 6;
    const above = tip.rect.bottom + gap + b.height > window.innerHeight - 4 && tip.rect.top - gap - b.height >= 4;
    const top = above ? tip.rect.top - gap - b.height : tip.rect.bottom + gap;
    const left = Math.max(4, Math.min(tip.rect.left + tip.rect.width / 2 - b.width / 2, window.innerWidth - b.width - 4));
    setPos({ left, top, above });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={boxRef} role="tooltip" className={`ui-tooltip${pos?.above ? ' ui-tooltip--above' : ''}`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}>
      {tip.text}
    </div>,
    document.body,
  );
}
