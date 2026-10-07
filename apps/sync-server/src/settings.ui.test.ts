import React, { useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Catalogs } from '@lionpocket/core';
import { SettingsScreen as DesktopSettings } from '../../desktop/src/ui/settings/SettingsScreen';
import type { SettingsContext, SettingsSectionId } from '../../desktop/src/ui/settings/sections';
import { SettingsScreen as MobileSettings } from '../../mobile/src/ui/settings/SettingsScreen';

const runtime = vi.hoisted(() => ({
  update: vi.fn(async (_patch: unknown) => undefined),
  alert: vi.fn(),
  pickFile: vi.fn(async () => ({ name: 'financas.json' })),
  listBackups: vi.fn(async () => [{ name: 'backup.json', location: '/backup', size: 100, modifiedAt: '2026-10-07' }]),
  prepareImport: vi.fn(async (_file: unknown) => ({ fileName: 'financas.json', mode: 'restore' })),
  commitImport: vi.fn(async (_prepared: unknown) => 'Dados restaurados.'),
  exportLocal: vi.fn(async (_format: unknown, _month?: string) => true),
  recoveryBackup: vi.fn(async () => undefined),
  saveFile: vi.fn(async () => true),
  status: vi.fn(async () => ({ phase: 'local', activity: 'local' })),
}));
vi.mock('react-native', () => ({
  Text: 'rn-text', View: 'rn-view', TextInput: 'rn-input', Pressable: 'rn-pressable',
  Switch: 'rn-switch', ScrollView: 'rn-scroll', Modal: 'rn-modal',
  KeyboardAvoidingView: 'rn-keyboard-view', ActivityIndicator: 'rn-spinner',
  StyleSheet: { create: (styles: unknown) => styles },
  Alert: { alert: runtime.alert }, Keyboard: { dismiss: vi.fn() },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'rn-safe' }));
vi.mock('../../mobile/src/ui/Appearance', async () => {
  const { darkColors } = await import('../../mobile/src/ui/theme');
  return { useAppearance: () => ({ colors: darkColors,
    preferences: { theme: 'dark', showPriorities: true }, update: runtime.update,
  }) };
});
vi.mock('../../mobile/src/ui/Icon', () => ({ Icon: 'rn-icon' }));
vi.mock('../../mobile/src/ui/components', async () => {
  const { createElement } = await import('react');
  return {
    useStyles: () => ({}),
    Button: (props: Record<string, unknown>) => createElement('rn-button', props),
    IconButton: (props: Record<string, unknown>) => createElement('rn-button', props),
    Field: (props: Record<string, unknown>) => createElement('rn-field', props),
    Choice: (props: Record<string, unknown>) => createElement('rn-choice', props),
    Sheet: ({ children, footer, ...props }: Record<string, unknown>) =>
      createElement('rn-sheet', props, children as React.ReactNode, footer as React.ReactNode),
  };
});
vi.mock('../../mobile/src/sync/sync', () => ({ syncController: async () => ({ status: runtime.status }) }));
vi.mock('../../mobile/src/ui/settings/sync/SyncPanel', () => ({ SyncPanel: () => React.createElement('sync-fixture') }));
vi.mock('../../desktop/src/ui/settings/sync/SyncPanel', () => ({ SyncPanel: () => React.createElement('sync-fixture') }));
vi.mock('../../mobile/src/db/connection', () => ({ database: async () => ({}) }));
vi.mock('../../mobile/src/db/backupRepository', () => ({ captureBackup: async () => ({ data: { transactions: [1, 2] } }) }));
vi.mock('../../mobile/src/files/native', () => ({ localFiles: {
  pickFile: runtime.pickFile, listBackups: runtime.listBackups, saveFile: runtime.saveFile,
} }));
vi.mock('../../mobile/src/files/localData', () => ({
  prepareImport: runtime.prepareImport, commitImport: runtime.commitImport,
  exportLocal: runtime.exportLocal, recoveryBackup: runtime.recoveryBackup,
}));

