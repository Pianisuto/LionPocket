import { contextBridge, ipcRenderer } from 'electron';
import type { LionPocketApi, WindowState } from './shared/types';

const api: LionPocketApi = {
  getCatalogs: () => ipcRenderer.invoke('catalogs:get'),
  createCatalogItem: (input) => ipcRenderer.invoke('catalogs:create', input),
  getOverview: (month) => ipcRenderer.invoke('overview:get', month),
  listTransactions: (filters) => ipcRenderer.invoke('transactions:list', filters),
  saveTransaction: (input) => ipcRenderer.invoke('transactions:save', input),
  deleteTransaction: (id) => ipcRenderer.invoke('transactions:delete', id),
  settleTransaction: (id) => ipcRenderer.invoke('transactions:settle', id),
  settleTransactions: (ids) => ipcRenderer.invoke('transactions:settle-many', ids),
  suggestTransactions: (kind, term) => ipcRenderer.invoke('transactions:suggest', kind, term),
  listRecurringExpenses: () => ipcRenderer.invoke('recurring:list'),
  saveRecurringExpense: (input) => ipcRenderer.invoke('recurring:save', input),
  deleteRecurringExpense: (id) => ipcRenderer.invoke('recurring:delete', id),
  listInstallmentPurchases: () => ipcRenderer.invoke('installments:list'),
  createInstallmentPurchase: (input) => ipcRenderer.invoke('installments:create', input),
  deleteInstallmentPurchase: (id) => ipcRenderer.invoke('installments:delete', id),
  listGoals: () => ipcRenderer.invoke('goals:list'),
  saveGoal: (input) => ipcRenderer.invoke('goals:save', input),
  deleteGoal: (id) => ipcRenderer.invoke('goals:delete', id),
  createBackup: () => ipcRenderer.invoke('backup:create'),
  exportCsv: (month) => ipcRenderer.invoke('export:csv', month),
  exportJson: () => ipcRenderer.invoke('export:json'),
  importSpreadsheet: () => ipcRenderer.invoke('spreadsheet:import'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowState: (listener) => {
    const handler = (_event: unknown, state: WindowState) => listener(state);
    ipcRenderer.on('window:state', handler);
    return () => ipcRenderer.removeListener('window:state', handler);
  },
};

contextBridge.exposeInMainWorld('lionPocket', api);
