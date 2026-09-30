import { describe, expect, it } from 'vitest';
import {
  categoryBreakdown,
  filterTransactions,
  historySuggestions,
  orderedTransactions,
  priorityOrderForMonth,
} from './local-experience';
import {
  desktopBackupData,
  exportTransactionsCsv,
  importTransactionsCsv,
  parseBackupJson,
  parseCsv,
} from './local-files';
import type { Transaction } from './types';
const item = (changes: Partial<Transaction> = {}): Transaction => ({
  id: 'a',
  kind: 'expense',
  description: 'Café',
  categoryId: null,
  categoryName: 'Alimentação',
  categoryColor: null,
  plannedAmount: 1234.56,
  actualAmount: null,
  purchaseDate: null,
  dueDate: '2026-09-30',
  settledDate: null,
  status: 'planned',
  paymentMethodId: null,
  paymentMethodName: 'Pix',
  cardId: null,
  cardName: null,
  notes: '',
  sourceType: 'manual',
  sourceId: null,
  installmentNumber: null,
  installmentTotal: null,
  isOverdue: false,
  priorityPosition: null,
  ...changes,
});
describe('experiência local compartilhada', () => {
  it('combina busca sem acentos, pagamento, origem e situação', () => {
    const t = item({
      sourceType: 'imported',
      paymentMethodName: 'Cartao de credito',
      notes: 'Observação',
    });
    expect(
      filterTransactions([t], {
        search: 'observacao',
        source: 'imported',
        payment: 'creditCard',
        status: 'planned',
      }),
    ).toEqual([t]);
    expect(filterTransactions([t], { payment: 'other' })).toEqual([]);
    expect(filterTransactions([t], { search: 'R$ 1.234,56' })).toEqual([t]);
    expect(filterTransactions([item({ actualAmount: 0 })], { search: '1234,56' })).toEqual([]);
    expect(filterTransactions([item({ notes: 'literal %_\\' })], { search: '%_\\' })).toHaveLength(
      1,
    );
  });
  it('mantém as prioridades no topo e ordena os demais por valor e descrição', () => {
    const items = [
      item({ id: 'x', plannedAmount: 50 }),
      item({ id: 'p', priorityPosition: 1 }),
      item({ id: 'q', priorityPosition: 0 }),
      item({ id: 'z', plannedAmount: 5 }),
    ];
    expect(orderedTransactions(items, 'amount', 'desc').map((t) => t.id)).toEqual([
      'q',
      'p',
      'x',
      'z',
    ]);
    expect(orderedTransactions(items, 'amount').map((t) => t.id)).toEqual(['q', 'p', 'z', 'x']);
  });
  it('herda recorrências apenas a partir do mês escolhido sem perder o snapshot', () => {
    const recurring = item({ id: 'r', sourceType: 'recurring', sourceId: 'series' });
    const rows = [{ recurringId: 'series', position: 0, pinnedFromMonth: '2026-09' }];
    expect(
      priorityOrderForMonth('2026-08', [recurring, item()], rows, [
        { transactionId: 'a', position: 0 },
      ]),
    ).toEqual(['a']);
    expect(
      priorityOrderForMonth('2026-09', [recurring, item()], rows, [
        { transactionId: 'a', position: 0 },
      ]),
    ).toEqual(['a', 'r']);
  });
  it('sugere por frequência e usa os dados mais recentes inclusive realizado zero', () => {
    const items = [
      item({ dueDate: '2026-08-30' }),
      item({ id: 'b', actualAmount: 0, categoryId: 'new' }),
      item({ id: 'c', description: 'Café cancelado', status: 'cancelled' }),
      item({ id: 'd', kind: 'income' }),
    ];
    expect(historySuggestions(items, 'expense', 'Cafe')).toEqual([]); // LIKE do desktop distingue diacríticos.
    expect(historySuggestions(items, 'expense', 'CaFÉ')[0]).toMatchObject({
      uses: 2,
      amount: 0,
      categoryId: 'new',
    });
    expect(historySuggestions(items, 'expense', 'C')).toEqual([]);
  });
  it('calcula categorias por competência em centavos sem contar cancelados', () => {
    expect(
      categoryBreakdown(
        [
          item({ plannedAmount: 0.1 }),
          item({ id: 'b', plannedAmount: 0.2 }),
          item({ id: 'c', status: 'cancelled' }),
          item({ id: 'd', status: 'paid', settledDate: '2026-10-01' }),
        ],
        '2026-09',
      ),
    ).toEqual([{ name: 'Alimentação', color: '#9C8AA5', amount: 0.3 }]);
  });
});
describe('arquivos locais compatíveis com desktop', () => {
  it('exporta e importa CSV com BOM, aspas, vírgulas e observações em várias linhas', () => {
    const original = item({
      description: 'Compra, "teste"',
      notes: 'Linha 1\nLinha 2',
      actualAmount: 0,
      status: 'paid',
      settledDate: '2026-09-30',
    });
    const csv = exportTransactionsCsv([original]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(importTransactionsCsv(csv, 'arquivo.csv')[0]).toMatchObject({
      input: {
        description: original.description,
        notes: original.notes,
        actualAmount: 0,
        settledDate: '2026-09-30',
      },
    });
    expect(exportTransactionsCsv([original], '2026-08').split('\n')).toHaveLength(1);
  });
  it('lê CSV de ponto e vírgula e decimal com vírgula', () => {
    const csv = exportTransactionsCsv([item()]).replace(/,/g, ';').replace('1234.56', '1234,56');
    expect(importTransactionsCsv(csv, 'a.csv')[0].input.plannedAmount).toBe(1234.56);
  });
  it.each(['"ab', 'a"b,c', '"a"b,c'])('recusa CSV malformado %s', (csv) =>
    expect(() => parseCsv(csv)).toThrow(),
  );
  it('recusa estrutura, valores e datas inválidas antes de importar', () => {
    expect(() => importTransactionsCsv('tipo,descricao\nincome,a', 'a.csv')).toThrow();
    expect(() =>
      importTransactionsCsv(exportTransactionsCsv([item({ dueDate: '2026-02-31' })]), 'a.csv'),
    ).toThrow();
    expect(() =>
      importTransactionsCsv(exportTransactionsCsv([item({ plannedAmount: -1 })]), 'a.csv'),
    ).toThrow();
  });
  it('reconhece JSON do desktop, valida envelope e traduz centavos sem arredondar', () => {
    expect(parseBackupJson(JSON.stringify({ version: 1, data: {} })).desktop).toBe(true);
    expect(
      desktopBackupData({
        transactions: [{ id: 'x', planned_cents: 123, actual_cents: 0, source_type: 'manual' }],
      }).transactions[0],
    ).toMatchObject({ planned_amount_cents: 123, actual_amount_cents: 0, occurrence_date: null });
    expect(() => parseBackupJson('{"version":2,"data":{}}')).toThrow();
    expect(() => parseBackupJson('{"version":1,"platform":"mobile","data":{}}')).toThrow();
    expect(() => parseBackupJson('{"version":1,"data":{"transactions":[{"id":{}}]}}')).toThrow();
  });
});
it('os controles de prioridade movem todas as ocorrências da série e detectam limites', async () => {
  const { priorityMoveAnchor } = await import('./local-experience');
  const first = item({ id: 'r1', sourceType: 'recurring', sourceId: 'r', priorityPosition: 0 });
  const last = item({ id: 'r2', sourceType: 'recurring', sourceId: 'r', priorityPosition: 1 });
  const manual = item({ id: 'm', priorityPosition: 2 });
  expect(priorityMoveAnchor([first, last, manual], last, 'up').available).toBe(false);
  expect(priorityMoveAnchor([first, last, manual], last, 'down')).toEqual({
    available: true,
    beforeTransactionId: null,
  });
  expect(priorityMoveAnchor([manual, first, last], last, 'down').available).toBe(false);
});
