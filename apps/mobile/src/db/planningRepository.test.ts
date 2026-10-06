import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallmentPurchaseInput, RecurringExpenseInput } from '@lionpocket/core';
import { MobileRepository } from './repository';
import { migrate, migrations } from './migrations';
import { sqliteTestConnection } from './sqliteTestConnection';
const connections: DatabaseSync[] = [],
  directories: string[] = [];
async function open(path?: string) {
  const { db, sqlite } = sqliteTestConnection(path);
  connections.push(sqlite);
  await migrate(db);
  return { repository: new MobileRepository(db), db, sqlite };
}
const recurring = (extra: Partial<RecurringExpenseInput> = {}): RecurringExpenseInput => ({
  kind: 'expense',
  active: true,
  description: 'Internet',
  plannedAmount: 100,
  startMonth: '2026-09',
  dueDay: 10,
  ...extra,
});
const purchase = (extra: Partial<InstallmentPurchaseInput> = {}): InstallmentPurchaseInput => ({
  description: 'Computador',
  installmentAmount: 100,
  totalInstallments: 4,
  currentInstallment: 2,
  currentDueDate: '2026-09-10',
  ...extra,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-01T12:00:00-03:00'));
});
afterEach(() => {
  vi.useRealTimers();
  connections.splice(0).forEach((db) => {
    try {
      db.close();
    } catch {
      /* already reopened */
    }
  });
  directories.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});

