import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { SeriesReview } from '@lionpocket/sync-local';
vi.mock('react-native', () => ({
  Text: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TextInput: () => <input />,
}));
vi.mock('./components', () => ({
  useStyles: () => ({}),
  Button: ({ label }: { label: string }) => <button>{label}</button>,
}));
import { SeriesReviewForm } from './SeriesReview';
it('mostra cinco cartões Android recolhidos sem 127 edições ou confirmações', () => {
  const items = [26, 26, 25, 25, 25].map((count, n): SeriesReview => ({
    entityType: 'recurring',
    localId: String(n),
    description: `Série ${n}`,
    frequency: 'monthly',
    scheduleEpoch: 'epoch',
    startingInstallment: 1,
    anchorToActual: false,
    autoResolvable: false,
    autoReason: 'Mês repetido',
    suggestedSlots: [],
    slots: Array.from({ length: count }, (_, i) => ({
      localId: `${n}-${i}`,
      description: 'Registro antigo',
      status: 'paid',
      currentDate: '2026-01-10',
      dueDate: '2026-01-10',
      originalDate: '2026-01-10',
      dateNeedsReview: false,
      installmentNumber: null,
      plannedAmountCents: 10000,
      actualAmountCents: 9000,
      settledDate: '2026-01-11',
      deletedAt: null,
    })),
  }));
  const html = renderToStaticMarkup(
    <>
      {items.map((series) => (
        <SeriesReviewForm
          key={series.localId}
          series={series}
          busy={false}
          submit={() => undefined}
        />
      ))}
    </>,
  );
  expect(html.match(/>Revisar<\/button>/g)).toHaveLength(5);
  expect(html).not.toContain('<input');
  expect(html).not.toContain('Editar registro');
  expect(html).not.toContain('Confirmar e liberar');
  expect(html).not.toContain('monthly:');
});
