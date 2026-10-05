import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SeriesReview } from '@lionpocket/sync-local';
import { SeriesReviewForm } from './SeriesReview';

describe('revisão compacta no desktop', () => {
  it('exibe cinco itens e nenhum formulário ao carregar 127 ocorrências', () => {
    const series = [26, 26, 25, 25, 25].map((count, index): SeriesReview => ({
      entityType: 'recurring',
      localId: String(index),
      description: `Série ${index + 1}`,
      frequency: 'monthly',
      scheduleEpoch: 'epoch',
      startingInstallment: 1,
      anchorToActual: false,
      autoResolvable: false,
      autoReason: 'Posição repetida',
      suggestedSlots: [],
      slots: Array.from({ length: count }, (_, i) => ({
        localId: `${index}-${i}`,
        description: 'Lançamento',
        status: 'planned',
        currentDate: '2026-01-10',
        dueDate: '2026-01-10',
        originalDate: '2026-01-10',
        dateNeedsReview: false,
        installmentNumber: null,
        plannedAmountCents: 10000,
        actualAmountCents: null,
        settledDate: null,
        deletedAt: null,
      })),
    }));
    const html = renderToStaticMarkup(
      <>
        {series.map((item) => (
          <SeriesReviewForm
            key={item.localId}
            series={item}
            busy={false}
            submit={async () => undefined}
          />
        ))}
      </>,
    );
    expect(html.match(/>Revisar<\/button>/g)).toHaveLength(5);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('monthly:');
    expect(html).toContain('associados a janeiro');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(5);
  });
});
