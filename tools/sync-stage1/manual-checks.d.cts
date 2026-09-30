import type { TransactionInput } from '@lionpocket/core';
export function runManualChecks(adapter: {
  read(sql: string, params?: (string | number | null)[]): Promise<Record<string, string | number | null>[]>;
  save(input: TransactionInput): unknown;
  settle(id: string): unknown;
  remove(id: string): unknown;
  enable(): unknown;
}): Promise<{ result: string; checks: number; faultCases: number; revisions: number; outbox: number }>;
