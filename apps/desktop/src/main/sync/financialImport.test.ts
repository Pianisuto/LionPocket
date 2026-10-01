import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import JSZip from 'jszip';
import { readXlsxBase64, planFinancialSpreadsheet } from '@lionpocket/core';
import { importDigest } from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../database';
import { importFinancialSpreadsheet } from '../importer';
import { sqliteTestConnection } from '../../../../mobile/src/db/sqliteTestConnection';
import { migrate } from '../../../../mobile/src/db/migrations';
import { applyImportPlan } from '../../../../mobile/src/db/importRepository';
it('deduplicates a renamed identical file by provenance while preserving different same-name series and goals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lion-import-')),
    desktop = new LionPocketDatabase(':memory:'),
    mobile = sqliteTestConnection();
  try {
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      '<workbook xmlns:r="urn:r"><sheets><sheet name="Fixas" r:id="rId1"/><sheet name="Objetivos" r:id="rId2"/><sheet name="Out" r:id="rId3"/></sheets></workbook>',
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>',
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row r="3"><c r="B3" t="inlineStr"><is><t>Mensal</t></is></c><c r="E3"><v>10</v></c><c r="F3"><v>10</v></c></row></sheetData></worksheet>',
    );
    zip.file(
      'xl/worksheets/sheet2.xml',
      '<worksheet><sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>Meta</t></is></c><c r="E3"><v>100</v></c><c r="F3"><v>0</v></c></row></sheetData></worksheet>',
    );
    zip.file(
      'xl/worksheets/sheet3.xml',
      '<worksheet><sheetData><row r="13"><c r="B13" t="inlineStr"><is><t>Zero 🦁</t></is></c><c r="D13"><v>0</v></c><c r="E13"><v>0</v></c></row><row r="14"><c r="B14" t="inlineStr"><is><t>Vazio</t></is></c><c r="D14"><v>10</v></c></row><row r="32"><c r="C32" t="inlineStr"><is><t>Despesa zero</t></is></c><c r="F32"><v>0</v></c><c r="G32"><v>0</v></c></row></sheetData></worksheet>',
    );
    const bytes = await zip.generateAsync({ type: 'nodebuffer' }),
      path = join(directory, 'first.xlsx'),
      renamed = join(directory, 'renamed.xlsx');
    await writeFile(path, bytes);
    await copyFile(path, renamed);
    desktop.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Mensal',
      plannedAmount: 20,
      startMonth: '2026-09',
      dueDay: 10,
    });
    desktop.saveGoal({
      name: 'Meta',
      targetAmount: 50,
      savedAmount: 10,
      priority: 'medium',
      status: 'planned',
    });
    await importFinancialSpreadsheet(desktop, path);
    await importFinancialSpreadsheet(desktop, renamed);
    expect(
      desktop.db.prepare('SELECT id FROM recurring_expenses').all(),
    ).toHaveLength(2);
    expect(desktop.db.prepare('SELECT id FROM goals').all()).toHaveLength(2);
    expect(
      desktop.db
        .prepare(
          "SELECT * FROM sync_review WHERE reason LIKE 'import_receipt:%'",
        )
        .all(),
    ).toHaveLength(2);
    expect(
      desktop.db
        .prepare('SELECT actual_cents FROM transactions WHERE description=?')
        .get('Zero 🦁')?.actual_cents,
    ).toBe(0);
    expect(
      desktop.db
        .prepare('SELECT actual_cents FROM transactions WHERE description=?')
        .get('Vazio')?.actual_cents,
    ).toBeNull();
    expect(
      desktop.db
        .prepare(
          'SELECT planned_cents,actual_cents FROM transactions WHERE description=?',
        )
        .get('Despesa zero'),
    ).toMatchObject({ planned_cents: 0, actual_cents: 0 });
    await migrate(mobile.db);
    const digest = importDigest({
        context: 'LionPocket/import-file/v1',
        encoding: 'base64',
        content: bytes.toString('base64'),
      }),
      plan = planFinancialSpreadsheet(
        await readXlsxBase64(bytes.toString('base64')),
        digest,
        '2026-09',
      );
    expect(
      plan.transactions.find((t) => t.input.description === 'Zero 🦁')?.input
        .actualAmount,
    ).toBe(0);
    expect(
      plan.transactions.find((t) => t.input.description === 'Vazio')?.input
        .actualAmount,
    ).toBeNull();
    for (const input of [...plan.recurring, ...plan.goals]) {
      const match = /^xlsx:[a-f0-9]{64}:(.*):(\d+)$/.exec(
        input.importSourceKey!,
      )!;
      input.importSourceKey =
        'lp1:' +
        importDigest({
          context: 'LionPocket/import-row/v1',
          fileDigest: digest,
          sheet: match[1],
          rowIndex: Number(match[2]) - 1,
        });
    }
    const first = await applyImportPlan(mobile.db, plan),
      second = await applyImportPlan(mobile.db, plan);
    expect(first).toMatchObject({ recurring: 1, goals: 1 });
    expect(second).toMatchObject({ recurring: 0, goals: 0, skipped: 5 });
    expect(mobile.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    desktop.db.close();
    mobile.sqlite.close();
    await rm(directory, { recursive: true });
  }
});
