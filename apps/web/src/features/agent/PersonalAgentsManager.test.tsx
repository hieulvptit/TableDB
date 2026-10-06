import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { PersonalAgentsManager } from './PersonalAgentsManager';
import { getPersonalAgents, getPersonalSkills, reloadWorkspaceForTests } from '../tabledb/workspace';

beforeEach(() => { localStorage.clear(); reloadWorkspaceForTests(); });

it('adds an editable reconciliation template, toggles its skill and updates specialist instructions', async () => {
  const user = userEvent.setup();
  render(<PersonalAgentsManager dialect="postgresql" />);
  const template = screen.getByText('Đối soát giao dịch').closest('.ui-card')!;
  await user.click(within(template as HTMLElement).getByRole('button', { name: 'Thêm mẫu' }));
  expect(getPersonalSkills()).toHaveLength(1); expect(getPersonalAgents()).toHaveLength(1);
  await user.click(screen.getByRole('checkbox', { name: 'Đối soát giao dịch' }));
  expect(getPersonalSkills()[0]?.enabled).toBe(false);
  const agentCard = screen.getByRole('checkbox', { name: 'Chuyên gia đối soát' }).closest('.ui-card')!;
  await user.click(within(agentCard as HTMLElement).getByRole('button', { name: 'Sửa' }));
  expect(screen.getByLabelText('Mã định danh')).toBeDisabled();
  await user.clear(screen.getByLabelText('Hướng dẫn chuyên môn'));
  await user.type(screen.getByLabelText('Hướng dẫn chuyên môn'), 'Đối soát theo giờ Việt Nam và quy tắc người dùng xác nhận.');
  await user.click(screen.getByRole('button', { name: 'Lưu' }));
  expect(getPersonalAgents()[0]?.instructions).toContain('giờ Việt Nam');
  await user.click(screen.getByRole('button', { name: 'Xóa skill Đối soát giao dịch' }));
  expect(getPersonalAgents()[0]?.skills).not.toContain('personal:transaction-reconciliation');
});

it('creates a custom skill and agent, binds the skill, and rejects duplicate identifiers', async () => {
  const user = userEvent.setup();
  render(<PersonalAgentsManager dialect="postgresql" />);
  await user.click(screen.getByRole('button', { name: 'Tạo skill' }));
  await user.type(screen.getByLabelText('Mã định danh'), 'my-metrics');
  await user.type(screen.getByLabelText('Tên hiển thị'), 'KPI cá nhân');
  await user.type(screen.getByLabelText('Dùng khi nào?'), 'Khi tính KPI đã xác nhận');
  await user.type(screen.getByLabelText('Hướng dẫn chuyên môn'), 'Hỏi định nghĩa KPI trước khi viết SQL.');
  await user.click(screen.getByRole('button', { name: 'Lưu' }));
  expect(getPersonalSkills()[0]?.name).toBe('my-metrics');
  await user.click(screen.getByRole('button', { name: 'Tạo agent' }));
  await user.type(screen.getByLabelText('Mã định danh'), 'my-reports');
  await user.type(screen.getByLabelText('Tên hiển thị'), 'Báo cáo của tôi');
  await user.type(screen.getByLabelText('Dùng khi nào?'), 'Báo cáo hàng ngày');
  await user.type(screen.getByLabelText('Hướng dẫn chuyên môn'), 'Thiết kế báo cáo từ KPI người dùng xác nhận.');
  await user.click(screen.getByRole('checkbox', { name: 'KPI cá nhân' }));
  await user.click(screen.getByRole('button', { name: 'Lưu' }));
  expect(getPersonalAgents()[0]?.skills).toEqual(['personal:my-metrics']);
  expect(getPersonalAgents()[0]?.useOpenMetadata).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Tạo skill' }));
  await user.type(screen.getByLabelText('Mã định danh'), 'my-metrics');
  await user.type(screen.getByLabelText('Tên hiển thị'), 'Duplicate');
  await user.type(screen.getByLabelText('Dùng khi nào?'), 'duplicate');
  await user.type(screen.getByLabelText('Hướng dẫn chuyên môn'), 'Do not replace previous personal instructions.');
  await user.click(screen.getByRole('button', { name: 'Lưu' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Mã định danh đã tồn tại');
  expect(getPersonalSkills()).toHaveLength(1);
});
