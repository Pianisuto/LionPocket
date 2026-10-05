import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { dateForMonthDay, isValidDate } from '@lionpocket/core';
import {
  applySeriesDecision,
  editSeriesChoice,
  initialSeriesChoices,
  reviewDateLabel,
  reviewMoney,
  reviewStateLabel,
  seriesAssociationChanges,
  seriesDecisionDescription,
  seriesDecisionGroups,
  seriesDecisionOptions,
  seriesPendingReason,
  seriesPreservationSummary,
  seriesReviewError,
  type LegacyReviewRecord,
  type ReviewedSlot,
  type SeriesDecisionGroup,
  type SeriesReview,
  type SeriesReviewDecision,
} from '@lionpocket/sync-local';
import {
  DateField,
  Modal,
  MonthField,
  NumberField,
  SelectField,
} from './components';

export function SeriesReviewForm({
  series,
  busy,
  submit,
}: {
  series: SeriesReview;
  busy: boolean;
  submit: (slots: ReviewedSlot[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState(() => initialSeriesChoices(series));
  const [decisions, setDecisions] = useState<
    Record<string, SeriesReviewDecision>
  >({});
  const [editing, setEditing] = useState<string | null>(null);
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
    groups.flatMap((group) => group.records.map((record) => record.localId)),
  );
  const unambiguous = series.slots.filter(
    (record) => !involved.has(record.localId),
  );
  const error = seriesReviewError(series, choices);
  const ready = !error && groups.every((group) => decisions[group.id]);
  const associationChanges = seriesAssociationChanges(series, choices);
  const editorRecord = series.slots.find(
    (record) => record.localId === editing,
  );
  const editorChoice = choices.find((choice) => choice.localId === editing);
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
  const recordsTable = (records: LegacyReviewRecord[]) => (
    <div className="series-review__table-wrap">
      <table className="series-review__table">
        <thead>
          <tr>
            <th>Registro</th>
            <th>Datas</th>
            <th>Valores</th>
            <th>Estado</th>
            <th>Associação</th>
            <th aria-label="Ações" />
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const choice =
              choices.find((item) => item.localId === record.localId) ??
              initialSeriesChoices(series).find(
                (item) => item.localId === record.localId,
              );
            if (!choice) return null;
            const number = series.slots.indexOf(record) + 1;
            return (
              <tr key={record.localId}>
                <td>
                  {record.description}
                  <small>Registro {number}</small>
                </td>
                <td>
                  {reviewDateLabel(record.currentDate)}
                  <small>Vence {reviewDateLabel(record.dueDate)}</small>
                </td>
                <td>
                  {reviewMoney(record.plannedAmountCents)}
                  {record.actualAmountCents !== null && (
                    <small>
                      Realizado {reviewMoney(record.actualAmountCents)}
                    </small>
                  )}
                </td>
                <td>{reviewStateLabel(record)}</td>
                <td>
                  {reviewDateLabel(choice.originalDate)}
                  {series.entityType === 'installmentPurchase' && (
                    <small>Posição {choice.originalIndex ?? '—'}</small>
                  )}
                  {choice.slotKey.includes(':legacy:') && (
                    <small>Preservado separadamente</small>
                  )}
                </td>
                <td className="series-review__row-actions">
                  <button
                    className="icon-button"
                    disabled={busy}
                    title="Editar associação"
                    aria-label={`Editar associação do registro ${number}`}
                    onClick={() => setEditing(record.localId)}
                  >
                    <Pencil size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  return (
    <section className="sync-review series-review">
      <div className="series-review__header">
        <div>
          <h4>{series.description}</h4>
          <p>
            {series.slots.length} ocorrências · {seriesPendingReason(series)}
          </p>
        </div>
        <button
          className="button button--soft"
          disabled={busy}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Recolher revisão' : 'Revisar'}
        </button>
      </div>
      {open && (
        <div className="series-review__body">
          {!confirming ? (
            <>
              {duplicates.length > 1 && (
                <label className="series-review__batch">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={duplicates.every(
                      (group) => decisions[group.id] === 'keep',
                    )}
                    onChange={(event) => {
                      const decision = event.target.checked ? 'keep' : '';
                      setChoices((old) =>
                        duplicates.reduce(
                          (next, group) =>
                            applySeriesDecision(series, next, group, decision),
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
                  <span>
                    Manter separados os{' '}
                    {duplicates.reduce(
                      (count, group) => count + group.records.length,
                      0,
                    )}{' '}
                    registros dos {duplicates.length} grupos repetidos.
                  </span>
                </label>
              )}
              {groups.map((group) => (
                <section className="series-review__group" key={group.id}>
                  <h5>{group.title}</h5>
                  <p>{group.explanation}</p>
                  {recordsTable(group.records)}
                  <div className="series-review__decision">
                    <SelectField
                      label={`Decisão para este grupo (${group.records.length} registros)`}
                      value={decisions[group.id] ?? ''}
                      options={[
                        { value: '', label: 'Selecione uma decisão' },
                        ...seriesDecisionOptions(series, group),
                      ]}
                      disabled={busy}
                      onChange={(value) =>
                        decide(group, value as SeriesReviewDecision)
                      }
                    />
                    <p>
                      {seriesDecisionDescription(
                        group,
                        decisions[group.id] ?? '',
                      )}
                    </p>
                  </div>
                </section>
              ))}
              {!!unambiguous.length && (
                <details className="series-review__preview">
                  <summary>
                    Prévia: {unambiguous.length} ocorrências sem ambiguidade
                  </summary>
                  {recordsTable(unambiguous)}
                </details>
              )}
              {error && Object.values(decisions).some(Boolean) && (
                <p role="alert">{error}</p>
              )}
              <div className="series-review__footer">
                <span>
                  {ready
                    ? 'Decisões preparadas. Confira o resumo antes de confirmar.'
                    : 'Selecione as decisões dos grupos acima para continuar.'}
                </span>
                <button
                  className="button button--primary"
                  disabled={busy || !ready}
                  onClick={() => setConfirming(true)}
                >
                  Conferir resumo da série
                </button>
              </div>
            </>
          ) : (
            <div className="series-review__confirmation">
              <h5>Confirmar revisão de {series.description}</h5>
              <p>{seriesPreservationSummary(series)}</p>
              {groups.map((group) => (
                <p key={group.id}>
                  <strong>
                    {
                      seriesDecisionOptions(series, group).find(
                        (option) => option.value === decisions[group.id],
                      )?.label
                    }
                  </strong>{' '}
                  · {group.records.length} registros.{' '}
                  {decisions[group.id] === 'associate'
                    ? 'As associações abaixo serão usadas.'
                    : seriesDecisionDescription(
                        group,
                        decisions[group.id] ?? '',
                      )}
                </p>
              ))}
              {associationChanges.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <div className="modal__actions">
                <button
                  className="button button--ghost"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Voltar à revisão
                </button>
                <button
                  className="button button--primary"
                  disabled={busy || !ready}
                  onClick={() => void submit(choices)}
                >
                  Confirmar e liberar série
                </button>
              </div>
            </div>
          )}
        </div>
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
    </section>
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
  onSave: (patch: Pick<ReviewedSlot, 'originalDate' | 'originalIndex'>) => void;
}) {
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
    <Modal
      title="Editar associação"
      description={record.description}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy)
            onSave({
              originalDate: date,
              originalIndex:
                series.entityType === 'installmentPurchase'
                  ? Number(index)
                  : null,
            });
        }}
      >
        <p className="form-grid__full">
          {reviewDateLabel(record.currentDate)} ·{' '}
          {reviewMoney(record.plannedAmountCents)} · {reviewStateLabel(record)}
        </p>
        {monthly ? (
          <MonthField
            className="form-grid__full"
            label="Mês original"
            value={date.slice(0, 7)}
            onChange={(month) =>
              setDate(dateForMonthDay(month, Number(date.slice(8, 10)) || 1))
            }
          />
        ) : (
          <DateField
            className="form-grid__full"
            label="Data original"
            value={date}
            onChange={setDate}
            required
          />
        )}
        {series.entityType === 'installmentPurchase' && (
          <NumberField
            className="form-grid__full"
            label="Posição original"
            value={index}
            onChange={setIndex}
            min={1}
            required
          />
        )}
        <p className="form-grid__full">
          Altera somente a associação nesta revisão. Valores, vencimentos,
          pagamentos e vínculos permanecem como estão.
        </p>
        <div className="modal__actions form-grid__full">
          <button
            type="button"
            className="button button--ghost"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || !valid}
          >
            Salvar associação
          </button>
        </div>
      </form>
    </Modal>
  );
}
