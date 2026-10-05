import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildChatBody } from './context';
import { ContextNotes } from './ContextNotes';
import { LiveStatus, TraceSummary } from './TraceView';
import { contextPayload, getContextNotes, remapContextProfiles, resetWorkspaceForTests, saveContextNote } from '../tabledb/workspace';
import { SchemaStore } from '../tabledb/schemaStore';
import type { DbApi } from '../../gateway';

const note = (id: string, text: string, over: object = {}) => ({ id, profileId: 'p1', kind: 'filter' as const, text, at: 0, enabled: true, ...over });
beforeEach(() => { localStorage.clear(); resetWorkspaceForTests(); });

describe('business context notes (per saved profile)', () => {
  it('only enabled notes of that profile are sent, bounded, one per line', () => {
    saveContextNote(note('a', 'Loại merchant test'));
    saveContextNote(note('b', 'ẩn', { enabled: false }));
    saveContextNote(note('c', 'khác profile', { profileId: 'p2' }));
    expect(contextPayload('p1')).toBe('- [filter] Loại merchant test');
    expect(contextPayload(undefined)).toBe('');
  });
  it('dedupes identical text, caps per profile, rejects invalid kinds', () => {
    saveContextNote(note('a', 'Cùng nội dung'));
    expect(saveContextNote(note('b', 'cùng nội dung'))).toBe(true);
    expect(getContextNotes()).toHaveLength(1);
    for (let i = 0; i < 40; i++) saveContextNote(note(`n${i}`, `note ${i}`));
    expect(getContextNotes().filter((n) => n.profileId === 'p1')).toHaveLength(30);
    expect(saveContextNote({ ...note('z', 'x y z w'), kind: 'evil' as never })).toBe(false);
  });
  it('notes follow a merged profile id (remap), as tabs do', () => {
    saveContextNote(note('a', 'Giữ khi gộp profile'));
    remapContextProfiles(new Map([['p1', 'p9']]));
    expect(contextPayload('p9')).toContain('Giữ khi gộp');
    expect(contextPayload('p1')).toBe('');
  });
  it('is part of the chat body (capped) and plain mode is flagged', () => {
    const conn = { id: 'c', name: 'n', driver: 'oracle' as const, store: new SchemaStore({} as DbApi) };
    expect(buildChatBody(conn, [], false, [{ role: 'user', content: 'x' }], null, null, { dataContext: 'y'.repeat(9000) }).dataContext).toHaveLength(4000);
    const plain = buildChatBody(conn, [], false, [{ role: 'user', content: 'x' }], null, null, { plain: true });
    expect(plain.plain).toBe(true);
    expect(buildChatBody(conn, [], false, [{ role: 'user', content: 'x' }]).dataContext).toBeUndefined();
  });
  it('ContextNotes: add, toggle, delete; explains when the connection has no saved profile', async () => {
    const u = userEvent.setup();
    const { rerender } = render(<ContextNotes connName="ORA" />);
    expect(screen.getByText(/chưa gắn với profile/)).toBeInTheDocument();
    rerender(<ContextNotes profileId="p1" connName="ORA" />);
    await u.type(screen.getByLabelText('Thêm'), 'Active = status ACTIVE');
    await u.click(screen.getByRole('button', { name: 'Thêm' }));
    expect(contextPayload('p1')).toContain('Active = status ACTIVE');
    expect(screen.getByText(/Đang gửi 1 ghi chú/)).toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: 'Gửi cho Agent' }));
    expect(contextPayload('p1')).toBe('');
    await u.click(screen.getByRole('button', { name: 'Xóa ghi chú' }));
    expect(getContextNotes()).toHaveLength(0);
  });
});

describe('trace view', () => {
  it('shows the latest live step and a collapsible summary of finished steps only', () => {
    const { rerender } = render(<LiveStatus events={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Agent đang trả lời');
    rerender(<LiveStatus events={[{ kind: 'tool', name: 'search_metadata', ok: true, ms: 0, depth: 0, note: 'start' }]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Tra cứu OpenMetadata');
    rerender(<TraceSummary trace={[
      { kind: 'tool', name: 'search_metadata', ok: true, ms: 120, depth: 0 }, { kind: 'subagent', name: 'task', ok: false, ms: 5, depth: 0 },
      { kind: 'final', name: 'answer', ok: true, ms: 0, depth: 0 }, { kind: 'tool', name: 'my_new_tool', ok: true, ms: 1, depth: 1 }]} />);
    expect(screen.getByText(/Các bước Agent đã thực hiện · 3 bước/)).toBeInTheDocument();
    expect(screen.getByText(/Tra cứu OpenMetadata · 120 ms/)).toBeInTheDocument();
    expect(screen.getByText(/Giao việc cho sub-agent \(lỗi\)/)).toBeInTheDocument();
    expect(screen.getByText(/my_new_tool/)).toBeInTheDocument();
  });
});
