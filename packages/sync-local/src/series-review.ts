import { isValidDate } from '@lionpocket/core';
import type { ReviewedSlot } from './financial';

export interface LegacySeriesReview {
  entityType: 'recurring' | 'installmentPurchase';
  localId: string;
  description: string;
  frequency: string;
  scheduleEpoch: string;
  startingInstallment: number;
  anchorToActual: boolean;
  slots: LegacyReviewRecord[];
}
export interface LegacyReviewRecord {
  localId: string;
  description: string;
  status: string;
  currentDate: string;
  dueDate: string;
  originalDate: string | null;
  dateNeedsReview: boolean;
  positionNeedsReview?: boolean;
  installmentNumber: number | null;
  plannedAmountCents: number;
  actualAmountCents: number | null;
  settledDate: string | null;
  deletedAt: string | null;
}
export interface SeriesDecisionGroup {
  id: string;
  kind: 'duplicate' | 'date' | 'position' | 'schedule';
  title: string;
  explanation: string;
  records: LegacyReviewRecord[];
}
const months = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
export const reviewDateLabel = (date: string) =>
  date.split('-').reverse().join('/');
export const reviewMoney = (cents: number) =>
  new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
export function reviewStateLabel(record: LegacyReviewRecord): string {
  const status =
    (
      {
        planned: 'Planejado',
        paid: 'Pago',
        received: 'Recebido',
        cancelled: 'Cancelado',
      } as Record<string, string>
    )[record.status] ?? record.status;
  return [
    status,
    record.settledDate && `em ${reviewDateLabel(record.settledDate)}`,
    record.deletedAt && 'Excluído',
  ]
    .filter(Boolean)
    .join(' · ');
}
const dateOf = (record: LegacyReviewRecord) =>
  record.originalDate ?? record.currentDate;
