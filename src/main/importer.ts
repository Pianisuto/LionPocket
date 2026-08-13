import path from 'node:path';
import type { GoalStatus, ImportResult, TransactionStatus } from '../shared/types';
import { LionPocketDatabase } from './database';
import { readXlsx, type XlsxCellValue, type XlsxWorksheet } from './xlsx-reader';

const monthSheets = [
  ['Jan', 1],
  ['Fev', 2],
  ['Mar', 3],
  ['Abr', 4],
  ['Mai', 5],
  ['Jun', 6],
  ['Jul', 7],
  ['Ago', 8],
  ['Set', 9],
  ['Out', 10],
  ['Nov', 11],
  ['Dez', 12],
] as const;

const unwrap = (value: XlsxCellValue): XlsxCellValue => value;

const text = (sheet: XlsxWorksheet, row: number, column: number): string => {
  const value = unwrap(sheet.getCell(row, column).value);
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const number = (sheet: XlsxWorksheet, row: number, column: number): number => {
  const value = unwrap(sheet.getCell(row, column).value);
  if (typeof value === 'number') return value;
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};

const isoDate = (
  sheet: XlsxWorksheet,
  row: number,
  column: number,
  fallback: string | null = null,
): string | null => {
  const value = unwrap(sheet.getCell(row, column).value);
  if (typeof value === 'number') {
    const date = new Date(Date.UTC(1899, 11, 30 + value));
    return date.toISOString().slice(0, 10);
  }
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split('/');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return fallback;
};

const transactionStatus = (value: string, kind: 'income' | 'expense'): TransactionStatus => {
  const normalized = value.toLocaleLowerCase('pt-BR');
  if (normalized === 'pago') return 'paid';
  if (normalized === 'recebido') return 'received';
  if (normalized === 'cancelado') return 'cancelled';
  return kind === 'income' && normalized === 'pago' ? 'received' : 'planned';
};

const goalStatus = (value: string): GoalStatus => {
  const normalized = value.toLocaleLowerCase('pt-BR');
  if (normalized === 'juntando') return 'saving';
  if (normalized === 'comprado') return 'completed';
  if (normalized === 'pausado') return 'paused';
  if (normalized === 'cancelado') return 'cancelled';
  return 'planned';
};

const sourceKey = (filePath: string, sheet: string, row: number) =>
  `xlsx:${path.basename(filePath)}:${sheet}:${row}`;

export const importFinancialSpreadsheet = async (
  database: LionPocketDatabase,
  filePath: string,
): Promise<ImportResult> => {
  const workbook = await readXlsx(filePath);
  const result: ImportResult = { categories: 0, recurringExpenses: 0, transactions: 0, goals: 0 };

  const config = workbook.getWorksheet('Config');
  if (config) {
    for (let row = 4; row <= 26; row += 1) {
      const expenseCategory = text(config, row, 1);
      const incomeSource = text(config, row, 2);
      const paymentMethod = text(config, row, 5);
      const card = text(config, row, 9);
      if (expenseCategory) {
        database.findOrCreateCategory(expenseCategory, 'expense');
        result.categories += 1;
      }
      if (incomeSource) {
        database.findOrCreateCategory(incomeSource, 'income', '#3B9970');
        result.categories += 1;
      }
      if (paymentMethod) database.findOrCreatePaymentMethod(paymentMethod);
      if (card) database.findOrCreateCard(card);
    }
  }

  const fixed = workbook.getWorksheet('Fixas');
  if (fixed) {
    const existing = database.listRecurringExpenses();
    for (let row = 3; row <= 32; row += 1) {
      const description = text(fixed, row, 2);
      if (!description) continue;
      const dueDay = Math.max(1, Math.min(31, Math.round(number(fixed, row, 6) || 1)));
      if (existing.some((item) => item.description === description && item.dueDay === dueDay)) continue;
      const categoryName = text(fixed, row, 3);
      const methodName = text(fixed, row, 4);
      database.saveRecurringExpense({
        active: text(fixed, row, 1).toLocaleLowerCase('pt-BR') !== 'não',
        description,
        categoryId: categoryName
          ? database.findOrCreateCategory(categoryName, 'expense')
          : null,
        paymentMethodId: methodName ? database.findOrCreatePaymentMethod(methodName) : null,
        plannedAmount: number(fixed, row, 5),
        dueDay,
        notes: text(fixed, row, 7),
      });
      result.recurringExpenses += 1;
    }
  }

  const goals = workbook.getWorksheet('Objetivos');
  if (goals) {
    const existing = database.listGoals();
    for (let row = 3; row <= 200; row += 1) {
      const name = text(goals, row, 1);
      if (!name || existing.some((goal) => goal.name === name)) continue;
      const categoryName = text(goals, row, 4);
      const priorityText = text(goals, row, 9).toLocaleLowerCase('pt-BR');
      database.saveGoal({
        name,
        itemModel: text(goals, row, 2),
        link: text(goals, row, 3),
        categoryId: categoryName
          ? database.findOrCreateCategory(categoryName, 'expense')
          : null,
        targetAmount: number(goals, row, 5),
        savedAmount: number(goals, row, 6),
        priority: priorityText === 'alta' ? 'high' : priorityText === 'baixa' ? 'low' : 'medium',
        dueDate: isoDate(goals, row, 10),
        status: goalStatus(text(goals, row, 11)),
        notes: text(goals, row, 13),
      });
      result.goals += 1;
    }
  }

  for (const [sheetName, monthNumber] of monthSheets) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) continue;
    const title = text(sheet, 1, 1);
    const yearMatch = title.match(/\b(20\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
    const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
    const fallbackDate = `${month}-01`;

    for (let row = 13; row <= 26; row += 1) {
      const description = text(sheet, row, 2);
      if (!description) continue;
      const categoryName = text(sheet, row, 3) || 'Outros';
      const status = transactionStatus(text(sheet, row, 6), 'income');
      database.insertImportedTransaction(
        {
          kind: 'income',
          description,
          categoryId: database.findOrCreateCategory(categoryName, 'income', '#3B9970'),
          plannedAmount: number(sheet, row, 4),
          actualAmount: number(sheet, row, 5) || null,
          dueDate: isoDate(sheet, row, 1, fallbackDate) ?? fallbackDate,
          settledDate: status === 'received' ? isoDate(sheet, row, 1, fallbackDate) : null,
          status,
          notes: text(sheet, row, 7),
        },
        sourceKey(filePath, sheetName, row),
      );
      result.transactions += 1;
    }

    for (let row = 32; row <= 61; row += 1) {
      const description = text(sheet, row, 3);
      const plannedAmount = number(sheet, row, 6);
      const actualAmount = number(sheet, row, 7);
      const status = transactionStatus(text(sheet, row, 8), 'expense');
      if (!description || (plannedAmount === 0 && actualAmount === 0 && status === 'planned')) continue;
      const categoryName = text(sheet, row, 4) || 'Outros';
      const methodName = text(sheet, row, 5);
      const dueDay = Math.max(1, Math.min(31, Math.round(number(sheet, row, 2) || 1)));
      database.insertImportedTransaction(
        {
          kind: 'expense',
          description,
          categoryId: database.findOrCreateCategory(categoryName, 'expense'),
          plannedAmount,
          actualAmount: actualAmount || null,
          dueDate: `${month}-${String(dueDay).padStart(2, '0')}`,
          settledDate: status === 'paid' ? `${month}-${String(dueDay).padStart(2, '0')}` : null,
          status,
          paymentMethodId: methodName ? database.findOrCreatePaymentMethod(methodName) : null,
          notes: text(sheet, row, 9),
        },
        sourceKey(filePath, sheetName, row),
      );
      result.transactions += 1;
    }

    for (let row = 67; row <= 91; row += 1) {
      const description = text(sheet, row, 2);
      if (!description) continue;
      const categoryName = text(sheet, row, 6) || 'Outros';
      const cardName = text(sheet, row, 3);
      const status = transactionStatus(text(sheet, row, 8), 'expense');
      const dueDate = isoDate(sheet, row, 1, fallbackDate) ?? fallbackDate;
      database.insertImportedTransaction(
        {
          kind: 'expense',
          description,
          categoryId: database.findOrCreateCategory(categoryName, 'expense'),
          plannedAmount: number(sheet, row, 7),
          actualAmount: status === 'paid' ? number(sheet, row, 7) : null,
          dueDate,
          settledDate: status === 'paid' ? dueDate : null,
          status,
          cardId: cardName ? database.findOrCreateCard(cardName) : null,
          notes: text(sheet, row, 9),
        },
        sourceKey(filePath, sheetName, row),
        number(sheet, row, 4) || null,
        number(sheet, row, 5) || null,
      );
      result.transactions += 1;
    }

    for (let row = 97; row <= 136; row += 1) {
      const description = text(sheet, row, 2);
      if (!description) continue;
      const categoryName = text(sheet, row, 3) || 'Outros';
      const methodName = text(sheet, row, 4);
      const status = transactionStatus(text(sheet, row, 6), 'expense');
      const dueDate = isoDate(sheet, row, 1, fallbackDate) ?? fallbackDate;
      database.insertImportedTransaction(
        {
          kind: 'expense',
          description,
          categoryId: database.findOrCreateCategory(categoryName, 'expense'),
          plannedAmount: number(sheet, row, 5),
          actualAmount: status === 'paid' ? number(sheet, row, 5) : null,
          dueDate,
          settledDate: status === 'paid' ? dueDate : null,
          status,
          paymentMethodId: methodName ? database.findOrCreatePaymentMethod(methodName) : null,
          notes: text(sheet, row, 7),
        },
        sourceKey(filePath, sheetName, row),
      );
      result.transactions += 1;
    }
  }

  return result;
};
