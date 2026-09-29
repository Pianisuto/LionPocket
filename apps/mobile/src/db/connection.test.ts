import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';

const mocks = vi.hoisted(() => ({ open: vi.fn(), migrate: vi.fn() }));
vi.mock('react-native-nitro-sqlite', () => ({ open: mocks.open }));
vi.mock('./migrations', () => ({ migrate: mocks.migrate }));
const state = globalThis as typeof globalThis & {
  lionPocketDatabase?: Promise<NitroSQLiteConnection>;
};
afterEach(() => {
  delete state.lionPocketDatabase;
  vi.resetAllMocks();
  vi.resetModules();
});

describe('conexão SQLite mobile', () => {
  it('compartilha inicialização concorrente e preserva a conexão no Fast Refresh', async () => {
    const db = { executeAsync: vi.fn().mockResolvedValue({}), close: vi.fn() };
    mocks.open.mockReturnValue(db);
    mocks.migrate.mockResolvedValue(undefined);
    const { database } = await import('./connection');
    expect(await Promise.all([database(), database()])).toEqual([db, db]);
    vi.resetModules();
    expect(await (await import('./connection')).database()).toBe(db);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith({
      name: 'lionpocket.sqlite',
      connection: 'independent',
    });
    expect(mocks.migrate).toHaveBeenCalledTimes(1);
    expect(db.executeAsync).toHaveBeenCalledWith('PRAGMA foreign_keys = ON');
  });
  it('fecha a conexão de uma migration que falhou e permite nova tentativa', async () => {
    const db = { executeAsync: vi.fn().mockResolvedValue({}), close: vi.fn() };
    mocks.open.mockReturnValue(db);
    mocks.migrate
      .mockRejectedValueOnce(new Error('Migration falhou'))
      .mockResolvedValueOnce(undefined);
    const { database } = await import('./connection');
    await expect(database()).rejects.toThrow('Migration falhou');
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(await database()).toBe(db);
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });
});
