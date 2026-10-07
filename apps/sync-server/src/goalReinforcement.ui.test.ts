import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '@lionpocket/core';
import { Goals as DesktopGoals } from '../../desktop/src/ui/screens/Goals';
import { PlanningScreen } from '../../mobile/src/ui/PlanningScreen';

const mobileDb = vi.hoisted(() => ({
  listGoals: vi.fn(),
  listGoalReinforcements: vi.fn(),
}));
vi.mock('../../mobile/src/db/transactions', () => ({
  ...mobileDb,
  saveGoalReinforcement: vi.fn(),
  deleteGoal: vi.fn(),
  deleteInstallment: vi.fn(),
  deleteRecurring: vi.fn(),
  listInstallments: vi.fn(async () => []),
  listRecurring: vi.fn(async () => []),
  saveGoal: vi.fn(),
  saveInstallment: vi.fn(),
  saveRecurring: vi.fn(),
}));
vi.mock('react-native', () => ({
  ActivityIndicator: 'mobile-activity',
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Modal: 'mobile-modal',
  Text: 'mobile-text',
  View: 'mobile-view',
  FlatList: ({ ListHeaderComponent, data, renderItem }: { ListHeaderComponent: React.ReactNode; data: unknown[]; renderItem: (value: { item: unknown }) => React.ReactNode }) =>
    React.createElement('mobile-list', null, ListHeaderComponent, data.map((item, index) => React.createElement(React.Fragment, { key: index }, renderItem({ item })))),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'mobile-safe' }));
vi.mock('../../mobile/src/ui/Appearance', async () => {
  const { darkColors } = await import('../../mobile/src/ui/theme');
  return { useAppearance: () => ({ colors: darkColors }) };
});
vi.mock('../../mobile/src/ui/components', async () => {
  const React = await import('react');
  return {
    useStyles: () => ({}),
    Button: (props: Record<string, unknown>) => React.createElement('mobile-button', props),
    IconButton: (props: Record<string, unknown>) => React.createElement('mobile-icon-button', props),
    ScreenHeader: 'mobile-header',
    dateLabel: (value: string) => value,
    money: (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`,
  };
});
vi.mock('../../mobile/src/ui/PlanningEditors', () => ({
  frequencies: [],
  goalStatuses: [],
  GoalEditor: 'mobile-goal-editor',
  GoalReinforcementEditor: 'mobile-reinforcement-editor',
  InstallmentEditor: 'mobile-installment-editor',
  RecurringEditor: 'mobile-recurring-editor',
}));
vi.mock('../../mobile/src/ui/MonthlyPlanningSection', () => ({ MonthlyPlanningSection: 'mobile-monthly-planning' }));

const goal = (extra: Partial<Goal> = {}): Goal => ({
  id: 'goal-1', name: 'Notebook', itemModel: '', link: '', categoryId: null, categoryName: null, targetAmount: 3000, savedAmount: 250,
  priority: 'medium', status: 'saving', dueDate: null, progress: 0.08, remainingAmount: 2750, suggestedMonthlyAmount: 500, createdAt: '', updatedAt: '', ...extra,
} as Goal);
function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
let renderer: ReactTestRenderer | undefined;
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('Mobile Objetivos month is local to the screen', () => {
  const catalogs = { categories: [], paymentMethods: [], cards: [] } as never;
  const mount = async (onMonth = vi.fn()) => {
    await act(async () => { renderer = create(React.createElement(PlanningScreen, { area: 'goals', catalogs, month: '2026-10', onMonth, onClose: vi.fn(), onChanged: vi.fn(async () => undefined) })); });
    await settle();
    return onMonth;
  };
  beforeEach(() => {
    mobileDb.listGoals.mockResolvedValue([goal()]);
    mobileDb.listGoalReinforcements.mockImplementation(async (month: string) => month === '2026-10' ? [{ goalId: 'goal-1', month, amountCents: 50000 }] : []);
  });
  it('starts at the global month and navigating never moves the app-wide month', async () => {
    const onMonth = await mount();
    expect(mobileDb.listGoalReinforcements).toHaveBeenLastCalledWith('2026-10');
    expect(text(renderer!.root)).toContain('R$ 500,00');
    await act(async () => { renderer!.root.findByProps({ label: 'Próximo mês' }).props.onPress(); });
    await settle();
    expect(mobileDb.listGoalReinforcements).toHaveBeenLastCalledWith('2026-11');
    expect(text(renderer!.root)).toContain('novembro');
    expect(text(renderer!.root)).toContain('R$ 0,00');
    await act(async () => { renderer!.root.findByProps({ label: 'Mês anterior' }).props.onPress(); });
    await act(async () => { renderer!.root.findByProps({ label: 'Mês anterior' }).props.onPress(); });
    await settle();
    expect(mobileDb.listGoalReinforcements).toHaveBeenLastCalledWith('2026-09');
    expect(onMonth).not.toHaveBeenCalled();
  });
  it('does not claim a zero total, nor offer editing, when the month cannot be read', async () => {
    mobileDb.listGoalReinforcements.mockRejectedValue(new Error('disk unavailable'));
    await mount();
    const rendered = text(renderer!.root);
    expect(rendered).not.toContain('Planejado para objetivos em');
    expect(rendered).toContain('disk unavailable');
    expect(renderer!.root.findAllByProps({ label: 'Definir reforço' })).toEqual([]);
    expect(renderer!.root.findAllByProps({ label: 'Editar reforço' })).toEqual([]);
  });
});

describe('Desktop Objetivos does not treat an unread month as empty', () => {
  const lionPocket = { listGoals: vi.fn(), listGoalReinforcements: vi.fn(), openExternal: vi.fn(), deleteGoal: vi.fn() };
  const mount = async () => {
    vi.stubGlobal('window', { lionPocket });
    await act(async () => { renderer = create(React.createElement(DesktopGoals, { month: '2026-10', refreshKey: 0, onAdd: vi.fn(), onEdit: vi.fn(), onChanged: vi.fn(), notify: vi.fn() })); });
    await settle();
  };
  const buttons = () => renderer!.root.findAll((node) => node.type === 'button').map((node) => text(node));
  beforeEach(() => { lionPocket.listGoals.mockResolvedValue([goal()]); });
  it('shows the stored amounts when the read succeeds', async () => {
    lionPocket.listGoalReinforcements.mockResolvedValue([{ goalId: 'goal-1', month: '2026-10', amountCents: 50000 }]);
    await mount();
    expect(text(renderer!.root)).toContain('Planejado para objetivos em');
    expect(buttons()).toContain('Editar reforço');
  });
  it('shows an error with retry, hides totals and editing, then recovers', async () => {
    lionPocket.listGoalReinforcements.mockRejectedValueOnce(new Error('read failed'));
    await mount();
    const rendered = text(renderer!.root);
    expect(rendered).toContain('Não foi possível carregar o planejamento');
    expect(rendered).not.toContain('Planejado para objetivos em');
    expect(rendered).not.toContain('sem reforço');
    expect(buttons().some((label) => /reforço/.test(label))).toBe(false);
    lionPocket.listGoalReinforcements.mockResolvedValue([{ goalId: 'goal-1', month: '2026-10', amountCents: 50000 }]);
    await act(async () => { renderer!.root.findAll((node) => node.type === 'button' && text(node) === 'Tentar novamente')[0].props.onClick(); });
    await settle();
    expect(text(renderer!.root)).toContain('Planejado para objetivos em');
    expect(buttons()).toContain('Editar reforço');
  });
});
