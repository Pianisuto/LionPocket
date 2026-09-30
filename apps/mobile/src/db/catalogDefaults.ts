import { standardCategories } from '@lionpocket/core';
import type { Connection } from './planningRepository';
const knownIds: Record<string, string> = {
  Alimentação: 'cat-food',
  Moradia: 'cat-home',
  Transporte: 'cat-transport',
  Saúde: 'cat-health',
  Lazer: 'cat-leisure',
  'Salário CLT': 'cat-salary',
};
/** Only called when opening a newly created database, never after restore/upgrade. */
export async function seedNewCatalogs(db: Connection): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of [
      'transactions',
      'recurring_expenses',
      'installment_purchases',
      'goals',
    ]) {
      if (
        (await tx.executeAsync(`SELECT id FROM ${table} LIMIT 1`)).rows._array
          .length
      )
        throw new Error(
          'Os cadastros iniciais só podem ser preparados em um banco novo.',
        );
    }
    await tx.executeAsync('DELETE FROM categories');
    for (const [index, [name, kind, color]] of standardCategories.entries())
      await tx.executeAsync(
        'INSERT INTO categories (id, name, kind, color) VALUES (?, ?, ?, ?)',
        [knownIds[name] ?? `default-category-${index}`, name, kind, color],
      );
    await tx.executeAsync(
      "UPDATE payment_methods SET name = 'PIX' WHERE id = 'payment-pix'",
    );
  });
}
