import { describe, expect, it } from 'vitest';
import {
  applySeriesDecision,
  markSeriesRecordForDeletion,
  seriesAssociationChanges,
  seriesDeletionSelectionError,
  seriesDeletionSummary,
  seriesDecisionOptions,
  editSeriesChoice,
  initialSeriesChoices,
  keepSeriesRecords,
  seriesDecisionGroups,
  seriesPendingReason,
  seriesPreservationSummary,
  seriesReviewError,
  type LegacySeriesReview,
  type LegacyReviewRecord,
} from './series-review';
const record = (
  localId: string,
  date: string,
  patch: Partial<LegacyReviewRecord> = {},
): LegacyReviewRecord => ({
  localId,
  description: localId,
  currentDate: date,
  dueDate: date,
  originalDate: date,
  dateNeedsReview: false,
  installmentNumber: null,
  status: 'planned',
  plannedAmountCents: 12500,
  actualAmountCents: null,
  settledDate: null,
  deletedAt: null,
  ...patch,
});
const series = (
  slots: LegacyReviewRecord[],
  patch: Partial<LegacySeriesReview> = {},
): LegacySeriesReview => ({
  entityType: 'recurring',
  localId: 'series',
  description: 'Série antiga',
  frequency: 'monthly',
  scheduleEpoch: 'epoch',
  startingInstallment: 1,
  anchorToActual: false,
  slots,
  ...patch,
});
describe('decisões de séries antigas', () => {
  it('reduz 127 ocorrências de cinco séries a cinco grupos de conflito, deixando o restante na prévia', () => {
    const reviews = [26, 26, 25, 25, 25].map((count, index) =>
      series(
        Array.from({ length: count }, (_, i) =>
          record(
            `${index}-${i}`,
            i < 2
              ? '2026-01-10'
              : `${2026 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-10`,
          ),
        ),
      ),
    );
    expect(reviews.flatMap((review) => review.slots)).toHaveLength(127);
    for (const review of reviews) {
      const groups = seriesDecisionGroups(review);
      expect(groups).toHaveLength(1);
      expect(groups[0].records).toHaveLength(2);
      expect(groups[0].title).toContain('janeiro de 2026');
      const choices = keepSeriesRecords(
        review,
        initialSeriesChoices(review),
        groups[0].records,
      );
      expect(seriesReviewError(review, choices)).toBeNull();
      expect(new Set(choices.map((choice) => choice.slotKey)).size).toBe(
        review.slots.length,
      );
      expect(choices.every((choice) => choice.publish)).toBe(true);
    }
  });
  it('agrupa os registros repetidos com pagamentos e exclusões, conservando todos sem mesclar identidades', () => {
    const review = series([
      record('pago', '2026-01-10', {
        status: 'paid',
        actualAmountCents: 0,
        settledDate: '2026-01-11',
      }),
      record('excluído', '2026-01-20', { deletedAt: '2026-01-21' }),
      record('outra', '2026-02-10'),
    ]);
    const group = seriesDecisionGroups(review)[0];
    expect(group.records.map((item) => item.localId)).toEqual([
      'pago',
      'excluído',
    ]);
    const choices = keepSeriesRecords(
      review,
      initialSeriesChoices(review),
      group.records,
    );
    expect(choices[2].slotKey).toBe('monthly:2026-02');
    expect(seriesReviewError(review, choices)).toBeNull();
    expect(seriesPreservationSummary(review)).toContain(
      '1 pagos ou recebidos · 1 excluídos',
    );
    expect(review.slots[0].actualAmountCents).toBe(0);
  });
  it('calcula internamente a associação a outro mês e identifica colisões com a prévia', () => {
    const review = series([
      record('um', '2026-01-10'),
      record('dois', '2026-01-20'),
      record('três', '2026-02-10'),
    ]);
    let choices = editSeriesChoice(
      review,
      initialSeriesChoices(review),
      'dois',
      { originalDate: '2026-02-20' },
    );
    expect(seriesReviewError(review, choices)).toContain(
      'registro 2 (dois',
    );
    expect(seriesReviewError(review, choices)).toContain(
      'registro 3 (três',
    );
    choices = editSeriesChoice(review, choices, 'dois', {
      originalDate: '2026-03-20',
    });
    expect(choices[1].slotKey).toBe('monthly:2026-03');
    expect(seriesReviewError(review, choices)).toBeNull();
    expect(review.slots[1].currentDate).toBe('2026-01-20');
  });
  it('pede uma decisão em lote para datas incertas sem inferir identidades de vencimentos editados', () => {
    const review = series([
      record('editado', '2026-01-10', {
        originalDate: null,
        dateNeedsReview: true,
        dueDate: '2026-02-03',
      }),
      record('seguro', '2026-03-10'),
    ]);
    expect(
      seriesDecisionGroups(review).map((group) => [
        group.kind,
        group.records.length,
      ]),
    ).toEqual([['date', 1]]);
    expect(initialSeriesChoices(review)[0].originalDate).toBe(
      '2026-01-10',
    );
  });
  it('conserva ocorrências ancoradas separadamente e não inventa um predecessor', () => {
    const review = series(
      [record('um', '2026-01-10'), record('dois', '2026-02-10')],
      { frequency: 'custom', anchorToActual: true },
    );
    expect(
      seriesDecisionGroups(review).map((group) => group.kind),
    ).toEqual(['schedule']);
    const choices = keepSeriesRecords(
      review,
      initialSeriesChoices(review),
      review.slots,
    );
    expect(
      choices.every((choice) => !choice.slotKey.includes(':after:')),
    ).toBe(true);
    expect(seriesReviewError(review, choices)).toBeNull();
  });
  it('não repete os mesmos formulários para datas e posições de parcelas', () => {
    const review = series(
      [
        record('um', '2026-01-10', {
          originalDate: null,
          dateNeedsReview: true,
          installmentNumber: 3,
        }),
        record('dois', '2026-02-10', {
          originalDate: null,
          dateNeedsReview: true,
          installmentNumber: 4,
        }),
      ],
      { entityType: 'installmentPurchase', startingInstallment: 3 },
    );
    expect(
      seriesDecisionGroups(review).map((group) => group.kind),
    ).toEqual(['position']);
    expect(
      initialSeriesChoices(review).map((choice) => choice.originalIndex),
    ).toEqual([1, 2]);
    expect(
      seriesReviewError(
        review,
        editSeriesChoice(review, initialSeriesChoices(review), 'um', {
          originalIndex: 0,
        }),
      ),
    ).toContain('maior que zero');
  });
  it('deixa parcelas coerentes e datas originais comprovadas na prévia, sem exigir decisões', () => {
    const review = series(
      [
        record('um', '2026-01-10', {
          installmentNumber: 3,
          dueDate: '2026-01-20',
        }),
        record('dois', '2026-02-10', { installmentNumber: 4 }),
      ],
      { entityType: 'installmentPurchase', startingInstallment: 3 },
    );
    expect(seriesDecisionGroups(review)).toEqual([]);
    expect(
      seriesReviewError(review, initialSeriesChoices(review)),
    ).toBeNull();
  });
  it('troca a decisão de manter ambos para reassociar sem conservar separações escondidas', () => {
    const review = series([
      record('um', '2026-01-10'),
      record('dois', '2026-01-20'),
    ]);
    const group = seriesDecisionGroups(review)[0];
    expect(
      seriesDecisionOptions(review, group).map((option) => option.label),
    ).toEqual([
      'Manter ambos',
      'Associar a outro mês',
      'Excluir duplicados',
    ]);
    let choices = applySeriesDecision(
      review,
      initialSeriesChoices(review),
      group,
      'keep',
    );
    expect(seriesReviewError(review, choices)).toBeNull();
    choices = applySeriesDecision(review, choices, group, 'associate');
    expect(
      choices.every((choice) => !choice.slotKey.includes(':legacy:')),
    ).toBe(true);
    expect(seriesReviewError(review, choices)).toContain(
      'mesma associação',
    );
    choices = editSeriesChoice(review, choices, 'dois', {
      originalDate: '2026-02-20',
    });
    expect(seriesReviewError(review, choices)).toBeNull();
    choices = applySeriesDecision(review, choices, group, '');
    expect(choices[1].originalDate).toBe('2026-02-20');
  });
  it('mantém o motivo compacto mesmo com muitos grupos repetidos e rejeita registros faltantes', () => {
    const review = series(
      Array.from({ length: 60 }, (_, i) =>
        record(
          String(i),
          `${2026 + Math.floor(i / 24)}-${String((Math.floor(i / 2) % 12) + 1).padStart(2, '0')}-10`,
        ),
      ),
    );
    expect(seriesDecisionGroups(review)).toHaveLength(30);
    expect(seriesPendingReason(review).length).toBeLessThan(140);
    expect(
      seriesReviewError(review, initialSeriesChoices(review).slice(1)),
    ).toContain('Todos os registros');
  });
  it('exige escolher as exclusões, preserva identidades e limpa as marcações ao trocar a decisão', () => {
    const review = series([
      record('pago', '2026-01-10', {
        status: 'paid',
        actualAmountCents: 0,
        settledDate: '2026-01-11',
      }),
      record('duplicado', '2026-01-20'),
      record('prévia', '2026-02-10'),
    ]);
    const group = seriesDecisionGroups(review)[0];
    let choices = applySeriesDecision(
      review,
      initialSeriesChoices(review),
      group,
      'delete',
    );
    expect(choices.some((choice) => choice.deleteRecord)).toBe(false);
    expect(seriesDeletionSelectionError(group, choices)).toContain(
      'Marque',
    );
    choices = markSeriesRecordForDeletion(
      review,
      choices,
      group,
      'duplicado',
      true,
    );
    expect(seriesDeletionSelectionError(group, choices)).toBeNull();
    expect(seriesReviewError(review, choices)).toBeNull();
    expect(new Set(choices.map((choice) => choice.slotKey)).size).toBe(3);
    expect(choices.every((choice) => choice.publish)).toBe(true);
    expect(seriesDeletionSummary(review, group, choices)).toContain(
      'excluir: registro 2. Manter: registro 1',
    );
    expect(seriesPreservationSummary(review, choices)).toContain(
      '2 registros ativos mantidos · 1 registro será excluído',
    );
    expect(seriesAssociationChanges(review, choices)[0]).toContain(
      'Excluir registro 2: duplicado, 20/01/2026',
    );
    expect(
      markSeriesRecordForDeletion(review, choices, group, 'prévia', true),
    ).toEqual(choices);
    choices = markSeriesRecordForDeletion(
      review,
      choices,
      group,
      'pago',
      true,
    );
    expect(seriesDeletionSelectionError(group, choices)).toContain(
      'pelo menos um',
    );
    expect(seriesAssociationChanges(review, choices)[0]).toContain(
      'Pago · em 11/01/2026 · realizado R$',
    );
    choices = applySeriesDecision(review, choices, group, 'keep');
    expect(choices.some((choice) => choice.deleteRecord)).toBe(false);
    expect(review.slots.every((record) => !record.deletedAt)).toBe(true);
  });
});
