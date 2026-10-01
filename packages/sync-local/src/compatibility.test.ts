import { describe, expect, it } from 'vitest';
import { assertCompatibleEnvironment } from './compatibility';

describe('discovery version skew', () => {
  it.each([
    { controlVersion: 1, entityScopes: ['transaction'] }, // Previous compatible server.
    { controlVersion: 1, protocolVersion: 1, domainSchema: 1, entityScopes: ['transaction', 'goal'] },
  ])('accepts known v1 discovery %#', value => expect(() => assertCompatibleEnvironment(value)).not.toThrow());
  it.each([
    { controlVersion: 2, entityScopes: ['transaction'] },
    { protocolVersion: 2, entityScopes: ['transaction'] },
    { domainSchema: 2, entityScopes: ['transaction'] },
    { protocolVersion: '1', entityScopes: ['transaction'] },
  ])('refuses unknown version %#', value => expect(() => assertCompatibleEnvironment(value)).toThrow('unsupported_version'));
  it.each([['transaction', 'futureFinancialObject'], [], ['manualTransaction']])('refuses unsupported capabilities %j', (...entityScopes) => {
    expect(() => assertCompatibleEnvironment({ entityScopes })).toThrow('unsupported_capability');
  });
});
