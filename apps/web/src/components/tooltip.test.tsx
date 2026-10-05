import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipLayer } from '@vnpay/ui';

const original = document.elementFromPoint;
afterEach(() => { document.elementFromPoint = original; vi.useRealTimers(); });

function hover(el: Element) {
  document.elementFromPoint = () => el;
  fireEvent.pointerMove(document, { clientX: 1, clientY: 1 });
}

describe('TooltipLayer', () => {
  it('shows the title of the hovered control (also when disabled), hides on press, and restores the title', async () => {
    vi.useFakeTimers();
    render(<><TooltipLayer delayMs={100} /><button type="button" title="Chạy (Ctrl+Enter)" disabled>▶</button><span>x</span></>);
    const btn = screen.getByRole('button');
    act(() => { hover(btn); vi.advanceTimersByTime(20); });
    expect(btn).not.toHaveAttribute('title'); // the native tooltip does not show on top
    expect(screen.queryByRole('tooltip')).toBeNull(); // still waiting
    act(() => { vi.advanceTimersByTime(150); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Chạy (Ctrl+Enter)');
    act(() => { fireEvent.pointerDown(document); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(btn).toHaveAttribute('title', 'Chạy (Ctrl+Enter)');
  });

  it('icon-only buttons use their aria-label; buttons with text and no title get none', () => {
    vi.useFakeTimers();
    render(<><TooltipLayer delayMs={0} /><button type="button" aria-label="Đóng tab">×</button><button type="button" aria-label="x">Kết nối</button></>);
    act(() => { hover(screen.getByRole('button', { name: 'Đóng tab' })); vi.advanceTimersByTime(20); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Đóng tab');
    act(() => { hover(screen.getByText('Kết nối')); vi.advanceTimersByTime(20); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('moving away hides it', () => {
    vi.useFakeTimers();
    render(<><TooltipLayer delayMs={0} /><button type="button" title="Lưu">S</button><p>nền</p></>);
    act(() => { hover(screen.getByRole('button')); vi.advanceTimersByTime(20); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    act(() => { hover(screen.getByText('nền')); vi.advanceTimersByTime(20); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Lưu');
  });
});