const catalogs: Catalogs = {
  categories: [
    { id: 'expense', name: 'Mercado', kind: 'expense', color: '#F2557F' },
    { id: 'income', name: 'Salário', kind: 'income', color: '#34D399' },
  ],
  paymentMethods: [{ id: 'pix', name: 'Pix' }],
  cards: [{ id: 'card', name: 'Nubank', dueDay: 10, closingDay: 14 }, { id: 'legacy', name: 'Antigo', dueDay: 5, closingDay: null }],
};
const content = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(content).join('');
let renderer: ReactTestRenderer;
const root = () => renderer.root;
const host = (type: string) => root().findAll((node) => node.type === type as unknown);
const desktopButton = (label: string) => host('button').find((node) => node.props['aria-label'] === label || content(node).trim() === label)!;
const mobileButton = (label: string) => [...host('rn-button'), ...host('rn-pressable')].filter((node) => node.props.label === label || node.props.accessibilityLabel === label).at(-1)!;
const click = async (label: string, mobile = false) => {
  const button = mobile ? mobileButton(label) : desktopButton(label);
  expect(button, label).toBeTruthy();
  expect(button.props.disabled).not.toBe(true);
  await act(async () => (mobile ? button.props.onPress : button.props.onClick)());
};
const change = async (node: ReactTestInstance, value: string) => {
  await act(async () => node.props.onChange({ target: { value } }));
};
const submit = async (form: ReactTestInstance) => {
  await act(async () => form.props.onSubmit({ preventDefault: vi.fn() }));
};
const api = {
  createCatalogItem: vi.fn(async (_input: unknown) => undefined),
  deleteCatalogItem: vi.fn(async (_type: string, _id: string) => undefined),
  importSpreadsheet: vi.fn(async () => ({ transactions: 3 })),
  createBackup: vi.fn(async () => '/backup'),
  exportCsv: vi.fn(async (_month: string) => '/export.csv'),
  exportJson: vi.fn(async () => '/export.json'),
};
const context: SettingsContext = {
  catalogs, month: '2026-10', theme: 'dark', showPriorities: true,
  onThemeChange: vi.fn(), onShowPrioritiesChange: vi.fn(),
  refreshCatalogs: vi.fn(async () => undefined), onSyncChanged: vi.fn(async () => undefined), notify: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { lionPocket: api });
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

describe('Desktop settings', () => {
  async function mount(section: SettingsSectionId = 'general') {
    function Harness() {
      const [active, setActive] = useState(section);
      return React.createElement(DesktopSettings, { ...context, section: active, onSectionChange: setActive });
    }
    await act(async () => { renderer = create(React.createElement(Harness)); });
  }
  const navigate = async (label: string) => {
    const button = root().findByType('nav').findAllByType('button').find((node) => content(node).startsWith(label))!;
    await act(async () => button.props.onClick());
    expect(host('h2').map(content)).toContain(label);
    expect(button.props['aria-current']).toBe('page');
  };
  it('opens each area with only its own controls and preserves theme/priorities', async () => {
    await mount();
    expect(host('nav')).toHaveLength(1);
    expect(host('sync-fixture')).toHaveLength(0);
    await click('Claro');
    expect(context.onThemeChange).toHaveBeenCalledWith('light');
    await act(async () => root().findByProps({ id: 'settings-show-priorities' }).props.onChange({ target: { checked: false } }));
    expect(context.onShowPrioritiesChange).toHaveBeenCalledWith(false);
    await navigate('Cadastros');
    expect(content(root())).toContain('Mercado');
    expect(content(root())).toContain('Fecha dia 14');
    expect(content(root())).toContain('Vence dia 10');
    expect(content(root())).toContain('Fechamento não configurado');
    await navigate('Dados e backup');
    expect(content(root())).not.toContain('Mercado');
    expect(desktopButton('Criar cópia de segurançaSalva uma cópia completa do banco local')).toBeTruthy();
    await navigate('Sincronização');
    expect(host('sync-fixture')).toHaveLength(1);
    await navigate('Geral');
    expect(host('form')).toHaveLength(0);
  });
  it.each(['saída', 'entrada'])('adds a %s category to the correct list and rejects blank names', async (kind) => {
    await mount('catalogs');
    await click(`Adicionar categoria de ${kind}`);
    await submit(host('form')[0]);
    expect(api.createCatalogItem).not.toHaveBeenCalled();
    expect(content(root())).toContain('Informe um nome.');
    await change(root().findByProps({ 'aria-label': `Nome da categoria de ${kind}` }), '  Nova  ');
    await submit(host('form')[0]);
    expect(api.createCatalogItem).toHaveBeenCalledWith({ type: 'category', name: 'Nova', kind: kind === 'entrada' ? 'income' : 'expense' });
    expect(context.refreshCatalogs).toHaveBeenCalled();
  });
  it('adds payment methods and edits a card without losing its billing days', async () => {
    await mount('catalogs');
    await click('Adicionar');
    await change(root().findByProps({ 'aria-label': 'Nome da forma de pagamento' }), 'Boleto');
    await submit(host('form')[0]);
    expect(api.createCatalogItem).toHaveBeenCalledWith({ type: 'paymentMethod', name: 'Boleto' });
    await click('Cancelar');
    await click('Editar cartão Nubank');
    const form = root().findByProps({ 'aria-label': 'Editar cartão Nubank' });
    await change(form.findAllByType('input')[0], 'Nubank novo');
    await submit(form);
    expect(api.createCatalogItem).toHaveBeenCalledWith({ type: 'card', id: 'card', name: 'Nubank novo', closingDay: 14, dueDay: 10 });
    expect(host('form')).toHaveLength(0);
  });
  it.each([['categoria', 'Mercado', 'category', 'expense'], ['cartão', 'Nubank', 'card', 'card']])('confirms %s deletion and refreshes catalogs', async (noun, name, type, id) => {
    await mount('catalogs');
    await click(`Excluir ${noun} ${name}`);
    expect(api.deleteCatalogItem).not.toHaveBeenCalled();
    expect(root().findByProps({ role: 'alertdialog' })).toBeTruthy();
    await click('Cancelar');
    expect(api.deleteCatalogItem).not.toHaveBeenCalled();
    await click(`Excluir ${noun} ${name}`);
    await click(`Excluir ${noun}`);
    expect(api.deleteCatalogItem).toHaveBeenCalledWith(type, id);
    expect(context.refreshCatalogs).toHaveBeenCalled();
  });
  it('routes import, backup, CSV and JSON to the existing APIs and handles failure', async () => {
    await mount('data');
    for (const title of ['Importar planilha', 'Criar cópia de segurança', 'Exportar mês em CSV', 'Exportar tudo em JSON']) {
      const button = host('button').find((node) => content(node).startsWith(title))!;
      await act(async () => button.props.onClick());
    }
    expect(api.importSpreadsheet).toHaveBeenCalledOnce();
    expect(api.createBackup).toHaveBeenCalledOnce();
    expect(api.exportCsv).toHaveBeenCalledWith('2026-10');
    expect(api.exportJson).toHaveBeenCalledOnce();
    api.createBackup.mockRejectedValueOnce(new Error('disk'));
    await act(async () => host('button').find((node) => content(node).startsWith('Criar cópia'))!.props.onClick());
    expect(context.notify).toHaveBeenLastCalledWith('Não foi possível concluir a operação com o arquivo.');
  });
});

