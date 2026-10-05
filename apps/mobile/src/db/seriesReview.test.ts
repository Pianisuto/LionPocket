import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  initialSeriesChoices,
  keepSeriesRecords,
  reviewLegacySeries,
  seriesDecisionGroups,
  startFinancialBaseline,
  type LegacySeriesReview,
  type ProvisionedProfile,
} from '@lionpocket/sync-local';
import { mobileSyncDatabase } from '../sync/database';
import { migrate } from './migrations';
import { sqliteTestConnection } from './sqliteTestConnection';
import { MobileRepository } from './repository';

it('revisa em lote no adaptador Android sem alterar os 127 registros, pagamentos, exclusões ou vínculos', async () => {
  const { db, sqlite } = sqliteTestConnection();
  try {
    await migrate(db);
    const repository = new MobileRepository(db);
    await repository.saveRecurring({
      kind: 'expense',
      active: true,
      description: 'Série antiga',
      plannedAmount: 100,
      startMonth: '2026-01',
      dueDay: 10,
    });
    const parentId = String(
      sqlite.prepare('SELECT id FROM recurring_expenses').get()!.id,
    );
    for (let i = 0; i < 127; i++) {
      const date =
        i < 2
          ? `2026-01-${i === 0 ? '10' : '20'}`
          : `${2026 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-10`;
      sqlite
        .prepare(
          `INSERT INTO transactions(id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,source_type,source_id,occurrence_date,deleted_at,category_id,payment_method_id,notes)
        VALUES(?,'expense',?,?,?, ?,?,?, 'recurring',?,?,?,'cat-food','payment-pix',?)`,
        )
        .run(
          `old-${i}`,
          `Registro ${i}`,
          10000 + i,
          i === 0 ? 0 : null,
          date,
          i === 0 ? '2026-01-11' : null,
          i === 0 ? 'paid' : 'planned',
          parentId,
          date,
          i === 1 ? '2026-01-21T00:00:00.000Z' : null,
          `Nota ${i}`,
        );
    }
    const profile: ProvisionedProfile = {
      formatVersion: 1,
      installationId: randomUUID(),
      deviceId: randomUUID(),
      signingPublicKey: '',
      boxPublicKey: '',
      pin: {
        serverId: randomUUID(),
        serverEpoch: randomUUID(),
        vaultId: randomUUID(),
        founderDeviceId: randomUUID(),
        authorityPublicKey: 'A'.repeat(43),
        keyVersion: 1,
      },
      grants: [],
      checkpoint: { version: '1', sha256: 'A'.repeat(43) },
    };
    const syncDb = mobileSyncDatabase(db);
    await syncDb.run(
      startFinancialBaseline(
        profile,
        'https://fixture.invalid',
        '/fixture.sqlite',
        randomUUID,
      ),
    );
    const tables = [
      'transactions',
      'recurring_expenses',
      'categories',
      'payment_methods',
    ];
    const before = tables.map((table) =>
      sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    const rows = sqlite
      .prepare('SELECT * FROM transactions ORDER BY due_date,id')
      .all();
    const review: LegacySeriesReview = {
      entityType: 'recurring',
      localId: parentId,
      description: 'Série antiga',
      frequency: 'monthly',
      scheduleEpoch: 'epoch',
      startingInstallment: 1,
      anchorToActual: false,
      slots: rows.map((t) => ({
        localId: String(t.id),
        description: String(t.description),
        status: String(t.status),
        currentDate: String(t.occurrence_date),
        dueDate: String(t.due_date),
        originalDate: String(t.occurrence_date),
        dateNeedsReview: false,
        installmentNumber: null,
        plannedAmountCents: Number(t.planned_amount_cents),
        actualAmountCents: t.actual_amount_cents as number | null,
        settledDate: t.settled_date as string | null,
        deletedAt: t.deleted_at as string | null,
      })),
    };
    const choices = keepSeriesRecords(
      review,
      initialSeriesChoices(review),
      seriesDecisionGroups(review)[0].records,
    );
    await syncDb.run(
      reviewLegacySeries('recurring', parentId, choices, randomUUID),
    );
    expect(
      tables.map((table) =>
        sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    ).toEqual(before);
    const slots = sqlite.prepare('SELECT * FROM sync_slots').all();
    expect(slots).toHaveLength(127);
    expect(new Set(slots.map((slot) => slot.object_id)).size).toBe(127);
    expect(new Set(slots.map((slot) => slot.slot_key)).size).toBe(127);
    expect(sqlite.prepare('SELECT * FROM sync_tombstones').all()).toHaveLength(
      1,
    );
    expect(
      sqlite.prepare("SELECT * FROM sync_outbox WHERE state='blocked'").all(),
    ).toHaveLength(0);
    expect(
      sqlite
        .prepare('SELECT payload_json FROM sync_outbox')
        .all()
        .every(
          (row) =>
            JSON.parse(String(row.payload_json)).operations.length <= 100,
        ),
    ).toBe(true);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    sqlite.close();
  }
});
