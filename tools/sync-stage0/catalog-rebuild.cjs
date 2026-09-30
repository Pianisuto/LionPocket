// Disposable-fixture rehearsal ONLY. Never imported by an application.
// Rebuild the complete financial FK graph with FK enforcement still ON.
// Explicit column copies retain every legacy value; no OR IGNORE or deduplication.
function rehearseCatalogRebuild(db, failAfterCopy = false) {
  const names = ['categories', 'payment_methods', 'cards', 'recurring_expenses', 'installment_purchases', 'transactions', 'goals', 'recurring_transaction_priorities', 'transaction_priority_order'];
  const plans = names.map((name) => {
    const original = db.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get(name);
    if (!original || typeof original.sql !== 'string') throw new Error('Missing fixture table.');
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
    let sql = original.sql;
    if (['categories', 'payment_methods', 'cards'].includes(name)) {
      sql = sql.replace(/,\s*UNIQUE\s*\(\s*name\s*,\s*kind\s*\)/i, '').replace(/name TEXT NOT NULL UNIQUE/i, 'name TEXT NOT NULL');
      const added = ['created_at', 'updated_at', 'deleted_at'].filter((column) => !columns.includes(column));
      sql = sql.replace(/\)\s*$/, `, ${added.map((c) => `${c} TEXT`).join(', ')}\n)`);
    }
    return { name, columns, sql };
  });
  const indexes = db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all().filter((i) => names.includes(i.tbl_name));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { name } of plans) db.exec(`CREATE TEMP TABLE stage0_${name} AS SELECT * FROM ${name}`);
    for (const { name } of [...plans].reverse()) db.exec(`DROP TABLE ${name}`);
    for (const { sql } of plans) db.exec(sql);
    for (const { name, columns } of plans) db.exec(`INSERT INTO ${name} (${columns.join(',')}) SELECT ${columns.join(',')} FROM stage0_${name}`);
    if (failAfterCopy) throw new Error('Injected late rebuild failure.');
    for (const { sql } of indexes) db.exec(sql);
    for (const name of ['categories', 'payment_methods', 'cards']) db.exec(`CREATE UNIQUE INDEX stage0_${name}_active_name ON ${name}(name${name === 'categories' ? ', kind' : ''}) WHERE deleted_at IS NULL`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Lost FK during rebuild.');
    for (const { name } of plans) db.exec(`DROP TABLE stage0_${name}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { rehearseCatalogRebuild };
