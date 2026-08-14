import { backup } from 'node:sqlite';
import fs from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  CatalogInput,
  GoalInput,
  InstallmentPurchaseInput,
  MoneyKind,
  RecurringExpenseInput,
  TransactionFilters,
  TransactionInput,
} from '../shared/types';
import { LionPocketDatabase } from './database';
import { importFinancialSpreadsheet } from './importer';

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

/** A janela que fez a chamada — a barra de título é desenhada pelo próprio app. */
const callerWindow = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender);

export const registerIpcHandlers = (database: LionPocketDatabase) => {
  ipcMain.handle('window:minimize', (event) => {
    callerWindow(event)?.minimize();
  });
  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = callerWindow(event);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle('window:close', (event) => {
    callerWindow(event)?.close();
  });
  ipcMain.handle('window:is-maximized', (event) => callerWindow(event)?.isMaximized() ?? false);

  ipcMain.handle('catalogs:get', () => database.getCatalogs());
  ipcMain.handle('catalogs:create', (_event, input: CatalogInput) => database.createCatalogItem(input));
  ipcMain.handle('catalogs:delete', (_event, type: 'category' | 'card', id: string) =>
    database.deleteCatalogItem(type, id),
  );
  ipcMain.handle('overview:get', (_event, month: string) => database.getOverview(month));
  ipcMain.handle('transactions:list', (_event, filters: TransactionFilters) =>
    database.listTransactions(filters),
  );
  ipcMain.handle('transactions:save', (_event, input: TransactionInput) =>
    database.saveTransaction(input),
  );
  ipcMain.handle('transactions:delete', (_event, id: string) => database.deleteTransaction(id));
  ipcMain.handle('transactions:settle', (_event, id: string) => database.settleTransaction(id));
  ipcMain.handle('transactions:settle-many', (_event, ids: string[]) =>
    database.settleTransactions(ids),
  );
  ipcMain.handle('transactions:suggest', (_event, kind: MoneyKind, term: string) =>
    database.suggestTransactions(kind, term),
  );
  ipcMain.handle('recurring:list', () => database.listRecurringExpenses());
  ipcMain.handle('recurring:save', (_event, input: RecurringExpenseInput) =>
    database.saveRecurringExpense(input),
  );
  ipcMain.handle('recurring:delete', (_event, id: string) => database.deleteRecurringExpense(id));
  ipcMain.handle('installments:list', (_event, month: string) => database.listInstallmentPurchases(month));
  ipcMain.handle('installments:create', (_event, input: InstallmentPurchaseInput) =>
    database.createInstallmentPurchase(input),
  );
  ipcMain.handle('installments:save', (_event, input: InstallmentPurchaseInput) =>
    database.saveInstallmentPurchase(input),
  );
  ipcMain.handle('installments:delete', (_event, id: string) =>
    database.deleteInstallmentPurchase(id),
  );
  ipcMain.handle('goals:list', () => database.listGoals());
  ipcMain.handle('goals:save', (_event, input: GoalInput) => database.saveGoal(input));
  ipcMain.handle('goals:delete', (_event, id: string) => database.deleteGoal(id));

  ipcMain.handle('backup:create', async () => {
    const selection = await dialog.showSaveDialog({
      title: 'Salvar cópia de segurança',
      defaultPath: `LionPocket-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
      filters: [{ name: 'Cópia do LionPocket', extensions: ['sqlite'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    await backup(database.db, selection.filePath);
    return selection.filePath;
  });

  ipcMain.handle('export:json', async () => {
    const selection = await dialog.showSaveDialog({
      title: 'Exportar todos os dados',
      defaultPath: `LionPocket-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Dados do LionPocket', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    await fs.writeFile(
      selection.filePath,
      JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data: database.exportData() }, null, 2),
      'utf8',
    );
    return selection.filePath;
  });

  ipcMain.handle('export:csv', async (_event, month?: string) => {
    const selection = await dialog.showSaveDialog({
      title: 'Exportar lançamentos',
      defaultPath: `LionPocket-lancamentos${month ? `-${month}` : ''}.csv`,
      filters: [{ name: 'Planilha CSV', extensions: ['csv'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    const rows = database.exportTransactions(month);
    const headers = [
      'data_compra',
      'data',
      'tipo',
      'descricao',
      'categoria',
      'valor_planejado',
      'valor_real',
      'situacao',
      'forma_pagamento',
      'cartao',
      'observacoes',
    ];
    const csv = [
      headers.map(csvCell).join(','),
      ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
    ].join('\n');
    await fs.writeFile(selection.filePath, `\ufeff${csv}`, 'utf8');
    return selection.filePath;
  });

  ipcMain.handle('spreadsheet:import', async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Importar planilha financeira',
      properties: ['openFile'],
      filters: [{ name: 'Planilha do Excel', extensions: ['xlsx'] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return importFinancialSpreadsheet(database, selection.filePaths[0]);
  });

  ipcMain.handle('external:open', async (_event, url: string) => {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Link não permitido.');
    await shell.openExternal(parsed.toString());
  });
};
