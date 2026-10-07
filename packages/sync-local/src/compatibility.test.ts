import { describe, expect, it } from 'vitest';
import { assertCompatibleEnvironment } from './compatibility';

describe('discovery version skew', () => {
  it.each([
    { controlVersion: 2, entityScopes: ['transaction'] }, // Financial wire/domain unchanged.
    {
      controlVersion: 2,
      protocolVersion: 1,
      domainSchema: 1,
      entityScopes: ['transaction', 'goal', 'monthlyPlanning'],
    },
  ])('accepts control v2 discovery %#', (value) =>
    expect(() => assertCompatibleEnvironment(value)).not.toThrow(),
  );
  it.each([
    { controlVersion: 1, entityScopes: ['transaction'] },
    { entityScopes: ['transaction'] },
    { controlVersion: 3, entityScopes: ['transaction'] },
    { controlVersion: 2, protocolVersion: 2, entityScopes: ['transaction'] },
    { controlVersion: 2, domainSchema: 2, entityScopes: ['transaction'] },
    { controlVersion: 2, protocolVersion: '1', entityScopes: ['transaction'] },
  ])('refuses unknown version %#', (value) =>
    expect(() => assertCompatibleEnvironment(value)).toThrow(
      'unsupported_version',
    ),
  );
  it.each([
    ['transaction', 'futureFinancialObject'],
    [],
    ['manualTransaction'],
  ])('refuses unsupported capabilities %j', (...entityScopes) => {
    expect(() =>
      assertCompatibleEnvironment({ controlVersion: 2, entityScopes }),
    ).toThrow('unsupported_capability');
  });
});
