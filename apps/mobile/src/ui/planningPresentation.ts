import { freeNowComposition, freeNowHeadline, freeNowRowDate, protectionHint, type FreeNow, type ProtectionBalance } from '@lionpocket/core';
const money = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

/** Auxiliary line under "Projetado"; null keeps the original card untouched. */
export function protectionLine(protection?: ProtectionBalance | null): { text: string; negative: boolean } | null {
  const text = protectionHint(protection);
  return text && protection ? { text, negative: protection.balanceAfterProtectionCents < 0 } : null;
}

export interface FreeNowView {
  label: string;
  value: string;
  negative: boolean;
  note: string;
  timeline: { key: string; date: string; label: string; delta: string; balance: string; negative: boolean; lowest: boolean }[];
  lines: { key: string; label: string; value: string; negative: boolean }[];
}

/** Display model for "Pode gastar hoje"; every number comes from the shared core calculation. */
export function freeNowView(freeNow?: FreeNow | null): FreeNowView | null {
  if (!freeNow) return null;
  const headline = freeNowHeadline(freeNow);
  return {
    label: headline.label,
    value: money(headline.cents / 100),
    negative: headline.negative,
    note: headline.note,
    timeline: freeNow.timeline.map((row) => ({
      key: row.key,
      date: freeNowRowDate(row, freeNow.today),
      label: row.kind === 'start' ? 'Em mãos (recebido − pago no mês)' : row.label,
      delta: row.kind === 'start' ? '' : `${row.cents >= 0 ? '+' : '−'} ${money(Math.abs(row.cents) / 100)}`,
      balance: money(row.balanceCents / 100),
      negative: row.balanceCents < 0,
      lowest: row.lowest,
    })),
    lines: freeNowComposition(freeNow).map((line) => ({
      key: line.key,
      label: line.label,
      value: money(line.cents / 100),
      negative: line.cents < 0,
    })),
  };
}
