import {
  assertFinancialRevision,
  canonicalStringify,
  type RevisionPlaintext,
  type EntityType,
} from '@lionpocket/sync-protocol';
const groups: Partial<Record<EntityType, string[][]>> = {
  monthlyPlanning: [['month', 'safetyMarginCents']],
  transaction: [
    ['kind', 'status', 'actualAmountCents', 'settledDate'],
    ['cardId', 'paymentMethodId', 'purchaseDate', 'dueDate'],
    ['description'],
    ['plannedAmountCents'],
    ['categoryId'],
    ['notes'],
    ['source', 'installmentNumber', 'installmentTotal', 'occurrenceDate'],
  ],
  category: [['name'], ['kind'], ['color']],
  paymentMethod: [['name']],
  card: [['name'], ['dueDay', 'closingDay']],
  goal: [
    ['name'],
    ['itemModel', 'link'],
    ['categoryId'],
    ['targetAmountCents'],
    ['savedAmountCents'],
    ['priority'],
    ['dueDate'],
    ['status'],
    ['notes'],
  ],
  recurring: [
    ['kind'],
    ['active'],
    ['description'],
    [
      'startMonth',
      'startDate',
      'frequency',
      'intervalCount',
      'intervalUnit',
      'anchorToActual',
      'manualMonths',
      'scheduleEpoch',
      'identityStatus',
      'aliases',
    ],
    ['cardId', 'paymentMethodId', 'dueDay', 'chargeDay'],
    ['categoryId'],
    ['plannedAmountCents'],
    ['notes'],
  ],
  installmentPurchase: [
    ['description'],
    ['categoryId'],
    ['cardId', 'paymentMethodId', 'purchaseDate', 'firstDueDate'],
    ['installmentAmountCents'],
    ['totalInstallments', 'startingInstallment', 'identityStatus', 'slots'],
    ['status'],
    ['notes'],
  ],
};
/** Merge only compatible complete groups with a unique common base; never sum balances. */
export function mergeFinancialGroups(
  base: RevisionPlaintext,
  branches: RevisionPlaintext[],
  authoredAt: string,
): RevisionPlaintext | null {
  if (
    base.action !== 'put' ||
    branches.some(
      (b) => b.action !== 'put' || b.entityType !== base.entityType,
    ) ||
    !groups[base.entityType]
  )
    return null;
  const original = base.snapshot as unknown as Record<string, unknown>,
    snapshot = { ...original };
  for (const group of groups[base.entityType] ?? []) {
    const pick = (s: Record<string, unknown>) =>
      Object.fromEntries(group.map((k) => [k, s[k]]));
    const baseline = canonicalStringify(pick(original));
    const changed = branches
      .map((b) =>
        pick((b as typeof base).snapshot as unknown as Record<string, unknown>),
      )
      .filter((s) => canonicalStringify(s) !== baseline);
    if (
      changed.length &&
      changed.some(
        (s) => canonicalStringify(s) !== canonicalStringify(changed[0]),
      )
    )
      return null;
    if (changed.length) Object.assign(snapshot, changed[0]);
  }
  const dependencies = new Map<
    string,
    { objectId: string; revisionId: string }
  >();
  for (const b of branches)
    for (const d of b.dependencies) {
      const known = dependencies.get(d.objectId);
      if (known && known.revisionId !== d.revisionId) return null;
      dependencies.set(d.objectId, d);
    }
  const result = {
    ...base,
    authoredAt,
    snapshot,
    dependencies: [...dependencies.values()].sort((a, b) =>
      a.objectId.localeCompare(b.objectId),
    ),
    provenance: { ...base.provenance, origin: 'local' as const },
  } as RevisionPlaintext;
  try {
    assertFinancialRevision(result);
    return result;
  } catch {
    return null;
  }
}
