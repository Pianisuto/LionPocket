/** Control v2 gates zero-touch adoption; the financial wire/domain remain v1.
 * Check discovery before login, proofs, envelope preparation or network writes.
 * Refuse older servers too: they cannot exclude incompatible older peers.
 */
export const SYNC_CONTROL_VERSION = 2;
export function assertCompatibleEnvironment(value: {
  controlVersion?: unknown;
  protocolVersion?: unknown;
  domainSchema?: unknown;
  entityScopes: unknown;
}): void {
  if (value.controlVersion !== SYNC_CONTROL_VERSION)
    throw new Error('unsupported_version');
  for (const version of [value.protocolVersion, value.domainSchema])
    if (version !== undefined && version !== 1)
      throw new Error('unsupported_version');
  const known = [
    'category',
    'paymentMethod',
    'card',
    'recurring',
    'installmentPurchase',
    'transaction',
    'goal',
    'recurringPriorityList',
    'monthlyPriorityList',
  ];
  if (
    !Array.isArray(value.entityScopes) ||
    !value.entityScopes.length ||
    value.entityScopes.some((scope) => !known.includes(scope))
  )
    throw new Error('unsupported_capability');
}
