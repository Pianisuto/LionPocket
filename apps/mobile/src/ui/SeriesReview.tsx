import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { dateForMonthDay, isValidDate } from '@lionpocket/core';
import {
  applySeriesDecision,
  editSeriesChoice,
  initialSeriesChoices,
  markSeriesRecordForDeletion,
  reviewDateLabel,
  reviewMoney,
  seriesConfirmation,
  seriesDecisionDescription,
  seriesDecisionGroups,
  seriesDecisionOptions,
  seriesDeletionSelectionError,
  seriesDeletionSummary,
  seriesPendingReason,
  reviewStatusLabel,
  seriesReviewError,
  type LegacyReviewRecord,
  type ReviewedSlot,
  type SeriesDecisionGroup,
  type SeriesReview,
  type SeriesReviewDecision,
} from '@lionpocket/sync-local';
import {
  Button,
  Choice,
  DateField,
  Field,
  MonthField,
  Sheet,
  useStyles,
} from './components';

export function SeriesReviewForm({
  series,
  busy,
  submit,
}: {
  series: SeriesReview;
  busy: boolean;
  submit: (slots: ReviewedSlot[]) => void;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState(() =>
    initialSeriesChoices(series),
  );
  const [decisions, setDecisions] = useState<
    Record<string, SeriesReviewDecision>
  >({});
  const [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const signature = JSON.stringify(series);
  useEffect(() => {
    setChoices(initialSeriesChoices(series));
    setDecisions({});
    setEditing(null);
    setConfirming(false);
  }, [signature]);
  const groups = seriesDecisionGroups(series);
  const duplicates = groups.filter((group) => group.kind === 'duplicate');
  const involved = new Set(
    groups.flatMap((group) =>
      group.records.map((record) => record.localId),
    ),
  );
  const unambiguous = series.slots.filter(
    (record) => !involved.has(record.localId),
  );
  const error = seriesReviewError(series, choices);
  const ready =
    !error &&
    groups.every(
      (group) =>
        decisions[group.id] &&
        (decisions[group.id] !== 'delete' ||
          !seriesDeletionSelectionError(group, choices)),
    );
  const editorRecord = series.slots.find(
    (record) => record.localId === editing,
  );
  const editorChoice = choices.find(
    (choice) => choice.localId === editing,
  );
  const decide = (
    group: SeriesDecisionGroup,
    decision: SeriesReviewDecision,
  ) => {
    setChoices((old) => applySeriesDecision(series, old, group, decision));
    setDecisions((old) => ({ ...old, [group.id]: decision }));
    setConfirming(false);
  };
  const saveAssociation = (
    patch: Pick<ReviewedSlot, 'originalDate' | 'originalIndex'>,
  ) => {
    if (!editing) return;
    const group = groups.find((item) =>
      item.records.some((record) => record.localId === editing),
    );
    setChoices((old) => {
      const next = editSeriesChoice(series, old, editing, patch);
      return group?.kind === 'duplicate'
        ? applySeriesDecision(series, next, group, 'associate')
        : group && decisions[group.id] === 'keep'
          ? applySeriesDecision(series, next, group, 'keep')
          : next;
    });
    if (group?.kind === 'duplicate')
      setDecisions((old) => ({ ...old, [group.id]: 'associate' }));
    setEditing(null);
    setConfirming(false);
  };
  const recordsCards = (
    records: LegacyReviewRecord[],
    group?: SeriesDecisionGroup,
  ) =>
    records.map((record) => {
      const choice =
        choices.find((item) => item.localId === record.localId) ??
        initialSeriesChoices(series).find(
          (item) => item.localId === record.localId,
        );
      if (!choice) return null;
      const number = series.slots.indexOf(record) + 1;
      return (
        <View
          style={[styles.card, { padding: 10, gap: 4 }]}
          key={record.localId}
        >
          <Text style={styles.text}>{record.description}</Text>
          <Text style={styles.muted}>Registro {number}</Text>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <Text style={styles.muted}>
              Ocorrência{'\n'}
              {reviewDateLabel(record.currentDate)}
            </Text>
            <Text style={styles.muted}>
              Vencimento{'\n'}
              {reviewDateLabel(record.dueDate)}
            </Text>
          </View>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <Text style={styles.text}>
              Previsto{'\n'}
              {reviewMoney(record.plannedAmountCents)}
            </Text>
            {record.actualAmountCents !== null && (
              <Text style={styles.text}>
                Realizado{'\n'}
                {reviewMoney(record.actualAmountCents)}
              </Text>
            )}
          </View>
          <Text style={styles.muted}>
            {reviewStatusLabel(record.status)}
          </Text>
          {record.settledDate && (
            <Text style={styles.muted}>
              Pagamento em {reviewDateLabel(record.settledDate)}
            </Text>
          )}
          {record.deletedAt && <Text style={styles.muted}>Excluído</Text>}
          <Text style={styles.muted}>
            Associação: {reviewDateLabel(choice.originalDate)}
          </Text>
          {series.entityType === 'installmentPurchase' && (
            <Text style={styles.muted}>
              Posição: {choice.originalIndex ?? '—'}
            </Text>
          )}
          {choice.slotKey.includes(':legacy:') && (
            <Text style={styles.muted}>
              {choice.deleteRecord
                ? 'Será excluído ao confirmar'
                : 'Preservado separadamente'}
            </Text>
          )}
          {group && decisions[group.id] === 'delete' ? (
            record.deletedAt ? (
              <Text style={styles.muted}>Já excluído</Text>
            ) : (
              <View pointerEvents={busy ? 'none' : 'auto'}>
                <Choice
                  label={`Destino do registro ${number}`}
                  value={choice.deleteRecord ? 'delete' : 'keep'}
                  options={[
                    { value: 'keep', label: 'Manter registro' },
                    { value: 'delete', label: 'Excluir na confirmação' },
                  ]}
                  onChange={(value) =>
                    setChoices((old) =>
                      markSeriesRecordForDeletion(
                        series,
                        old,
                        group,
                        record.localId,
                        value === 'delete',
                      ),
                    )
                  }
                />
              </View>
            )
          ) : (
            <Button
              compact
              label={`Editar associação do registro ${number}`}
              disabled={busy}
              onPress={() => setEditing(record.localId)}
            />
          )}
        </View>
      );
    });
  return (
    <View style={[styles.card, { padding: 12, gap: 6 }]}>
      <Text style={styles.heading}>{series.description}</Text>
      <Text style={styles.muted}>{series.slots.length} ocorrências</Text>
      <Text style={styles.muted}>{seriesPendingReason(series)}</Text>
      <Button
        compact
        label={open ? 'Recolher revisão' : 'Revisar'}
        disabled={busy}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <View style={{ gap: 16 }}>
          {!confirming ? (
            <>
              {duplicates.length > 1 && (
                <View pointerEvents={busy ? 'none' : 'auto'}>
                  <Choice
                    label={`Decisão em lote para ${duplicates.reduce((count, group) => count + group.records.length, 0)} registros em ${duplicates.length} grupos`}
                    value={
                      duplicates.every(
                        (group) => decisions[group.id] === 'keep',
                      )
                        ? 'keep'
                        : ''
                    }
                    options={[
                      { value: '', label: 'Decidir cada grupo' },
                      { value: 'keep', label: 'Manter todos separados' },
                    ]}
                    onChange={(value) => {
                      const decision = value as SeriesReviewDecision;
                      setChoices((old) =>
                        duplicates.reduce(
                          (next, group) =>
                            applySeriesDecision(
                              series,
                              next,
                              group,
                              decision,
                            ),
                          old,
                        ),
                      );
                      setDecisions((old) => ({
                        ...old,
                        ...Object.fromEntries(
                          duplicates.map((group) => [group.id, decision]),
                        ),
                      }));
                    }}
                  />
                </View>
              )}
              {groups.map((group) => (
                <View key={group.id} style={{ gap: 8 }}>
                  <Text style={styles.heading}>{group.title}</Text>
                  <Text style={styles.text}>{group.explanation}</Text>
                  {recordsCards(group.records, group)}
                  <View pointerEvents={busy ? 'none' : 'auto'}>
                    <Choice
                      label={`Decisão para este grupo (${group.records.length} registros)`}
                      value={decisions[group.id] ?? ''}
                      options={[
                        { value: '', label: 'Selecione uma decisão' },
                        ...seriesDecisionOptions(series, group),
                      ]}
                      onChange={(value) =>
                        decide(group, value as SeriesReviewDecision)
                      }
                    />
                  </View>
                  <Text style={styles.muted}>
                    {seriesDecisionDescription(
                      group,
                      decisions[group.id] ?? '',
                    )}
                  </Text>
                  {decisions[group.id] === 'delete' && (
                    <>
                      <Text style={styles.text}>
                        {seriesDeletionSummary(series, group, choices)}
                      </Text>
                      {seriesDeletionSelectionError(group, choices) && (
                        <Text style={styles.muted}>
                          {seriesDeletionSelectionError(group, choices)}
                        </Text>
                      )}
                    </>
                  )}
                </View>
              ))}
              {!!unambiguous.length && (
                <View>
                  <Button
                    compact
                    label={
                      preview
                        ? 'Recolher prévia'
                        : `Prévia: ${unambiguous.length} ocorrências sem ambiguidade`
                    }
                    onPress={() => setPreview(!preview)}
                  />
                  {preview && recordsCards(unambiguous)}
                </View>
              )}
              {error && Object.values(decisions).some(Boolean) && (
                <Text style={styles.error} accessibilityRole="alert">
                  {error}
                </Text>
              )}
              <View style={{ gap: 8 }}>
                <Text style={styles.muted}>
                  {ready
                    ? 'Decisões preparadas. Confira o resumo antes de confirmar.'
                    : 'Selecione as decisões dos grupos acima para continuar.'}
                </Text>
                <Button
                  tone="primary"
                  label="Conferir resumo da série"
                  disabled={busy || !ready}
                  onPress={() => setConfirming(true)}
                />
              </View>
            </>
          ) : (
            <View style={{ gap: 12 }}>
              <SeriesReviewSummary
                series={series}
                choices={choices}
                decisions={decisions}
              />
              <View style={{ gap: 8 }}>
                <Button
                  label="Voltar à revisão"
                  disabled={busy}
                  onPress={() => setConfirming(false)}
                />
                <Button
                  label="Confirmar e liberar série"
                  tone="primary"
                  disabled={busy || !ready}
                  onPress={() => submit(choices)}
                />
              </View>
            </View>
          )}
        </View>
      )}
      {editorRecord && editorChoice && (
        <SeriesAssociationEditor
          key={editorRecord.localId}
          series={series}
          record={editorRecord}
          choice={editorChoice}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={saveAssociation}
        />
      )}
    </View>
  );
}