describe('planejamento SQLite local', () => {
  it.each([false, true])('uses the Desktop date fallback without rewriting nullable storage (card: %s)', async card => {
    const { repository: r, sqlite } = await open();
    let cardId: string | undefined;
    if (card) {
      await r.createCatalog({ type: 'card', name: 'Card', dueDay: 10 });
      cardId = (await r.catalogs()).cards[0].id;
    }
    await r.saveRecurring(recurring({ startMonth: '2026-02', dueDay: 31, chargeDay: 15, cardId }));
    sqlite.exec('UPDATE recurring_expenses SET start_date=NULL');
    expect(await r.listRecurring()).toMatchObject([{ startDate: card ? '2026-02-15' : '2026-02-28' }]);
    await r.list({ month: '2026-03' });
    expect(sqlite.prepare('SELECT start_date FROM recurring_expenses').get()).toMatchObject({ start_date: null });
  });
  it('allows a replacement of a deleted occurrence while preventing two live occurrences', async () => {
    const { sqlite } = await open();
    const insert = sqlite.prepare(`INSERT INTO transactions(id,kind,description,planned_amount_cents,due_date,status,source_type,source_id,occurrence_date,deleted_at)
      VALUES(?,'expense','Occurrence',0,?,'planned','recurring','series','2026-10-10',?)`);
    insert.run('deleted', '2026-10-10', '2026-10-01');
    insert.run('replacement', '2026-10-11', null);
    expect(() => insert.run('duplicate', '2026-10-12', null)).toThrow('UNIQUE');
  });
  it('migra v2 com vínculos, valores realizados e exclusões intactos; reabre tudo em disco', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lion-mobile-'));
    directories.push(dir);
    const path = join(dir, 'mobile.sqlite');
    const legacy = sqliteTestConnection(path);
    migrations
      .slice(0, 2)
      .flat()
      .forEach((sql) => legacy.sqlite.exec(sql));
    legacy.sqlite.exec(`PRAGMA user_version = 2;
      INSERT INTO transactions (id, kind, description, planned_amount_cents, actual_amount_cents, due_date, settled_date, status, notes, category_id, payment_method_id)
        VALUES ('legacy', 'expense', 'Legado', 10000, 9025, '2026-09-10', '2026-09-11', 'paid', 'Preservar', 'cat-food', 'payment-pix');
      INSERT INTO transactions (id, kind, description, planned_amount_cents, due_date, status, deleted_at) VALUES ('deleted', 'income', 'Excluído', 1, '2026-09-10', 'planned', '2026-09-01');`);
    legacy.sqlite.close();
    const { repository: r, sqlite } = await open(path);
    await r.saveRecurring(recurring());
    await r.saveInstallment(purchase());
    await r.saveGoal({
      name: 'Reserva',
      targetAmount: 1200,
      savedAmount: 300,
      priority: 'high',
      status: 'saving',
      dueDate: '2026-12-01',
    });
    const before = await r.list({ month: '2026-09' });
    sqlite.close();
    const { repository: reopened, db } = await open(path);
    await migrate(db);
    expect(await reopened.list({ month: '2026-09' })).toEqual(before);
    expect(before.find((t) => t.id === 'legacy')).toMatchObject({
      plannedAmount: 100,
      actualAmount: 90.25,
      categoryId: 'cat-food',
      paymentMethodId: 'payment-pix',
      sourceType: 'manual',
    });
    expect(await reopened.listGoals()).toMatchObject([
      { progress: 0.25, remainingAmount: 900, suggestedMonthlyAmount: 225 },
    ]);
    expect(await reopened.listInstallments('2026-09')).toMatchObject([{ paidInstallments: 1 }]);
    expect(await reopened.listRecurring()).toHaveLength(1);
  });
  it('gera mensal/semana/única/custom/manual sem cortar a âncora de dia 31', async () => {
    const { repository: r } = await open();
    await r.saveRecurring(recurring({ startMonth: '2026-01', dueDay: 31 }));
    expect((await r.list({ month: '2026-02' })).map((t) => t.dueDate)).toEqual(['2026-02-28']);
    expect(
      (await r.list({ month: '2026-03' }))
        .filter((t) => t.dueDate.startsWith('2026-03'))
        .map((t) => t.dueDate),
    ).toEqual(['2026-03-31']);
    await r.saveRecurring(
      recurring({ description: 'Semanal', frequency: 'weekly', startDate: '2026-09-01' }),
    );
    await r.saveRecurring(
      recurring({ description: 'Única', frequency: 'once', startDate: '2026-09-04' }),
    );
    await r.saveRecurring(
      recurring({
        description: 'Custom',
        frequency: 'custom',
        intervalCount: 2,
        intervalUnit: 'weeks',
        startDate: '2026-09-02',
      }),
    );
    await r.saveRecurring(
      recurring({ description: 'Manual', frequency: 'manual', manualMonths: ['09', '12'] }),
    );
    const september = await r.list({ month: '2026-09' });
    expect(september.filter((t) => t.description === 'Semanal')).toHaveLength(5);
    expect(september.filter((t) => t.description === 'Custom')).toHaveLength(3);
    expect(september.filter((t) => t.description === 'Única')).toHaveLength(1);
    expect(september.filter((t) => t.description === 'Manual')).toHaveLength(1);
    expect(
      (await r.list({ month: '2026-10' })).filter(
        (t) => t.description === 'Única' || t.description === 'Manual',
      ),
    ).toHaveLength(0);
  });
  it('gera cartão no fechamento, cobre dois meses de deslocamento, edição individual e tombstones', async () => {
    const { repository: r } = await open();
    await r.createCatalog({ type: 'card', name: 'Cartão', closingDay: 20, dueDay: 5 });
    const cardId = (await r.catalogs()).cards[0].id;
    await r.saveRecurring(recurring({ cardId, chargeDay: 20 }));
    expect(await r.list({ month: '2026-10' })).toHaveLength(0);
    const [item] = await r.list({ month: '2026-11' });
    expect(item).toMatchObject({
      purchaseDate: '2026-09-20',
      dueDate: '2026-11-05',
      sourceType: 'recurring',
    });
    await r.save({ ...item, dueDate: '2026-11-07', plannedAmount: 125 });
    expect(await r.list({ month: '2026-11' })).toHaveLength(1);
    await r.remove(item.id);
    expect(await r.list({ month: '2026-11' })).toHaveLength(0);
    const next = await r.list({ month: '2026-12' });
    expect(next).toMatchObject([{ purchaseDate: '2026-10-20' }]);
  });
  it('atualiza meses abertos, preserva pago/realizado/cancelado e pausa/exclui a recorrência', async () => {
    const { repository: r } = await open();
    await r.saveRecurring(recurring());
    const [september] = await r.list({ month: '2026-09' });
    await r.settle(september.id);
    const [october] = (await r.list({ month: '2026-10' })).filter((t) =>
      t.dueDate.startsWith('2026-10'),
    );
    await r.save({ ...october, actualAmount: 75 });
    await r.list({ month: '2026-11' });
    const [definition] = await r.listRecurring();
    await r.saveRecurring({ ...definition, plannedAmount: 150, dueDay: 15 });
    expect((await r.list({ month: '2026-09' }))[0]).toMatchObject({
      plannedAmount: 100,
      actualAmount: 100,
      dueDate: '2026-09-10',
    });
    expect((await r.list({ month: '2026-10' })).find((t) => t.id === october.id)).toMatchObject({
      plannedAmount: 100,
      actualAmount: 75,
      dueDate: '2026-10-10',
    });
    expect(
      (await r.list({ month: '2026-11' })).find((t) => t.dueDate.startsWith('2026-11')),
    ).toMatchObject({ plannedAmount: 150, dueDate: '2026-11-15' });
    await r.saveRecurring({ ...definition, active: false });
    expect(
      (await r.list({ month: '2026-12' })).filter((t) => t.dueDate.startsWith('2026-12')),
    ).toHaveLength(0);
    await r.removeRecurring(definition.id);
    expect(await r.listRecurring()).toHaveLength(0);
    expect((await r.list({ month: '2026-09' }))[0].id).toBe(september.id);
  });
  it('recalcula custom ancorada em recebimento real e preserva projeção com valor realizado', async () => {
    const { repository: r } = await open();
    await r.saveRecurring(
      recurring({
        kind: 'income',
        frequency: 'custom',
        anchorToActual: true,
        startDate: '2026-09-01',
        intervalUnit: 'days',
        intervalCount: 10,
      }),
    );
    const items = await r.list({ month: '2026-09' });
    expect(items.map((t) => t.dueDate)).toEqual(['2026-09-01', '2026-09-11', '2026-09-21']);
    await r.save({ ...items[0], status: 'received', actualAmount: 98, settledDate: '2026-09-03' });
    expect((await r.list({ month: '2026-09' })).map((t) => t.dueDate)).toEqual([
      '2026-09-01',
      '2026-09-13',
      '2026-09-23',
    ]);
  });
  it('corrige parcelas, amplia/reduz total e preserva datas/valores pagos', async () => {
    const { repository: r } = await open();
    await r.saveInstallment(purchase());
    const [sep] = await r.list({ month: '2026-09' });
    await r.save({ ...sep, status: 'paid', actualAmount: 90, settledDate: '2026-09-10' });
    const [view] = await r.listInstallments('2026-10');
    await r.saveInstallment(
      purchase({
        id: view.id,
        originalCurrentInstallment: 3,
        currentInstallment: 4,
        totalInstallments: 6,
        installmentAmount: 120,
        currentDueDate: '2026-10-12',
      }),
    );
    const sepAfter = (await r.list({ month: '2026-09' }))[0];
    expect(sepAfter).toMatchObject({
      installmentNumber: 3,
      plannedAmount: 100,
      actualAmount: 90,
      dueDate: '2026-09-10',
    });
    expect((await r.list({ month: '2026-10' }))[0]).toMatchObject({
      installmentNumber: 4,
      plannedAmount: 120,
      dueDate: '2026-10-12',
    });
    await expect(
      r.saveInstallment(purchase({ id: view.id, currentInstallment: 2, totalInstallments: 2 })),
    ).rejects.toThrow();
    await r.removeInstallment(view.id);
    expect(await r.listInstallments('2026-10')).toHaveLength(0);
    expect((await r.list({ month: '2026-09' }))[0].id).toBe(sep.id);
    expect((await r.list({ month: '2026-10' })).filter((t) => t.status === 'planned')).toHaveLength(
      0,
    );
  });
  it('lotes são idempotentes, preservam realizado zero e geração concorrente não duplica', async () => {
    const { repository: r } = await open();
    await r.saveRecurring(recurring());
    const [a, b] = await Promise.all([r.list({ month: '2026-09' }), r.list({ month: '2026-09' })]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    await r.save({ ...a[0], actualAmount: 0 });
    expect(await r.settleMany([a[0].id, a[0].id, 'missing'])).toBe(1);
    expect(await r.settleMany([a[0].id])).toBe(0);
    expect((await r.list({ month: '2026-09' }))[0].actualAmount).toBe(0);
  });
  it('edita/exclui catálogos com todos os vínculos, preservando planejamento e valores', async () => {
    const { repository: r } = await open();
    await r.createCatalog({ type: 'card', name: 'Cartão', dueDay: 10 });
    const cardId = (await r.catalogs()).cards[0].id;
    await r.saveRecurring(
      recurring({ cardId, categoryId: 'cat-food', paymentMethodId: 'payment-pix' }),
    );
    await r.saveInstallment(
      purchase({ cardId, categoryId: 'cat-food', paymentMethodId: 'payment-pix' }),
    );
    await r.saveGoal({
      name: 'Meta',
      targetAmount: 100,
      savedAmount: 150,
      priority: 'low',
      status: 'paused',
      categoryId: 'cat-food',
    });
    await r.list({ month: '2026-09' });
    await r.createCatalog({ id: 'payment-pix', type: 'paymentMethod', name: 'Pix renomeado' });
    expect((await r.listRecurring())[0].paymentMethodName).toBe('Pix renomeado');
    await expect(
      r.createCatalog({ id: 'cat-food', type: 'category', name: 'Comida', kind: 'income' }),
    ).rejects.toThrow('em uso');
    for (const [type, id] of [
      ['card', cardId],
      ['category', 'cat-food'],
      ['paymentMethod', 'payment-pix'],
    ] as const)
      await r.removeCatalog(type, id);
    expect((await r.listRecurring())[0]).toMatchObject({
      cardId: null,
      categoryId: null,
      paymentMethodId: null,
      chargeDay: null,
    });
    expect((await r.listInstallments('2026-09'))[0]).toMatchObject({
      cardId: null,
      categoryId: null,
      paymentMethodId: null,
    });
    expect((await r.listGoals())[0]).toMatchObject({
      categoryId: null,
      remainingAmount: 0,
      progress: 1,
      status: 'paused',
    });
    expect((await r.list({ month: '2026-09' }))[0].plannedAmount).toBe(100);
  });
  it('falha no meio de geração/gravação em lote reverte todas as mudanças', async () => {
    const { repository: r, sqlite } = await open();
    sqlite.exec(
      `CREATE TRIGGER fail_installment BEFORE INSERT ON transactions WHEN NEW.installment_number = 3 BEGIN SELECT RAISE(ABORT, 'falha'); END`,
    );
    await expect(r.saveInstallment(purchase())).rejects.toThrow('falha');
    expect(sqlite.prepare('SELECT * FROM installment_purchases').all()).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM transactions').all()).toEqual([]);
    await r.saveRecurring(recurring());
    const [t] = await r.list({ month: '2026-09' });
    await r.save({
      kind: 'income',
      description: 'Salário',
      plannedAmount: 100,
      dueDate: '2026-09-02',
      status: 'planned',
    });
    const income = (await r.list({ month: '2026-09' })).find((i) => i.kind === 'income')!;
    sqlite.exec(
      `CREATE TRIGGER fail_settle BEFORE UPDATE ON transactions WHEN NEW.kind = 'income' AND NEW.status = 'received' BEGIN SELECT RAISE(ABORT, 'falha'); END`,
    );
    await expect(r.settleMany([t.id, income.id])).rejects.toThrow('falha');
    expect((await r.list({ month: '2026-09' })).every((i) => i.status === 'planned')).toBe(true);
  });
  it('reverte toda a migration 3 quando uma tabela de planejamento conflita', async () => {
    const { sqlite, db } = sqliteTestConnection();
    connections.push(sqlite);
    migrations
      .slice(0, 2)
      .flat()
      .forEach((sql) => sqlite.exec(sql));
    sqlite.exec('PRAGMA user_version = 2; CREATE TABLE goals (id TEXT)');
    await expect(migrate(db)).rejects.toThrow();
    expect(sqlite.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
    expect(
      sqlite
        .prepare('PRAGMA table_info(transactions)')
        .all()
        .some((column) => column.name === 'source_type'),
    ).toBe(false);
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'recurring_expenses'").all(),
    ).toEqual([]);
  });
  it('mantém cinco cobranças semanais na mesma fatura e permite quitar todas em lote', async () => {
    const { repository: r } = await open();
    await r.createCatalog({ type: 'card', name: 'Semanal', closingDay: 31, dueDay: 5 });
    const cardId = (await r.catalogs()).cards[0].id;
    await r.saveRecurring(recurring({ cardId, frequency: 'weekly', startDate: '2026-09-01' }));
    const items = await r.list({ month: '2026-10' });
    expect(items).toHaveLength(5);
    expect(new Set(items.map((t) => t.dueDate))).toEqual(new Set(['2026-10-05']));
    expect(new Set(items.map((t) => t.purchaseDate)).size).toBe(5);
    expect(await r.list({ month: '2026-10' })).toEqual(items);
    expect(await r.settleMany(items.map((t) => t.id))).toBe(5);
    expect((await r.list({ month: '2026-10' })).every((t) => t.status === 'paid')).toBe(true);
  });
  it('ajustar uma ocorrência única ou semanal não regenera sua data original', async () => {
    const { repository: r } = await open();
    await r.saveRecurring(recurring({ frequency: 'once', startDate: '2026-09-10' }));
    const [item] = await r.list({ month: '2026-09' });
    await r.save({ ...item, dueDate: '2026-10-03', plannedAmount: 110 });
    expect(await r.list({ month: '2026-09' })).toHaveLength(0);
    expect((await r.list({ month: '2026-10' })).map((t) => t.id)).toEqual([item.id]);
    await r.remove(item.id);
    expect(await r.list({ month: '2026-09' })).toHaveLength(0);
    expect(await r.list({ month: '2026-10' })).toHaveLength(0);
  });
});
