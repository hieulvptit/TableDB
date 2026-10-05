import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionList } from './SessionList';
import { MemoryManager } from './MemoryManager';
import { flushWorkspaceForTests, getChats, getMemories, reloadWorkspaceForTests, saveChat, saveMemory, type ChatSession } from '../tabledb/workspace';

const chat = (id: string, title: string, over: Partial<ChatSession> = {}): ChatSession => ({ id, title, createdAt: 1, updatedAt: 1, summarized: 0, messages: [{ role: 'user', content: `hỏi về ${title}`, at: 1 }], ...over });

describe('agent chats storage', () => {
  beforeEach(() => { localStorage.clear(); reloadWorkspaceForTests(); });
  it('persists sessions + memory, newest first with pinned on top, and drops malformed entries', async () => {
    saveChat(chat('a', 'Doanh thu', { updatedAt: 10 }));
    saveChat(chat('b', 'Lỗi giao dịch', { updatedAt: 20 }));
    saveChat(chat('c', 'Ghim', { updatedAt: 5, pinned: true }));
    saveMemory({ id: 'm1', text: 'Dùng schema PAY', at: 1, enabled: true });
    await flushWorkspaceForTests();
    reloadWorkspaceForTests();
    expect(getChats().map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(getMemories()).toHaveLength(1);
    localStorage.setItem('tdb.ws.v1', JSON.stringify({ v: 1, chats: [{ id: 'x', messages: [{ role: 'system', content: 'no' }, { role: 'user', content: 'ok' }], summarized: 99 }, 5], memories: [{ id: 'm', text: '  ' }] }));
    reloadWorkspaceForTests();
    expect(getChats()).toHaveLength(1);
    expect(getChats()[0]!.messages).toHaveLength(1);
    expect(getChats()[0]!.summarized).toBe(1);
    expect(getMemories()).toEqual([]);
  });
});

describe('SessionList / MemoryManager', () => {
  beforeEach(() => { localStorage.clear(); reloadWorkspaceForTests(); });
  it('searches titles and message text, opens a session', async () => {
    saveChat(chat('a', 'Doanh thu', { updatedAt: Date.now() }));
    saveChat(chat('b', 'Lỗi giao dịch', { updatedAt: Date.now() - 1 }));
    const onOpen = vi.fn();
    render(<SessionList activeId={null} onOpen={onOpen} onNew={() => {}} />);
    expect(screen.getByText('Doanh thu')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox'), 'giao dịch');
    expect(screen.queryByText('Doanh thu')).toBeNull();
    await userEvent.click(screen.getByText('Lỗi giao dịch'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });
  it('adds, toggles and deletes memory notes', async () => {
    render(<MemoryManager />);
    await userEvent.type(screen.getByLabelText('Thêm'), 'Luôn bỏ giao dịch TEST{Enter}');
    expect(screen.getByText('Luôn bỏ giao dịch TEST')).toBeInTheDocument();
    expect(screen.getByText(/1 ghi nhớ đang bật/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText(/0 ghi nhớ đang bật/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Xóa ghi nhớ' }));
    expect(getMemories()).toEqual([]);
  });
});
