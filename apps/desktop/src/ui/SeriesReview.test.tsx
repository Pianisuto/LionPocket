import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SeriesReview } from '@lionpocket/sync-local';
import { SeriesAssociationEditor, SeriesReviewForm } from './SeriesReview';

describe('revisão compacta no desktop', () => {
  it('edita a associação em um modal com o seletor de mês e as ações do app', () => {
    const record = {
      localId: 'registro',
      description: 'Conta antiga',
      status: 'paid',
      currentDate: '2026-01-10',
      dueDate: '2026-01-20',
      originalDate: '2026-01-10',
      dateNeedsReview: false,
      installmentNumber: null,
      plannedAmountCents: 10000,
      actualAmountCents: 9500,
      settledDate: '2026-01-21',
      deletedAt: null,
    };
    const series: SeriesReview = {
      entityType: 'recurring',
      localId: 'serie',
      description: 'Conta',
      frequency: 'monthly',
      scheduleEpoch: 'epoch',
      startingInstallment: 1,
      anchorToActual: false,
      autoResolvable: false,
      autoReason: 'Mês repetido',
      suggestedSlots: [],
      slots: [record],
    };
    const html = renderToStaticMarkup(
      <SeriesAssociationEditor
        series={series}
        record={record}
        choice={{
          localId: record.localId,
          originalDate: '2026-01-10',
          originalIndex: null,
          slotKey: 'monthly:2026-01',
          publish: true,
        }}
        busy={false}
        onClose={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Mês original');
    expect(html).toContain('modal__actions');
    expect(html).toContain('Cancelar');
    expect(html).toContain('Salvar associação');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('type="date"');
  });

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