function positionKey(
  series: LegacySeriesReview,
  date: string,
  index: number | null,
): string {
  if (series.entityType === 'installmentPurchase')
    return `position:${index}`;
  if (series.frequency === 'monthly') return `monthly:${date.slice(0, 7)}`;
  if (series.frequency === 'manual')
    return `manual:${series.scheduleEpoch}:${date.slice(0, 7)}`;
  return `${series.scheduleEpoch}:${date}`;
}
export function initialSeriesChoices(
  series: LegacySeriesReview,
): ReviewedSlot[] {
  return series.slots.map((record) => {
    const originalDate = dateOf(record);
    const originalIndex =
      series.entityType === 'installmentPurchase' &&
      record.installmentNumber !== null
        ? record.installmentNumber - series.startingInstallment + 1
        : null;
    return {
      localId: record.localId,
      originalDate,
      originalIndex,
      slotKey: positionKey(series, originalDate, originalIndex),
      publish: true,
    };
  });
}
export function seriesDecisionGroups(
  series: LegacySeriesReview,
): SeriesDecisionGroup[] {
  const groups: SeriesDecisionGroup[] = [];
  const positions = new Map<string, LegacyReviewRecord[]>();
  const choices = initialSeriesChoices(series);
  for (const [i, record] of series.slots.entries()) {
    if (
      !isValidDate(choices[i].originalDate) ||
      (series.entityType === 'installmentPurchase' &&
        (!Number.isSafeInteger(choices[i].originalIndex) ||
          Number(choices[i].originalIndex) < 1))
    )
      continue;
    const key = choices[i].slotKey;
    positions.set(key, [...(positions.get(key) ?? []), record]);
  }
  const repeated = new Set<string>();
  for (const [key, records] of positions) {
    if (records.length < 2) continue;
    records.forEach((record) => repeated.add(record.localId));
    const date = dateOf(records[0]);
    const position =
      series.entityType === 'installmentPurchase'
        ? `à parcela ${records[0].installmentNumber ?? 'sem número'}`
        : ['monthly', 'manual'].includes(series.frequency)
          ? `a ${months[Number(date.slice(5, 7)) - 1] ?? 'um mês desconhecido'} de ${date.slice(0, 4)}`
          : `à data ${reviewDateLabel(date)}`;
    groups.push({
      id: `duplicate:${key}`,
      kind: 'duplicate',
      title: `Existem ${records.length} lançamentos associados ${position}.`,
      explanation:
        'Confira as datas, valores e pagamentos: a posição repetida pode ser uma associação incorreta ou um lançamento duplicado. Manter ambos conserva os registros separados; associar a outra posição corrige somente a associação. Se for uma duplicação real, escolha Excluir duplicados e marque exatamente quais registros excluir.',
      records,
    });
  }
  const uncertainDates = series.slots.filter(
    (record) =>
      !repeated.has(record.localId) &&
      (record.dateNeedsReview || !isValidDate(dateOf(record))),
  );
  if (
    uncertainDates.length &&
    series.entityType === 'recurring' &&
    !series.anchorToActual
  )
    groups.push({
      id: 'dates',
      kind: 'date',
      title: `${uncertainDates.length} registros sem data original comprovada.`,
      explanation:
        'O histórico não comprova a data original desses registros. Confira as datas exibidas; você pode usá-las em lote ou corrigir somente os registros necessários. O vencimento e os pagamentos serão preservados.',
      records: uncertainDates,
    });
  if (series.entityType === 'installmentPurchase') {
    const records = series.slots.filter((record) => {
      const index = choices.find(
        (choice) => choice.localId === record.localId,
      )?.originalIndex;
      return (
        !repeated.has(record.localId) &&
        (record.dateNeedsReview ||
          record.positionNeedsReview ||
          !isValidDate(dateOf(record)) ||
          !Number.isSafeInteger(index) ||
          Number(index) < 1)
      );
    });
    if (records.length)
      groups.push({
        id: 'positions',
        kind: 'position',
        title: `Conferir a posição de ${records.length} parcelas antigas.`,
        explanation:
          'O número atual pode ter sido renumerado e a data original pode não estar comprovada. Confira as datas e posições exibidas. Usar as posições exibidas mantém a numeração atual; corrigir a posição altera somente a associação original da parcela.',
        records,
      });
  } else if (series.anchorToActual) {
    const records = series.slots.filter(
      (record) => !repeated.has(record.localId),
    );
    if (records.length)
      groups.push({
        id: 'schedule',
        kind: 'schedule',
        title: `${records.length} registros de uma série baseada em pagamentos.`,
        explanation:
          'O histórico não comprova qual pagamento originou cada ocorrência. Conservar separadamente mantém esses registros com identidades próprias, sem inventar um vínculo com outro pagamento.',
        records,
      });
  }
  return groups;
}
export function seriesPendingReason(series: LegacySeriesReview): string {
  const groups = seriesDecisionGroups(series);
  const duplicates = groups.filter((group) => group.kind === 'duplicate');
  const reasons = groups
    .filter((group) => group.kind !== 'duplicate')
    .map((group) => group.title);
  if (duplicates.length)
    reasons.unshift(
      duplicates.length === 1
        ? duplicates[0].title
        : `${duplicates.length} posições repetidas. Exemplo: ${duplicates[0].title}`,
    );
  return reasons.length
    ? reasons.join(' ')
    : 'Associações sem conflito; falta confirmar a preservação da série.';
}
export function keepSeriesRecords(
  series: LegacySeriesReview,
  choices: ReviewedSlot[],
  records: LegacyReviewRecord[],
): ReviewedSlot[] {
  const ids = new Set(records.map((record) => record.localId));
  return choices.map((choice) =>
    ids.has(choice.localId)
      ? {
          ...choice,
          slotKey: `${positionKey(series, choice.originalDate, choice.originalIndex)}:legacy:${encodeURIComponent(choice.localId)}`,
        }
      : choice,
  );
}
export function editSeriesChoice(
  series: LegacySeriesReview,
  choices: ReviewedSlot[],
  localId: string,
  patch: Pick<Partial<ReviewedSlot>, 'originalDate' | 'originalIndex'>,
): ReviewedSlot[] {
  return choices.map((choice) => {
    if (choice.localId !== localId) return choice;
    const next = { ...choice, ...patch };
    return {
      ...next,
      slotKey: positionKey(series, next.originalDate, next.originalIndex),
    };
  });
}
export function seriesReviewError(
  series: LegacySeriesReview,
  choices: ReviewedSlot[],
): string | null {
  if (
    choices.length !== series.slots.length ||
    new Set(choices.map((choice) => choice.localId)).size !==
      choices.length ||
    choices.some(
      (choice) =>
        !series.slots.some((record) => record.localId === choice.localId),
    )
  )
    return 'Todos os registros da série devem ser preservados.';
  if (choices.some((choice) => !isValidDate(choice.originalDate)))
    return 'Informe uma data válida nos registros indicados.';
  if (
    series.entityType === 'installmentPurchase' &&
    choices.some(
      (choice) =>
        !Number.isSafeInteger(choice.originalIndex) ||
        Number(choice.originalIndex) < 1,
    )
  )
    return 'Informe uma posição de parcela maior que zero.';
  const collision = choices.find((choice) =>
    choices.some(
      (other) =>
        other.localId !== choice.localId &&
        other.slotKey === choice.slotKey,
    ),
  );
  if (collision) {
    const records = choices
      .filter((choice) => choice.slotKey === collision.slotKey)
      .map((choice) => {
        const record = series.slots.find(
          (item) => item.localId === choice.localId,
        )!;
        return `registro ${series.slots.indexOf(record) + 1} (${record.description}, ${reviewDateLabel(record.currentDate)}, ${reviewMoney(record.plannedAmountCents)})`;
      });
    return `A mesma associação está sendo usada por: ${records.join('; ')}. Mantenha ambos ou corrija a associação.`;
  }
  return null;
}
export function seriesPreservationSummary(
  series: LegacySeriesReview,
  choices: ReviewedSlot[] = [],
): string {
  const paid = series.slots.filter((record) =>
    ['paid', 'received'].includes(record.status),
  ).length;
  const deleted = series.slots.filter((record) => record.deletedAt).length;
  const marked = series.slots.filter(
    (record) =>
      !record.deletedAt &&
      choices.some(
        (choice) =>
          choice.localId === record.localId && choice.deleteRecord,
      ),
  );
  if (marked.length)
    return `${series.slots.length - deleted - marked.length} registros ativos mantidos · ${marked.length} ${marked.length === 1 ? 'registro será excluído' : 'registros serão excluídos'} · ${deleted} já excluídos. A exclusão retira os registros selecionados dos lançamentos e totais. O histórico, valores, pagamentos e vínculos permanecem armazenados; as exclusões serão sincronizadas.`;
  return `${series.slots.length} registros preservados · ${paid} pagos ou recebidos · ${deleted} excluídos. Valores, datas de vencimento, pagamentos e vínculos serão mantidos. As exclusões continuam excluídas.`;
}

