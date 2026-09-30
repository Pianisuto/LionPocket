import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
type Row = Record<string, SQLOutputValue>;
export interface DatabaseManifest {
  userVersion: SQLOutputValue;
  objects: Row[];
  tables: { name: string; columns: string[]; count: number; rows: Row[]; sha256: string }[];
}
export function captureDatabaseManifest(db: DatabaseSync): DatabaseManifest;
export function projectLegacyColumns(db: DatabaseSync, before: DatabaseManifest): { name: string; columns: string[]; rows: Row[] }[];
