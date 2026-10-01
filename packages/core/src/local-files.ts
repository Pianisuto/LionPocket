import { isValidDate, validateTransaction } from './daily-finance';
import { validateMonth } from './daily-finance';
import { dateForMonthDay } from './finance';
import type { Transaction, TransactionInput } from './types';

export const transactionCsvHeaders = [
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
] as const;
const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
/** Same columns, comma separator, UTF-8 BOM and quote escaping as desktop. */
export function exportTransactionsCsv(items: Transaction[], month?: string) {
  if (month) validateMonth(month);
  const rows = items
    .filter((t) => !month || t.dueDate.slice(0, 7) === month)
    .sort(
      (a, b) => a.dueDate.localeCompare(b.dueDate) || a.description.localeCompare(b.description),
    );
  return (
    '\ufeff' +
    [
      transactionCsvHeaders.map(csvCell).join(','),
      ...rows.map((t) =>
        [
          t.purchaseDate,
          t.dueDate,
          t.kind,
          t.description,
          t.categoryName,
          t.plannedAmount,
          t.actualAmount,
          t.status,
          t.paymentMethodName,
          t.cardName,
          t.notes,
        ]
          .map(csvCell)
          .join(','),
      ),
    ].join('\n')
  );
}
export interface ImportedTransaction {
  input: TransactionInput;
  categoryName: string;
  paymentMethodName: string;
  cardName: string;
  sourceKey: string;
  installmentNumber?: number | null;
  installmentTotal?: number | null;
}
/** RFC-style quoted cells, multiline content, BOM, comma or semicolon separator. */
export function parseCsv(content: string): string[][] {
  const text = content.replace(/^\ufeff/, '');
  const firstLine = text.split(/\r?\n/)[0];
  const separator = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === '"') {
      if (cell || closed) throw new Error('CSV com aspas inválidas.');
      quoted = true;
    } else if (char === separator) {
      row.push(cell);
      cell = '';
      closed = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell);
      if (row.some((c) => c.length)) rows.push(row);
      row = [];
      cell = '';
      closed = false;
    } else {
      if (closed) throw new Error('CSV com conteúdo após as aspas.');
      cell += char;
    }
  }
  if (quoted) throw new Error('CSV com aspas não fechadas.');
  row.push(cell);
  if (row.some((c) => c.length)) rows.push(row);
  return rows;
}
export function importTransactionsCsv(content: string, fileName: string): ImportedTransaction[] {
  const [header, ...rows] = parseCsv(content);
  if (
    !header ||
    transactionCsvHeaders.some((h) => !header.includes(h)) ||
    new Set(header).size !== header.length
  )
    throw new Error('Use um CSV de lançamentos exportado pelo LionPocket.');
  return rows.map((values, index) => {
    if (values.length !== header.length)
      throw new Error(`Linha ${index + 2}: quantidade de colunas inválida.`);
    const row = Object.fromEntries(header.map((h, i) => [h, values[i]]));
    const amount = (value: string, optional = false) => {
      if (!value.trim() && optional) return null;
      if (!/^-?\d+(?:[.,]\d{1,2})?$/.test(value.trim()))
        throw new Error(`Linha ${index + 2}: valor inválido.`);
      return Number(value.replace(',', '.'));
    };
    const input: TransactionInput = {
      kind: row.tipo as TransactionInput['kind'],
      description: row.descricao,
      plannedAmount: amount(row.valor_planejado) as number,
      actualAmount: amount(row.valor_real, true),
      dueDate: row.data,
      purchaseDate: row.data_compra || null,
      status: row.situacao as TransactionInput['status'],
      settledDate: ['paid', 'received'].includes(row.situacao) ? row.data : null,
      notes: row.observacoes,
    };
    validateTransaction(input);
    if (row.data_compra && !isValidDate(row.data_compra))
      throw new Error('Data da compra inválida.');
    return {
      input,
      categoryName: row.categoria,
      paymentMethodName: row.forma_pagamento,
      cardName: row.cartao,
      sourceKey: `csv:${fileName}:${index + 2}:${JSON.stringify(values)}`,
    };
  });
}
export type BackupRow = Record<string, string | number | null>;
export type BackupData = Record<string, BackupRow[]>;
export interface LocalBackup {
  version: 1;
  platform: 'mobile';
  schemaVersion: number;
  exportedAt: string;
  data: BackupData;
}
export function parseBackupJson(content: string): {
  schemaVersion: number;
  data: BackupData;
  desktop: boolean;
} {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object') throw new Error('Arquivo JSON inválido.');
  const object = parsed as Record<string, unknown>;
  if (
    object.version !== 1 ||
    !object.data ||
    typeof object.data !== 'object' ||
    Array.isArray(object.data)
  )
    throw new Error('Formato de exportação do LionPocket inválido.');
  const desktop = object.platform === undefined;
  if (!desktop && object.platform !== 'mobile')
    throw new Error('Plataforma de backup desconhecida.');
  const schemaVersion = desktop ? (object.schemaVersion === 14 ? 8 : object.schemaVersion === 13 ? 7 : object.schemaVersion === 12 ? 6 : 4) : object.schemaVersion;
  if (desktop && object.schemaVersion !== undefined && object.schemaVersion !== 12 && object.schemaVersion !== 13 && object.schemaVersion !== 14) throw new Error('Versão desktop desconhecida.');
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1)
    throw new Error('Versão do banco inválida.');
  const data = object.data as Record<string, unknown>;
  for (const [table, rows] of Object.entries(data)) {
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !row ||
          typeof row !== 'object' ||
          Array.isArray(row) ||
          Object.values(row).some(
            (value) =>
              value !== null &&
              typeof value !== 'string' &&
              (typeof value !== 'number' || !Number.isFinite(value)),
          ),
      )
    )
      throw new Error(`Tabela inválida: ${table}.`);
  }
  return { schemaVersion, data: data as BackupData, desktop };
}
/** Translate storage names; currency remains integer cents, identities remain intact. */
export function desktopBackupData(data: BackupData): BackupData {
  const aliases: Record<string, Record<string, string>> = {
    transactions: { planned_cents: 'planned_amount_cents', actual_cents: 'actual_amount_cents' },
    recurring_expenses: { planned_cents: 'planned_amount_cents' },
    installment_purchases: { installment_cents: 'installment_amount_cents' },
    goals: { target_cents: 'target_amount_cents', saved_cents: 'saved_amount_cents' },
  };
  const result: BackupData = {};
  for (const [table, rows] of Object.entries(data)) {
    if (table === 'migrations') continue;
    result[table] = rows.map((row) => {
      const mapped = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [aliases[table]?.[key] ?? key, value]),
      );
      if (['categories', 'payment_methods', 'cards'].includes(table)) {
        delete mapped.created_at;
        delete mapped.updated_at;
      }
      if (table === 'recurring_expenses' && !mapped.start_date)
        mapped.start_date = dateForMonthDay(String(mapped.start_month), Number(mapped.due_day));
      if (table === 'transactions')
        mapped.occurrence_date =
          mapped.occurrence_date ?? (mapped.source_type === 'recurring' ? (mapped.purchase_date ?? mapped.due_date) : null);
      return mapped;
    });
  }
  result.local_import_records = [];
  return result;
}
