import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import {
  editSeriesChoice,
  initialSeriesChoices,
  keepSeriesRecords,
  reviewDateLabel,
  reviewMoney,
  reviewStateLabel,
  seriesAssociationChanges,
  seriesDecisionGroups,
  seriesPendingReason,
  seriesPreservationSummary,
  seriesReviewError,
  type LegacyReviewRecord,
  type ReviewedSlot,
  type SeriesReview,
} from '@lionpocket/sync-local';
import { Button, useStyles } from './components';

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
  const [choices, setChoices] = useState(() => initialSeriesChoices(series));
  const [decisions, setDecisions] = useState<Record<string, string>>({});
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
  const duplicateRecords = duplicates.flatMap((group) => group.records);
  const involved = new Set(
    groups.flatMap((group) => group.records.map((record) => record.localId)),
  );
  const unambiguous = series.slots.filter(
    (record) => !involved.has(record.localId),
  );
  const error = seriesReviewError(series, choices);
  const associationChanges = seriesAssociationChanges(series, choices);
  const ready = !error && groups.every((group) => decisions[group.id]);
  const decide = (id: string, label: string) => {
    setDecisions((old) => ({ ...old, [id]: label }));
    setConfirming(false);
  };
  const change = (
    localId: string,
    patch: Pick<Partial<ReviewedSlot>, 'originalDate' | 'originalIndex'>,
  ) => {
    setChoices((old) => editSeriesChoice(series, old, localId, patch));
    setDecisions((old) =>
      Object.fromEntries(
        Object.entries(old).filter(
          ([id]) =>
            !groups
              .find((group) => group.id === id)
              ?.records.some((record) => record.localId === localId),
        ),
      ),
    );
    setConfirming(false);
  };
  const recordsCards = (records: LegacyReviewRecord[]) =>
    records.map((record) => {
      const choice =
        choices.find((item) => item.localId === record.localId) ??
        initialSeriesChoices(series).find(
          (item) => item.localId === record.localId,
        )!;
      const number = series.slots.indexOf(record) + 1;
      return (
        <View
          style={[styles.card, { padding: 10, gap: 4 }]}
          key={record.localId}
        >
          <Text style={styles.text}>
            Registro {number} · {record.description}
          </Text>
          <Text style={styles.muted}>
            {reviewDateLabel(record.currentDate)} · vence{' '}
            {reviewDateLabel(record.dueDate)}
          </Text>
          <Text style={styles.text}>
            {reviewMoney(record.plannedAmountCents)}
            {record.actualAmountCents !== null
              ? ` · realizado ${reviewMoney(record.actualAmountCents)}`
              : ''}
          </Text>
          <Text style={styles.muted}>{reviewStateLabel(record)}</Text>
          <Text style={styles.muted}>
            Associação: {reviewDateLabel(choice.originalDate)}
            {series.entityType === 'installmentPurchase'
              ? ` · posição ${choice.originalIndex ?? '—'}`
              : ''}
            {choice.slotKey.includes(':legacy:')
              ? ' · identidade separada'
              : ''}
          </Text>
          <Button
            compact
            disabled={busy}
            label={
              editing === record.localId
                ? 'Fechar edição'
                : `Editar registro ${number}`
            }
            onPress={() =>
              setEditing(editing === record.localId ? null : record.localId)
            }
          />
          {editing === record.localId && (
            <>
              <Text style={styles.text}>Data original / mês de associação</Text>
              <TextInput
                style={styles.input}
                accessibilityLabel={`Data original do registro ${number}`}
                placeholder="AAAA-MM-DD"
                value={choice.originalDate}
                editable={!busy}
                onChangeText={(value) =>
                  change(record.localId, { originalDate: value })
                }
              />
              {series.entityType === 'installmentPurchase' && (
                <>
                  <Text style={styles.text}>Posição original</Text>
                  <TextInput
                    style={styles.input}
                    accessibilityLabel={`Posição original do registro ${number}`}
                    keyboardType="number-pad"
                    value={
                      choice.originalIndex === null
                        ? ''
                        : String(choice.originalIndex)
                    }
                    editable={!busy}
                    onChangeText={(value) =>
                      change(record.localId, { originalIndex: Number(value) })
                    }
                  />
                </>
              )}
              <Text style={styles.muted}>
                Altera somente a associação; o lançamento e seu pagamento
                permanecem como estão.
              </Text>
            </>
          )}
        </View>
      );
    });
  return (
    <View style={[styles.card, { padding: 12, gap: 6 }]}>
      <Text style={styles.heading}>{series.description}</Text>
      <Text style={styles.muted}>
        {series.slots.length} ocorrências · {seriesPendingReason(series)}
      </Text>
      <Button
        compact
        label={open ? 'Recolher revisão' : 'Revisar'}
        disabled={busy}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <View style={{ gap: 12 }}>
          {duplicates.length > 1 && (
            <View style={styles.card}>
              <Text style={styles.text}>
                O mesmo problema aparece em {duplicates.length} grupos. Manter
                todos afeta {duplicateRecords.length} registros; cada um terá
                identidade própria.
              </Text>
              <Button
                label={`Manter todos separadamente (${duplicateRecords.length} registros)`}
                disabled={busy}
                onPress={() => {
                  setChoices((old) =>
                    keepSeriesRecords(series, old, duplicateRecords),
                  );
                  duplicates.forEach((group) =>
                    decide(
                      group.id,
                      `Conservar ${group.records.length} registros com identidades separadas`,
                    ),
                  );
                }}
              />
            </View>
          )}
          {groups.map((group) => (
            <View key={group.id} style={{ gap: 8 }}>
              <Text style={styles.heading}>{group.title}</Text>
              <Text style={styles.text}>{group.explanation}</Text>
              {recordsCards(group.records)}
              <Text style={styles.muted}>
                Esta decisão afeta {group.records.length} registros.
              </Text>
              {(group.kind === 'duplicate' || group.kind === 'schedule') && (
                <Button
                  disabled={busy}
                  label={
                    group.kind === 'duplicate'
                      ? group.records.length === 2
                        ? 'Manter ambos'
                        : `Manter os ${group.records.length} registros`
                      : `Conservar separadamente (${group.records.length} registros)`
                  }
                  onPress={() => {
                    setChoices((old) =>
                      keepSeriesRecords(series, old, group.records),
                    );
                    decide(
                      group.id,
                      `Conservar ${group.records.length} registros com identidades separadas`,
                    );
                  }}
                />
              )}
              <Button
                compact
                disabled={busy}
                label={
                  group.kind === 'duplicate'
                    ? series.entityType === 'installmentPurchase'
                      ? 'Associar a outra parcela'
                      : ['monthly', 'manual'].includes(series.frequency)
                        ? 'Associar a outro mês'
                        : 'Associar a outra data'
                    : 'Corrigir um registro'
                }
                onPress={() => setEditing(group.records[0].localId)}
              />
              {group.kind !== 'schedule' && (
                <Button
                  disabled={busy || !!error}
                  label={
                    group.kind === 'duplicate'
                      ? 'Aplicar associações corrigidas'
                      : group.kind === 'position'
                        ? `Usar posições exibidas (${group.records.length} registros)`
                        : `Usar datas exibidas (${group.records.length} registros)`
                  }
                  onPress={() =>
                    decide(
                      group.id,
                      `Usar as associações exibidas em ${group.records.length} registros`,
                    )
                  }
                />
              )}
              {decisions[group.id] && (
                <Text style={styles.text} accessibilityRole="alert">
                  Decisão preparada: {decisions[group.id]}.
                </Text>
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
          {error && (
            <Text style={styles.text} accessibilityRole="alert">
              {error}
            </Text>
          )}
          {!ready && (
            <Text style={styles.muted}>
              Resolva os grupos indicados para conferir o resumo da série.
            </Text>
          )}
          {!confirming ? (
            <Button
              tone="primary"
              disabled={busy || !ready}
              label="Conferir resumo da série"
              onPress={() => {
                setConfirming(true);
                setEditing(null);
              }}
            />
          ) : (
            <View style={styles.card}>
              <Text style={styles.heading}>
                Confirmar revisão de {series.description}
              </Text>
              <Text style={styles.text}>
                {seriesPreservationSummary(series)}
              </Text>
              {!!associationChanges.length && (
                <View>
                  <Text style={styles.text}>
                    {associationChanges.length}{' '}
                    {associationChanges.length === 1
                      ? 'associação alterada'
                      : 'associações alteradas'}
                    :
                  </Text>
                  {associationChanges.map((line) => (
                    <Text key={line} style={styles.muted}>
                      {line}
                    </Text>
                  ))}
                </View>
              )}
              {Object.entries(decisions).map(([id, decision]) => (
                <Text key={id} style={styles.text}>
                  {groups.find((group) => group.id === id)?.title} {decision}.
                </Text>
              ))}
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
          )}
        </View>
      )}
    </View>
  );
}
