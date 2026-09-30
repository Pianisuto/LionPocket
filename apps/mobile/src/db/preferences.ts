import type { LeoAccessory } from '@lionpocket/core';
import type { Connection } from './planningRepository';

export interface LocalPreferences {
  theme: 'dark' | 'light';
  showPriorities: boolean;
  leoAccessory: LeoAccessory;
  leoPets: number;
}
export const defaultPreferences: LocalPreferences = {
  theme: 'dark',
  showPriorities: true,
  leoAccessory: 'none',
  leoPets: 0,
};
export async function readPreferences(
  db: Connection,
): Promise<LocalPreferences> {
  const rows = (
    await db.executeAsync<{ key: string; value: string }>(
      'SELECT key, value FROM local_preferences',
    )
  ).rows._array;
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const pets = Number(stored.leoPets);
  return {
    theme: stored.theme === 'light' ? 'light' : 'dark',
    showPriorities: stored.showPriorities !== 'false',
    leoAccessory: ['none', 'bow', 'glasses', 'crown', 'party'].includes(
      stored.leoAccessory,
    )
      ? (stored.leoAccessory as LeoAccessory)
      : 'none',
    leoPets: Number.isSafeInteger(pets) && pets >= 0 ? pets : 0,
  };
}
export async function writePreferences(
  db: Connection,
  patch: Partial<LocalPreferences>,
) {
  const entries = Object.entries(patch);
  for (const [key, value] of entries) {
    if (
      (key === 'theme' && ['dark', 'light'].includes(String(value))) ||
      (key === 'showPriorities' && typeof value === 'boolean') ||
      (key === 'leoAccessory' &&
        ['none', 'bow', 'glasses', 'crown', 'party'].includes(String(value))) ||
      (key === 'leoPets' && Number.isSafeInteger(value) && Number(value) >= 0)
    )
      continue;
    throw new Error('Preferência inválida.');
  }
  await db.transaction(async (tx) => {
    for (const [key, value] of entries)
      await tx.executeAsync(
        'INSERT INTO local_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, String(value)],
      );
  });
}