export function SeriesReviewSummary({
  series,
  choices,
  decisions,
}: {
  series: SeriesReview;
  choices: ReviewedSlot[];
  decisions: Record<string, SeriesReviewDecision>;
}) {
  const styles = useStyles();
  const summary = seriesConfirmation(series, choices, decisions);
  const field = (label: string, value: string) => (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.text, { flexShrink: 1, textAlign: 'right' }]}>
        {value}
      </Text>
    </View>
  );
  return (
    <View style={{ gap: 16 }}>
      <Text style={styles.heading}>Resumo da revisão</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {summary.statistics.map((stat) => (
          <View
            key={stat.label}
            style={[
              styles.card,
              { flexBasis: '47%', flexGrow: 1, padding: 12, gap: 4 },
            ]}
          >
            <Text style={[styles.heading, { fontSize: 24 }]}>
              {stat.value}
            </Text>
            <Text style={styles.muted}>{stat.label}</Text>
          </View>
        ))}
      </View>
      <View style={{ gap: 8 }}>
        <Text style={styles.heading}>Decisões da série</Text>
        {summary.decisions.map((decision) => (
          <View
            key={decision.id}
            style={[styles.card, { padding: 12, gap: 6 }]}
          >
            <Text style={styles.text}>{decision.groupLabel}</Text>
            {field('Decisão', decision.decisionLabel)}
            {field('Registros', String(decision.recordCount))}
          </View>
        ))}
      </View>
      {!!summary.records.length && (
        <View style={{ gap: 8 }}>
          <Text style={styles.heading}>Registros envolvidos</Text>
          {summary.records.map(
            ({
              record,
              number,
              actionLabel,
              choice,
              before,
              associationChanged,
            }) => (
              <View
                key={record.localId}
                style={[styles.card, { padding: 12, gap: 8 }]}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <Text style={styles.heading}>{record.description}</Text>
                  <Text style={styles.heading}>{actionLabel}</Text>
                </View>
                <Text style={styles.muted}>Registro {number}</Text>
                {field('Ocorrência', reviewDateLabel(record.currentDate))}
                {field('Vencimento', reviewDateLabel(record.dueDate))}
                {field('Previsto', reviewMoney(record.plannedAmountCents))}
                {record.actualAmountCents !== null &&
                  field(
                    'Realizado',
                    reviewMoney(record.actualAmountCents),
                  )}
                {field('Estado', reviewStatusLabel(record.status))}
                {record.settledDate &&
                  field('Pagamento', reviewDateLabel(record.settledDate))}
                {associationChanged && (
                  <>
                    {field(
                      'Associação anterior',
                      reviewDateLabel(before.originalDate),
                    )}
                    {before.originalIndex !== null &&
                      field(
                        'Posição anterior',
                        String(before.originalIndex),
                      )}
                    {field(
                      'Nova associação',
                      reviewDateLabel(choice.originalDate),
                    )}
                    {choice.originalIndex !== null &&
                      field('Nova posição', String(choice.originalIndex))}
                  </>
                )}
              </View>
            ),
          )}
        </View>
      )}
      <View style={{ gap: 8 }}>
        {summary.hasDeletions && (
          <Text style={styles.muted}>
            Somente os registros marcados para excluir sairão dos
            lançamentos e totais. As exclusões serão sincronizadas.
          </Text>
        )}
        <Text style={styles.muted}>
          O histórico, valores, vencimentos, pagamentos e vínculos
          permanecem armazenados.
        </Text>
      </View>
    </View>
  );
}

