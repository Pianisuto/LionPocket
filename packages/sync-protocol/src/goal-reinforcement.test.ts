import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { assertFinancialRevision, canonicalStringify } from './index';
const audit = JSON.parse(JSON.parse(readFileSync(`${process.cwd()}/fixtures/crypto.json`, 'utf8')).plaintextCanonical);
const goalId = '3f2b9a6e-6f1c-4d57-8e1e-5a2f0f7a9c10';
const revision = (snapshot: unknown) => ({ ...audit, entityType: 'goalMonthlyReinforcement', dependencies: [], snapshot });
it('decodes goal reinforcement cents and zero as ordinary financial puts', () => {
  for (const amountCents of [0, 1, 50000, Number.MAX_SAFE_INTEGER]) {
    const value = revision({ goalId, month: '2026-10', amountCents });
    expect(() => assertFinancialRevision(value)).not.toThrow();
    expect(JSON.parse(canonicalStringify(value)).snapshot).toEqual(value.snapshot);
  }
});
it('quarantines invalid, missing or unknown goal reinforcement fields', () => {
  for (const snapshot of [
    { goalId, month: '2026-13', amountCents: 1 },
    { goalId, month: '2026-10', amountCents: -1 },
    { goalId, month: '2026-10', amountCents: 0.5 },
    { goalId, month: '2026-10', amountCents: Number.MAX_SAFE_INTEGER + 1 },
    { goalId, month: '2026-10', amountCents: null },
    { goalId: 'not-a-uuid', month: '2026-10', amountCents: 1 },
    { goalId: null, month: '2026-10', amountCents: 1 },
    { goalId, month: '2026-10' },
    { goalId, month: '2026-10', amountCents: 1, savedAmountCents: 10 },
  ]) expect(() => assertFinancialRevision(revision(snapshot))).toThrow();
});
it('accepts a delete tombstone for a retired reinforcement', () => {
  expect(() => assertFinancialRevision({ ...audit, entityType: 'goalMonthlyReinforcement', dependencies: [], action: 'delete', snapshot: null, reason: 'user', deletedAt: audit.authoredAt, slotKey: null, importKey: null })).not.toThrow();
});
