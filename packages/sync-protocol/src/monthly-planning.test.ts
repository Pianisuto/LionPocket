import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { assertFinancialRevision, canonicalStringify } from './index';
const audit = JSON.parse(JSON.parse(readFileSync(`${process.cwd()}/fixtures/crypto.json`, 'utf8')).plaintextCanonical);
const revision = (snapshot: unknown) => ({ ...audit, entityType: 'monthlyPlanning', dependencies: [], snapshot });
it('decodes monthly planning cents and zero as ordinary financial puts without transaction fields', () => {
  for (const cents of [0, 1, 50000, Number.MAX_SAFE_INTEGER]) {
    const value = revision({ month: '2026-10', safetyMarginCents: cents });
    expect(() => assertFinancialRevision(value)).not.toThrow();
    expect(JSON.parse(canonicalStringify(value)).snapshot).toEqual(value.snapshot);
  }
});
it('quarantines invalid or unknown monthly planning fields using the strict financial decoder', () => {
  for (const snapshot of [
    { month: '2026-13', safetyMarginCents: 1 },
    { month: '2026-10', safetyMarginCents: -1 },
    { month: '2026-10', safetyMarginCents: 0.5 },
    { month: '2026-10', safetyMarginCents: Number.MAX_SAFE_INTEGER + 1 },
    { month: '2026-10', safetyMarginCents: null },
    { month: '2026-10' },
    { month: '2026-10', safetyMarginCents: 1, futurePlanning: 10 },
  ]) expect(() => assertFinancialRevision(revision(snapshot))).toThrow();
});
