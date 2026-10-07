import { freeNowComposition, freeNowHorizon, protectionHint, type FreeNow, type ProtectionBalance } from '@lionpocket/core';
const money = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

/** Auxiliary line under "Projetado"; null keeps the original card untouched. */
export function protectionLine(protection?: ProtectionBalance | null): { text: string; negative: boolean } | null {
  const text = protectionHint(protection);
  return text && protection ? { text, negative: protection.balanceAfterProtectionCents < 0 } : null;
}

export interface FreeNowView {
  value: string;
  negative: boolean;
  horizon: string;
  lines: { key: string; label: string; value: string; negative: boolean }[];
}

/** Display model for "Livre agora"; every number comes from the shared core calculation. */
export function freeNowView(freeNow?: FreeNow | null): FreeNowView | null {
  if (!freeNow) return null;
  return {
    value: money(freeNow.freeNowCents / 100),
    negative: freeNow.freeNowCents < 0,
    horizon: freeNowHorizon(freeNow),
    lines: freeNowComposition(freeNow).map((line) => ({
      key: line.key,
      label: line.label,
      value: money(line.cents / 100),
      negative: line.cents < 0,
    })),
  };
}