export function SeriesAssociationEditor({
  series,
  record,
  choice,
  busy,
  onClose,
  onSave,
}: {
  series: SeriesReview;
  record: LegacyReviewRecord;
  choice: ReviewedSlot;
  busy: boolean;
  onClose: () => void;
  onSave: (
    patch: Pick<ReviewedSlot, 'originalDate' | 'originalIndex'>,
  ) => void;
}) {
  const styles = useStyles();
  const [date, setDate] = useState(choice.originalDate);
  const [index, setIndex] = useState(
    choice.originalIndex === null ? '' : String(choice.originalIndex),
  );
  const monthly =
    series.entityType === 'recurring' &&
    ['monthly', 'manual'].includes(series.frequency);
  const valid =
    isValidDate(date) &&
    (series.entityType !== 'installmentPurchase' ||
      (Number.isSafeInteger(Number(index)) && Number(index) > 0));
  return (
    <Sheet
      title="Editar associação"
      onClose={onClose}
      disabled={busy}
      footer={
        <View style={{ gap: 8 }}>
          <Button label="Cancelar" disabled={busy} onPress={onClose} />
          <Button
            tone="primary"
            label="Salvar associação"
            disabled={busy || !valid}
            onPress={() =>
              onSave({
                originalDate: date,
                originalIndex:
                  series.entityType === 'installmentPurchase'
                    ? Number(index)
                    : null,
              })
            }
          />
        </View>
      }
    >
      <Text style={styles.heading}>{record.description}</Text>
      <View style={{ gap: 4 }}>
        <Text style={styles.muted}>
          Ocorrência: {reviewDateLabel(record.currentDate)}
        </Text>
        <Text style={styles.muted}>
          Previsto: {reviewMoney(record.plannedAmountCents)}
        </Text>
        <Text style={styles.muted}>
          Estado: {reviewStatusLabel(record.status)}
        </Text>
        {record.deletedAt && <Text style={styles.muted}>Excluído</Text>}
      </View>
      <View pointerEvents={busy ? 'none' : 'auto'}>
        {monthly ? (
          <MonthField
            label="Mês original"
            value={date.slice(0, 7)}
            onChange={(month) =>
              setDate(
                dateForMonthDay(month, Number(date.slice(8, 10)) || 1),
              )
            }
          />
        ) : (
          <DateField
            label="Data original"
            value={date}
            onChange={setDate}
          />
        )}
        {series.entityType === 'installmentPurchase' && (
          <Field
            label="Posição original"
            numeric
            value={index}
            onChange={setIndex}
          />
        )}
      </View>
      <Text style={styles.muted}>
        Altera somente a associação nesta revisão. Valores, vencimentos,
        pagamentos e vínculos permanecem como estão.
      </Text>
    </Sheet>
  );
}