export function seriesAssociationChanges(
  series: LegacySeriesReview,
  choices: ReviewedSlot[],
): string[] {
  const initial = initialSeriesChoices(series);
  return choices.flatMap((choice) => {
    const before = initial.find((item) => item.localId === choice.localId);
    const record = series.slots.find(
      (item) => item.localId === choice.localId,
    );
    if (!before || !record) return [];
    const number = series.slots.indexOf(record) + 1;
    if (choice.deleteRecord && !record.deletedAt)
      return [
        `Excluir registro ${number}: ${record.description}, ${reviewDateLabel(record.currentDate)}, ${reviewMoney(record.plannedAmountCents)} · ${reviewStateLabel(record)}${record.actualAmountCents !== null ? ` · realizado ${reviewMoney(record.actualAmountCents)}` : ''}.`,
      ];
    if (
      before.originalDate === choice.originalDate &&
      before.originalIndex === choice.originalIndex
    )
      return [];
    const position =
      series.entityType === 'installmentPurchase'
        ? ` · posição ${before.originalIndex ?? '—'} → ${choice.originalIndex ?? '—'}`
        : '';
    return [
      `Registro ${number}: ${reviewDateLabel(before.originalDate)} → ${reviewDateLabel(choice.originalDate)}${position}`,
    ];
  });
}

export type SeriesReviewDecision =
  '' | 'keep' | 'associate' | 'current' | 'delete';
