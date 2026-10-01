/** Discovery is checked before login, proofs, envelope preparation or network writes.
 * The previous server omitted protocol/domain fields; controlVersion=1 (or the
 * original in-process fixture) describes the unchanged v1 baseline.
 */
export function assertCompatibleEnvironment(value: {
  controlVersion?: unknown;
  protocolVersion?: unknown;
  domainSchema?: unknown;
  entityScopes: unknown;
}): void {
  for (const version of [value.controlVersion, value.protocolVersion, value.domainSchema])
    if (version !== undefined && version !== 1) throw new Error('unsupported_version');
  const known = ['category', 'paymentMethod', 'card', 'recurring', 'installmentPurchase', 'transaction', 'goal', 'recurringPriorityList', 'monthlyPriorityList'];
  if (!Array.isArray(value.entityScopes) || !value.entityScopes.length || value.entityScopes.some(scope => !known.includes(scope)))
    throw new Error('unsupported_capability');
}
