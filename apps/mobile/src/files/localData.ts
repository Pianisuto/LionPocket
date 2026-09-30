import { open } from 'react-native-nitro-sqlite';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';
import {
  desktopBackupData,
  exportTransactionsCsv,
  importTransactionsCsv,
  parseBackupJson,
  planFinancialSpreadsheet,
  readXlsxBase64,
  type LocalBackup,
} from '@lionpocket/core';
import { database } from '../db/connection';
import { MobileRepository } from '../db/repository';
import {
  captureBackup,
  loadBackupData,
  restoreBackup,
  verifyDatabase,
} from '../db/backupRepository';
import {
  applyImportPlan,
  csvImportPlan,
  mergedDesktopBackup,
  type ImportCounts,
  type ImportPlan,
} from '../db/importRepository';
import { migrate, migrations } from '../db/migrations';
import { localFiles, type LocalFile, type PickedFile } from './native';

export interface PreparedImport {
  fileName: string;
  mode: 'restore' | 'desktop' | 'append';
  backup?: LocalBackup;
  plan?: ImportPlan;
  counts?: ImportCounts;
  sourceVersion?: number;
  added?: number;
  skipped?: number;
}
const staging = async <T>(action: (db: NitroSQLiteConnection) => Promise<T>) => {
  const file = await localFiles.prepareFile('transfers', 'sqlite');
  const db = open({ name: file.name, location: file.location, connection: 'independent' });
  try {
    await db.executeAsync('PRAGMA foreign_keys = ON');
    return await action(db);
  } finally {
    db.close();
    await localFiles.removeTransfer(file.name);
  }
};
export async function recoveryBackup(): Promise<LocalFile> {
  const db = await database();
  const file = await localFiles.prepareFile('backups', 'sqlite');
  // VACUUM INTO produces a consistent standalone snapshot including WAL data.
  await db.executeAsync('VACUUM INTO ?', [file.path]);
  return file;
}
export async function exportLocal(
  format: 'json' | 'csv' | 'sqlite',
  month?: string,
): Promise<boolean> {
  const db = await database();
  const file = await localFiles.prepareFile('transfers', format);
  try {
    if (format === 'sqlite') await db.executeAsync('VACUUM INTO ?', [file.path]);
    else if (format === 'json')
      await localFiles.writeText(
        file.location,
        file.name,
        JSON.stringify(await captureBackup(db), null, 2),
      );
    else {
      const repo = new MobileRepository(db);
      const items = await repo.exportTransactions();
      await localFiles.writeText(file.location, file.name, exportTransactionsCsv(items, month));
    }
    return Boolean(
      await localFiles.saveFile(
        file.location,
        file.name,
        format === 'json'
          ? 'application/json'
          : format === 'csv'
            ? 'text/csv'
            : 'application/octet-stream',
        `LionPocket${format === 'csv' && month ? `-${month}` : ''}-${new Date().toISOString().slice(0, 10)}.${format}`,
      ),
    );
  } finally {
    await localFiles.removeTransfer(file.name);
  }
}
export async function prepareImport(file: PickedFile): Promise<PreparedImport> {
  try {
    const extension = file.displayName.split('.').pop()?.toLowerCase();
    if (extension === 'sqlite' || extension === 'db') {
      const db = open({ name: file.name, location: file.location, connection: 'independent' });
      try {
        await db.executeAsync('PRAGMA trusted_schema = OFF');
        await db.executeAsync('PRAGMA foreign_keys = ON');
        const version = Number(
          (await db.executeAsync<{ user_version: number }>('PRAGMA user_version')).rows._array[0]
            .user_version,
        );
        await verifyDatabase(db, version);
        await migrate(db);
        await verifyDatabase(db, migrations.length);
        return {
          mode: 'restore',
          fileName: file.displayName,
          backup: await captureBackup(db),
          sourceVersion: version,
        };
      } finally {
        db.close();
      }
    }
    if (extension === 'json') {
      const parsed = parseBackupJson(await localFiles.readText(file.name));
      const backup = await staging((db) =>
        loadBackupData(
          db,
          parsed.desktop ? { ...desktopBackupData(parsed.data), local_preferences: [] } : parsed.data,
          parsed.desktop ? (parsed.schemaVersion === 6 ? 6 : 5) : parsed.schemaVersion,
        ),
      );
      if (parsed.desktop) {
        const merge = await mergedDesktopBackup(await database(), backup);
        await staging((db) => loadBackupData(db, merge.backup.data, merge.backup.schemaVersion));
        return {
          mode: 'desktop',
          fileName: file.displayName,
          backup,
          added: merge.added,
          skipped: merge.skipped,
        };
      }
      return {
        mode: 'restore',
        fileName: file.displayName,
        backup,
        sourceVersion: parsed.schemaVersion,
      };
    }
    const plan =
      extension === 'csv'
        ? csvImportPlan(
            importTransactionsCsv(await localFiles.readText(file.name), file.displayName),
          )
        : extension === 'xlsx'
          ? planFinancialSpreadsheet(
              await readXlsxBase64(await localFiles.readBase64(file.name)),
              file.displayName,
            )
          : null;
    if (!plan) throw new Error('Formato não suportado.');
    const current = await captureBackup(await database());
    const counts = await staging(async (db) => {
      await loadBackupData(db, current.data, current.schemaVersion);
      return applyImportPlan(db, plan);
    });
    return { mode: 'append', fileName: file.displayName, plan, counts };
  } finally {
    await localFiles.removeTransfer(file.name);
  }
}
export async function commitImport(prepared: PreparedImport): Promise<string> {
  const db = await database();
  if (prepared.mode === 'append' && prepared.plan) {
    await recoveryBackup();
    const counts = await applyImportPlan(db, prepared.plan);
    return `${counts.transactions} lançamento(s), ${counts.recurring} recorrência(s), ${counts.goals} objetivo(s), ${counts.catalogs} cadastro(s) adicionados. ${counts.skipped} já existente(s) ignorado(s).`;
  }
  if (!prepared.backup) throw new Error('Arquivo não preparado.');
  const backup =
    prepared.mode === 'desktop'
      ? (await mergedDesktopBackup(db, prepared.backup)).backup
      : prepared.backup;
  await restoreBackup(db, backup, async () => {
    await recoveryBackup();
  });
  return prepared.mode === 'restore'
    ? 'Restauração concluída. Os dados anteriores estão na cópia de recuperação abaixo.'
    : 'JSON do desktop importado. Registros locais preservados.';
}
