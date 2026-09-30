// Test/offline audit utility. Does not read the user's live database.
const { createHash } = require('node:crypto');
function captureDatabaseManifest(db) {
  const objects = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const tables = objects.filter((o) => o.type === 'table').map((table) => {
    const name = String(table.name);
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unexpected audit identifier.');
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => String(c.name));
    const rows = db.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
    return { name, columns, count: rows.length, rows,
      sha256: createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex') };
  });
  return { userVersion: db.prepare('PRAGMA user_version').get().user_version, objects, tables };
}
function projectLegacyColumns(db, before) {
  return before.tables.map(({ name, columns }) => ({ name, columns,
    rows: db.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')),
  }));
}

module.exports = { captureDatabaseManifest, projectLegacyColumns };