describe('Mobile settings', () => {
  const handlers = {
    onClose: vi.fn(), onAreaChange: vi.fn(),
    onDataChanged: vi.fn(async () => undefined), onSyncChanged: vi.fn(async () => undefined),
    onSave: vi.fn(async (_input: unknown) => undefined), onDelete: vi.fn(async (_type: string, _id: string) => undefined),
    onCompleteDefaults: vi.fn(async () => undefined),
  };
  async function mount() {
    await act(async () => { renderer = create(React.createElement(MobileSettings, { catalogs, month: '2026-10', ...handlers })); });
  }
  it('opens all four pages and Android back returns to the list before closing', async () => {
    await mount();
    for (const title of ['Geral', 'Cadastros', 'Dados e backup', 'Sincronização']) {
      await click(title, true);
      expect(host('rn-text').find((node) => node.props.accessibilityRole === 'header' && content(node) === title)).toBeTruthy();
      await act(async () => host('rn-modal')[0].props.onRequestClose());
      expect(handlers.onClose).not.toHaveBeenCalled();
      expect(mobileButton(title)).toBeTruthy();
    }
    await act(async () => host('rn-modal')[0].props.onRequestClose());
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });
  it('saves theme and visibility, blocks back while saving and shows errors', async () => {
    await mount();
    await click('Geral', true);
    await act(async () => host('rn-choice')[0].props.onChange('light'));
    expect(runtime.update).toHaveBeenCalledWith({ theme: 'light' });
    let finish!: () => void;
    runtime.update.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    await act(async () => { host('rn-switch')[0].props.onValueChange(false); });
    expect(mobileButton('Voltar').props.disabled).toBe(true);
    await act(async () => host('rn-modal')[0].props.onRequestClose());
    expect(handlers.onAreaChange).toHaveBeenLastCalledWith('general');
    await act(async () => finish());
    expect(runtime.update).toHaveBeenCalledWith({ showPriorities: false });
    runtime.update.mockRejectedValueOnce(new Error('Falha de gravação'));
    await act(async () => host('rn-switch')[0].props.onValueChange(false));
    expect(content(root())).toContain('Falha de gravação');
    expect(mobileButton('Voltar').props.disabled).toBe(false);
  });
  it('adds each kind, edits cards, confirms deletion and completes defaults', async () => {
    await mount();
    await click('Cadastros', true);
    expect(content(root())).toContain('Fecha dia 14 · Vence dia 10');
    expect(content(root())).toContain('Fechamento não configurado · Vence dia 5');
    for (const [index, type, kind] of [[0, 'category', 'expense'], [1, 'category', 'income'], [2, 'paymentMethod', 'expense'], [3, 'card', 'expense']] as const) {
      await act(async () => host('rn-button').filter((node) => node.props.label === 'Adicionar')[index].props.onPress());
      await act(async () => host('rn-field').find((node) => node.props.label === 'Nome')!.props.onChange('Novo'));
      await click('Adicionar', true);
      expect(handlers.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ type, kind, name: 'Novo' }));
      expect(host('rn-sheet')).toHaveLength(0);
    }
    await click('Editar cartão Nubank', true);
    await act(async () => host('rn-field').find((node) => node.props.label === 'Dia do fechamento')!.props.onChange('20'));
    await click('Salvar alterações', true);
    expect(handlers.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'card', dueDay: 10, closingDay: 20 }));
    await click('Editar forma de pagamento Pix', true);
    await click('Excluir forma de pagamento', true);
    expect(handlers.onDelete).not.toHaveBeenCalled();
    const buttons = runtime.alert.mock.lastCall![2];
    await act(async () => buttons.find((button: { text: string }) => button.text === 'Excluir').onPress());
    expect(handlers.onDelete).toHaveBeenCalledWith('paymentMethod', 'pix');
    await click('Adicionar categorias padrão faltantes', true);
    expect(handlers.onCompleteDefaults).toHaveBeenCalledOnce();
  });
  it('keeps the editor open on failed save', async () => {
    await mount();
    await click('Cadastros', true);
    await click('Editar categoria de saída Mercado', true);
    handlers.onSave.mockRejectedValueOnce(new Error('Nome inválido'));
    await click('Salvar alterações', true);
    expect(host('rn-sheet')).toHaveLength(1);
    expect(content(root())).toContain('Nome inválido');
  });
  it('blocks editing and leaving while standard categories are being added', async () => {
    await mount();
    await click('Cadastros', true);
    let finish!: () => void;
    handlers.onCompleteDefaults.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    await click('Adicionar categorias padrão faltantes', true);
    expect(mobileButton('Editar categoria de saída Mercado').props.disabled).toBe(true);
    expect(mobileButton('Adicionar').props.disabled).toBe(true);
    expect(mobileButton('Voltar').props.disabled).toBe(true);
    await act(async () => finish());
    expect(mobileButton('Editar categoria de saída Mercado').props.disabled).toBe(false);
    expect(mobileButton('Voltar').props.disabled).toBe(false);
  });
  it('reviews restoration before commit and retains every export and backup action', async () => {
    await mount();
    await click('Dados e backup', true);
    await click('Escolher arquivo local', true);
    expect(runtime.prepareImport).toHaveBeenCalledWith({ name: 'financas.json' });
    expect(runtime.commitImport).not.toHaveBeenCalled();
    await click('Restaurar dados', true);
    expect(runtime.commitImport).not.toHaveBeenCalled();
    const buttons = runtime.alert.mock.lastCall![2];
    await act(async () => buttons.find((button: { text: string }) => button.text === 'Substituir e restaurar').onPress());
    expect(runtime.commitImport).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'financas.json', mode: 'restore' }));
    expect(handlers.onDataChanged).toHaveBeenCalledOnce();
    for (const [label, format, month] of [
      ['Exportar JSON completo', 'json', undefined], ['Exportar CSV do mês', 'csv', '2026-10'],
      ['Exportar CSV de todos os lançamentos', 'csv', undefined], ['Salvar backup SQLite em arquivo', 'sqlite', undefined],
    ] as const) {
      await click(label, true);
      expect(runtime.exportLocal).toHaveBeenLastCalledWith(format, month);
    }
    await click('Criar cópia no aparelho', true);
    expect(runtime.recoveryBackup).toHaveBeenCalled();
    await click('Salvar esta cópia em arquivo', true);
    expect(runtime.saveFile).toHaveBeenCalled();
  });
});
