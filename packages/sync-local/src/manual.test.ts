import { describe, expect, it } from 'vitest';
import { incrementDecimal64 } from './manual';
import { uuidFromRandom } from './secrets';
describe('portable local sync', () => {
  it('increments textual counters without precision loss, and refuses exhaustion', () => {
    expect(incrementDecimal64('0')).toBe('1');
    expect(incrementDecimal64('9007199254740999')).toBe('9007199254741000');
    expect(() => incrementDecimal64('9223372036854775807')).toThrow();
    expect(() => incrementDecimal64('01')).toThrow();
  });
  it('UUIDv4 preserves random input and sets RFC variant/version', () => {
    const input = new Uint8Array(16).fill(255);
    expect(uuidFromRandom(input)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(input[6]).toBe(255);
  });
});
