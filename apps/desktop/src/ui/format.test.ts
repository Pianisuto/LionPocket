import { describe, expect, it } from 'vitest';
import { overdueLabel } from './format';

describe('rótulo de atraso', () => {
  const today = new Date('2026-08-14T09:00:00');

  it('conta os dias desde o vencimento', () => {
    expect(overdueLabel('2026-08-01', today)).toBe('13 dias em atraso');
  });

  it('usa o singular no primeiro dia', () => {
    expect(overdueLabel('2026-08-13', today)).toBe('1 dia em atraso');
  });

  it('não trata o próprio dia do vencimento como atraso', () => {
    expect(overdueLabel('2026-08-14', today)).toBe('vence hoje');
  });

  it('compara por dia de calendário, não por horas cheias', () => {
    // Vencida ontem às 23h continua sendo "1 dia", mesmo faltando 24h corridas.
    expect(overdueLabel('2026-08-13', new Date('2026-08-14T00:30:00'))).toBe('1 dia em atraso');
  });
});
