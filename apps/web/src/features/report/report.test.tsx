import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChartView } from './ChartView';
import { deleteWidget, flushWorkspaceForTests, getWidgets, newWidgetId, reloadWorkspaceForTests, saveWidget } from '../tabledb/workspace';

const cols = [{ name: 'CH', typeName: 'varchar' }, { name: 'AMT', typeName: 'int' }];

describe('ChartView', () => {
  it('draws one bar per category with accessible titles, and escapes values (no markup)', () => {
    const { container } = render(<ChartView spec={{ kind: 'bar', x: 'CH', y: ['AMT'], agg: 'sum' }} columns={cols} rows={[['<img src=x>', 5], ['WEB', 10]]} />);
    expect(container.querySelectorAll('rect')).toHaveLength(2);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x>');
  });
  it('renders pie legend percentages and kpi tiles', () => {
    render(<ChartView spec={{ kind: 'pie', x: 'CH', y: ['AMT'] }} columns={cols} rows={[['A', 75], ['B', 25]]} />);
    expect(screen.getByText('75%')).toBeTruthy();
    render(<ChartView spec={{ kind: 'kpi', y: ['AMT'] }} columns={cols} rows={[['A', 1500000]]} />);
    expect(screen.getByText('1.5M')).toBeTruthy();
  });
});

describe('dashboard widgets (workspace)', () => {
  beforeEach(() => { localStorage.clear(); reloadWorkspaceForTests(); });
  it('persists SQL + chart config only and survives a reload', async () => {
    const id = newWidgetId();
    expect(saveWidget({ id, name: 'Doanh thu', sql: 'SELECT ch, SUM(amt) amt FROM t GROUP BY ch', chart: { kind: 'bar', x: 'CH', y: ['AMT'], agg: 'sum' }, profileId: 'p1', maxRows: 500 })).toBe(true);
    await flushWorkspaceForTests();
    reloadWorkspaceForTests();
    expect(getWidgets()).toHaveLength(1);
    expect(getWidgets()[0]).toMatchObject({ id, name: 'Doanh thu', profileId: 'p1', maxRows: 500 });
    expect(localStorage.getItem('tdb.ws.v1')).not.toMatch(/"rows"/);
    deleteWidget(id);
    expect(getWidgets()).toHaveLength(0);
  });
  it('drops malformed stored widgets', async () => {
    localStorage.setItem('tdb.ws.v1', JSON.stringify({ v: 1, widgets: [{ id: 'a', sql: 'x', chart: { kind: 'radar', y: ['A'] } }, { nope: 1 }] }));
    reloadWorkspaceForTests();
    expect(getWidgets()).toEqual([]);
  });
});
