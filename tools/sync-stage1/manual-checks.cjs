// Shared app-repository scenario; test-only public inputs and empty disposable banks.
async function runManualChecks(adapter) {
  let checks = 0;
  const same = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(label + ': ' + JSON.stringify(a)); checks++; };
  const input = (description, extra = {}) => ({ kind: 'expense', description, plannedAmount: 0,
    actualAmount: null, dueDate: '2026-09-30', status: 'planned', notes: 'ação 🍋 e\u0301', ...extra });
  const tables = ['transactions','transaction_priority_order','sync_local_state','sync_identity','sync_revisions','sync_heads','sync_tombstones','sync_outbox','sync_inbox'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await adapter.read(`SELECT * FROM ${table} ORDER BY 1,2`)])));
  const counts = async () => {
    const data = await snapshot();
    return Object.fromEntries(tables.map((t) => [t, data[t].length]));
  };
  await adapter.save(input('Uso local desativado'));
  same((await adapter.read('SELECT * FROM sync_outbox')).length, 0, 'No unbound outbox');
  same((await adapter.read('SELECT * FROM sync_identity')).length, 0, 'No default enrollment');
  await adapter.read('DELETE FROM transactions');
  await adapter.enable();
  await adapter.save(input('Manual inicial'));
  const [row] = await adapter.read('SELECT * FROM transactions');
  const [identity] = await adapter.read('SELECT * FROM sync_identity');
  same(identity.local_id, row.id, 'Stable local identity');
  same(identity.object_id !== row.id, true, 'Independent global UUID');
  const [initial] = await adapter.read('SELECT * FROM sync_revisions');
  same(JSON.parse(initial.parents_json), [], 'Root revision');
  same(JSON.parse(initial.payload_json).snapshot.actualAmountCents, null, 'NULL stays absent');
  await adapter.save(input('Manual editado', { id: row.id, actualAmount: 0 }));
  const edited = await adapter.read('SELECT * FROM sync_revisions WHERE revision_id != ?', [initial.revision_id]);
  same(JSON.parse(edited[0].parents_json), [initial.revision_id], 'Pending parent preserved');
  same(JSON.parse(edited[0].payload_json).snapshot.actualAmountCents, 0, 'Zero stays explicit');
  await adapter.read("INSERT INTO transaction_priority_order VALUES('2026-09',?,0,'test','test')", [row.id]);
  // Faults run after each write stage, including final counter, not in a mocked writer.
  const failures = [
    ['sync_identity','INSERT','create'], ['sync_revisions','INSERT','create'], ['sync_heads','INSERT','edit'],
    ['sync_tombstones','INSERT','delete'], ['sync_outbox','INSERT','create'], ['sync_outbox','INSERT','edit'],
    ['sync_outbox','INSERT','settle'], ['sync_outbox','INSERT','delete'], ['sync_local_state','UPDATE','create'],
    ['transactions','INSERT','create'], ['transactions','UPDATE','edit'], ['transaction_priority_order','DELETE','delete'],
  ];
  for (const [table, operation, action] of failures) {
    await adapter.read(`CREATE TEMP TRIGGER stage1_fault AFTER ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Injected stage1 failure'); END`);
    const before = await snapshot();
    let refused = false;
    try {
      if (action === 'create') await adapter.save(input('Must roll back'));
      else if (action === 'edit') await adapter.save(input('Must roll back', { id: row.id }));
      else if (action === 'settle') await adapter.settle(row.id);
      else await adapter.remove(row.id);
    } catch (error) { if (!String(error).includes('Injected stage1 failure')) throw error; refused = true; }
    same(refused, true, 'Injected ' + table + '/' + action);
    same(await snapshot(), before, 'Atomic rollback ' + table + '/' + action);
    await adapter.read('DROP TRIGGER stage1_fault');
  }
  await adapter.settle(row.id);
  const latest = (await adapter.read('SELECT r.* FROM sync_revisions r JOIN sync_heads h ON h.revision_id=r.revision_id'))[0];
  same(JSON.parse(latest.payload_json).snapshot.status, 'paid', 'Settlement snapshot');
  same(JSON.parse(latest.payload_json).snapshot.actualAmountCents, 0, 'Settlement keeps zero');
  same((await adapter.read('SELECT * FROM sync_identity'))[0].object_id, identity.object_id, 'Edit/settle identity unchanged');
  await adapter.remove(row.id);
  const result = await counts();
  same(result.sync_revisions, 4, 'All immutable revisions');
  same(result.sync_outbox, 4, 'One pending commit per successful action');
  same(result.sync_heads, 1, 'Single latest head');
  same(result.sync_tombstones, 1, 'Durable tombstone');
  same(result.sync_identity, 1, 'Identity survives deletion');
  same(result.transaction_priority_order, 0, 'Delete removes priority atomically');
  same((await adapter.read('SELECT mode,local_seq,device_seq FROM sync_local_state'))[0], { mode: 'synthetic_manual', local_seq: '4', device_seq: '0' }, 'Local sequence without remote device sequence');
  same((await adapter.read('PRAGMA integrity_check'))[0].integrity_check, 'ok', 'Integrity');
  same((await adapter.read('PRAGMA foreign_key_check')).length, 0, 'FK integrity');
  return { result: 'PASS', checks, faultCases: failures.length, revisions: 4, outbox: 4 };
}
module.exports = { runManualChecks };