export function seriesDecisionOptions(
  series: LegacySeriesReview,
  group: SeriesDecisionGroup,
): { value: SeriesReviewDecision; label: string }[] {
  if (group.kind === 'duplicate')
    return [
      {
        value: 'keep',
        label:
          group.records.length === 2
            ? 'Manter ambos'
            : 'Manter todos separados',
      },
      {
        value: 'associate',
        label:
          series.entityType === 'installmentPurchase'
            ? 'Associar a outra parcela'
            : ['monthly', 'manual'].includes(series.frequency)
              ? 'Associar a outro mês'
              : 'Associar a outra data',
      },
      ...(group.records.filter((record) => !record.deletedAt).length > 1
        ? [{ value: 'delete' as const, label: 'Excluir duplicados' }]
        : []),
    ];
  if (group.kind === 'schedule')
    return [{ value: 'keep', label: 'Preservar separadamente' }];
  return [
    {
      value: 'current',
      label:
        group.kind === 'position'
          ? 'Usar posições e datas exibidas'
          : 'Usar datas exibidas',
    },
  ];
}
export function applySeriesDecision(
  series: LegacySeriesReview,
  choices: ReviewedSlot[],
  group: SeriesDecisionGroup,
  decision: SeriesReviewDecision,
): ReviewedSlot[] {
  const ids = new Set(group.records.map((record) => record.localId));
  const next = choices.map((choice) =>
    ids.has(choice.localId)
      ? {
          ...choice,
          deleteRecord: false,
          slotKey: positionKey(
            series,
            choice.originalDate,
            choice.originalIndex,
          ),
        }
      : choice,
  );
  return decision === 'keep' || decision === 'delete'
    ? keepSeriesRecords(series, next, group.records)
    : next;
}
export function markSeriesRecordForDeletion(
  series: LegacySeriesReview,
  choices: ReviewedSlot[],
  group: SeriesDecisionGroup,
  localId: string,
  deleted: boolean,
): ReviewedSlot[] {
  if (
    group.kind !== 'duplicate' ||
    !group.records.some(
      (record) => record.localId === localId && !record.deletedAt,
    )
  )
    return choices;
  return keepSeriesRecords(
    series,
    choices.map((choice) =>
      choice.localId === localId
        ? { ...choice, deleteRecord: deleted }
        : choice,
    ),
    group.records,
  );
}
export function seriesDeletionSelectionError(
  group: SeriesDecisionGroup,
  choices: ReviewedSlot[],
): string | null {
  const active = group.records.filter((record) => !record.deletedAt);
  const selected = active.filter((record) =>
    choices.some(
      (choice) => choice.localId === record.localId && choice.deleteRecord,
    ),
  );
  if (!selected.length)
    return 'Marque quais registros duplicados excluir. Nenhum está selecionado automaticamente.';
  if (selected.length === active.length)
    return 'Mantenha pelo menos um dos registros deste grupo.';
  return null;
}
export function seriesDeletionSummary(
  series: LegacySeriesReview,
  group: SeriesDecisionGroup,
  choices: ReviewedSlot[],
): string {
  const active = group.records.filter((record) => !record.deletedAt);
  const selected = active.filter((record) =>
    choices.some(
      (choice) => choice.localId === record.localId && choice.deleteRecord,
    ),
  );
  const retained = active.filter((record) => !selected.includes(record));
  const labels = (records: LegacyReviewRecord[]) =>
    records
      .map((record) => `registro ${series.slots.indexOf(record) + 1}`)
      .join(', ');
  return `${selected.length} ${selected.length === 1 ? 'selecionado' : 'selecionados'} para excluir${selected.length ? `: ${labels(selected)}` : ''}. Manter: ${labels(retained)}.`;
}
export function seriesDecisionDescription(
  group: SeriesDecisionGroup,
  decision: SeriesReviewDecision,
): string {
  const count = group.records.length;
  if (decision === 'keep')
    return `Os ${count} registros serão preservados separadamente, nas associações exibidas, com identidades próprias.`;
  if (decision === 'associate')
    return 'Abra a edição do registro que deseja reassociar. A nova associação entra na revisão ao escolher Salvar associação; valores, vencimentos e pagamentos permanecem como estão.';
  if (decision === 'current')
    return `As associações exibidas serão usadas nos ${count} registros. Se precisar ajustar alguma, abra a edição desse registro.`;
  if (decision === 'delete')
    return 'Marque os registros duplicados que deseja excluir. Eles sairão dos lançamentos e totais após a confirmação da série. O histórico, pagamentos e vínculos permanecerão armazenados; os demais registros serão mantidos.';
  return `Escolha como resolver este grupo de ${count} registros.`;
}
