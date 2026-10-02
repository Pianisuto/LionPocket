import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';

const mocks = vi.hoisted(() => ({ open: vi.fn(), migrate: vi.fn() }));
vi.mock('react-native-nitro-sqlite', () => ({ open: mocks.open }));
vi.mock('../files/native', () => ({ localFiles: { prepareFile: vi.fn() } }));
vi.mock('./migrations', () => ({ migrate: mocks.migrate, migrations: Array(8) }));
const state = globalThis as typeof globalThis & {
  lionPocketDatabase?: Promise<NitroSQLiteConnection>;
};
afterEach(() => {
  delete state.lionPocketDatabase;
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('conexão SQLite mobile', () => {
  it('anuncia readiness somente após a migration concluir, nunca após uma falha', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = { executeAsync: vi.fn().mockResolvedValue({}), close: vi.fn() };
    mocks.open.mockReturnValue(db);
    let finish!: () => void;
    mocks.migrate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const { database } = await import('./connection');
    const pending = database();
    await vi.waitFor(() => expect(mocks.migrate).toHaveBeenCalled());
    expect(info).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(info).toHaveBeenCalledExactlyOnceWith('[LionPocket] database ready: lionpocket.sqlite schema=8');
    delete state.lionPocketDatabase;
    info.mockClear();
    mocks.migrate.mockRejectedValueOnce(new Error('Migration falhou'));
    await expect(database()).rejects.toThrow('Migration falhou');
    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledExactlyOnceWith('[LionPocket] database initialization failed: lionpocket.sqlite', 'Migration falhou');
  });
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
