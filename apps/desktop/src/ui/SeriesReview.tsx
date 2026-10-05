import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { dateForMonthDay, isValidDate } from '@lionpocket/core';
import {
  applySeriesDecision,
  editSeriesChoice,
  initialSeriesChoices,
  prepareSeriesReview,
  seriesGroupsRequiringInput,
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
  const [choices, setChoices] = useState(
    () => prepareSeriesReview(series).choices,
  );
  const [decisions, setDecisions] = useState<
    Record<string, SeriesReviewDecision>
  >(() => prepareSeriesReview(series).decisions);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const signature = JSON.stringify(series);
  useEffect(() => {
    const prepared = prepareSeriesReview(series);
    setChoices(prepared.choices);
    setDecisions(prepared.decisions);
    setEditing(null);
    setConfirming(false);
  }, [signature]);
  const groups = seriesDecisionGroups(series);
  const decisionGroups = seriesGroupsRequiringInput(series, choices);
  const duplicates = decisionGroups.filter(
    (group) => group.kind === 'duplicate',
  );
  const involved = new Set(
    decisionGroups.flatMap((group) =>
      group.records.map((record) => record.localId),
    ),
  );
  const preparedRecords = series.slots.filter(
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
  const recordsTable = (
    records: LegacyReviewRecord[],
    group?: SeriesDecisionGroup,
  ) => (
    <div className="series-review__table-wrap">
      <table className="series-review__table">
        <thead>
          <tr>
            <th>Registro</th>
            <th>Datas</th>
            <th>Valores</th>
            <th>Estado</th>
            <th>Associação</th>
            <th aria-label="Ações">
              {group && decisions[group.id] === 'delete' ? 'Excluir' : ''}
            </th>
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
                <td>
                  {reviewStatusLabel(record.status)}
                  {record.settledDate && (
                    <small>
                      Pagamento em {reviewDateLabel(record.settledDate)}
                    </small>
                  )}
                  {record.deletedAt && <small>Excluído</small>}
                </td>
                <td>
                  {reviewDateLabel(choice.originalDate)}
                  {series.entityType === 'installmentPurchase' && (
                    <small>Posição {choice.originalIndex ?? '—'}</small>
                  )}
                  {choice.slotKey.includes(':legacy:') && (
                    <small>
                      {choice.deleteRecord
                        ? 'Será excluído ao confirmar'
                        : 'Preservado separadamente'}
                    </small>
                  )}
                </td>
                <td className="series-review__row-actions">
                  {group && decisions[group.id] === 'delete' ? (
                    record.deletedAt ? (
                      <small>Já excluído</small>
                    ) : (
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={!!choice.deleteRecord}
                        aria-label={`Excluir registro ${number} na confirmação`}
                        onChange={(event) =>
                          setChoices((old) =>
                            markSeriesRecordForDeletion(
                              series,
                              old,
                              group,
                              record.localId,
                              event.target.checked,
                            ),
                          )
                        }
                      />
                    )
                  ) : (
                    <button
                      className="icon-button"
                      disabled={busy}
                      title="Editar associação"
                      aria-label={`Editar associação do registro ${number}`}
                      onClick={() => setEditing(record.localId)}
                    >
                      <Pencil size={16} />
                    </button>
                  )}
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
          <span className="series-review__count">
            {series.slots.length} ocorrências
          </span>
          <p>{seriesPendingReason(series)}</p>
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
              {decisionGroups.map((group) => (
                <section className="series-review__group" key={group.id}>
                  <h5>{group.title}</h5>
                  <p>{group.explanation}</p>
                  {recordsTable(group.records, group)}
                  <div className="series-review__decision">
                    {seriesDecisionOptions(series, group).length > 1 && (
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
                    )}
                    <p>
                      {seriesDecisionDescription(
                        group,
                        decisions[group.id] ?? '',
                      )}
                    </p>
                    {decisions[group.id] === 'delete' && (
                      <>
                        <p>
                          {seriesDeletionSummary(series, group, choices)}
                        </p>
                        {seriesDeletionSelectionError(group, choices) && (
                          <p>
                            {seriesDeletionSelectionError(group, choices)}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </section>
              ))}
              {!!preparedRecords.length && (
                <details className="series-review__preview">
                  <summary>
                    Ocorrências preparadas ({preparedRecords.length})
                  </summary>
                  <p>
                    Registros sem decisão pendente. Você pode ajustar as
                    associações pela edição individual.
                  </p>
                  {recordsTable(preparedRecords)}
                </details>
              )}
              {error &&
                (decisionGroups.length === 0 ||
                  decisionGroups.some(
                    (group) =>
                      seriesDecisionOptions(series, group).length === 1 ||
                      decisions[group.id],
                  )) && <p role="alert">{error}</p>}
              <div className="series-review__footer">
                <span>
                  {ready
                    ? 'Revisão preparada. Confira o resumo antes de confirmar.'
                    : 'Resolva os grupos indicados para continuar.'}
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
              <SeriesReviewSummary
                series={series}
                choices={choices}
                decisions={decisions}
              />
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

export function SeriesReviewSummary({
  series,
  choices,
  decisions,
}: {
  series: SeriesReview;
  choices: ReviewedSlot[];
  decisions: Record<string, SeriesReviewDecision>;
}) {
  const summary = seriesConfirmation(series, choices, decisions);
  const changed = summary.records.some((item) => item.associationChanged);
  return (
    <>
      <h5 className="series-review__summary-title">Resumo da revisão</h5>
      <dl className="series-review__stats">
        {summary.statistics.map((stat) => (
          <div key={stat.label}>
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
          </div>
        ))}
      </dl>
      <section className="series-review__summary-section">
        <h6>Decisões da série</h6>
        <div className="series-review__table-wrap">
          <table className="series-review__table series-review__summary-table">
            <thead>
              <tr>
                <th>Grupo</th>
                <th>Decisão</th>
                <th>Registros</th>
              </tr>
            </thead>
            <tbody>
              {summary.decisions.map((decision) => (
                <tr key={decision.id}>
                  <td>{decision.groupLabel}</td>
                  <td>
                    {decision.decisionLabel}
                    {decision.automatic && (
                      <small>Aplicada automaticamente</small>
                    )}
                  </td>
                  <td>{decision.recordCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {!!summary.records.length && (
        <section className="series-review__summary-section">
          <h6>Registros envolvidos</h6>
          <div className="series-review__table-wrap">
            <table className="series-review__table series-review__summary-table">
              <thead>
                <tr>
                  <th>Ação</th>
                  <th>Registro</th>
                  <th>Datas</th>
                  <th>Valores</th>
                  <th>Estado</th>
                  {changed && <th>Associação</th>}
                </tr>
              </thead>
              <tbody>
                {summary.records.map(
                  ({
                    record,
                    number,
                    actionLabel,
                    choice,
                    before,
                    associationChanged,
                  }) => (
                    <tr key={record.localId}>
                      <td>
                        <strong>{actionLabel}</strong>
                      </td>
                      <td>
                        {record.description}
                        <small>Registro {number}</small>
                      </td>
                      <td>
                        <small>Ocorrência</small>
                        {reviewDateLabel(record.currentDate)}
                        <small>Vencimento</small>
                        {reviewDateLabel(record.dueDate)}
                      </td>
                      <td>
                        <small>Previsto</small>
                        {reviewMoney(record.plannedAmountCents)}
                        {record.actualAmountCents !== null && (
                          <>
                            <small>Realizado</small>
                            {reviewMoney(record.actualAmountCents)}
                          </>
                        )}
                      </td>
                      <td>
                        {reviewStatusLabel(record.status)}
                        {record.settledDate && (
                          <>
                            <small>Pagamento</small>
                            {reviewDateLabel(record.settledDate)}
                          </>
                        )}
                      </td>
                      {changed && (
                        <td>
                          {associationChanged ? (
                            <>
                              <small>Anterior</small>
                              {reviewDateLabel(before.originalDate)}
                              {before.originalIndex !== null && (
                                <small>
                                  Posição {before.originalIndex}
                                </small>
                              )}
                              <small>Nova</small>
                              {reviewDateLabel(choice.originalDate)}
                              {choice.originalIndex !== null && (
                                <small>
                                  Posição {choice.originalIndex}
                                </small>
                              )}
                            </>
                          ) : (
                            'Sem alteração'
                          )}
                        </td>
                      )}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <div className="series-review__preservation">
        {summary.hasDeletions && (
          <p>
            Somente os registros marcados para excluir sairão dos
            lançamentos e totais. As exclusões serão sincronizadas.
          </p>
        )}
        <p>
          O histórico, valores, vencimentos, pagamentos e vínculos
          permanecem armazenados.
        </p>
      </div>
    </>
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
        <dl className="form-grid__full series-review__record-facts">
          <div>
            <dt>Ocorrência</dt>
            <dd>{reviewDateLabel(record.currentDate)}</dd>
          </div>
          <div>
            <dt>Previsto</dt>
            <dd>{reviewMoney(record.plannedAmountCents)}</dd>
          </div>
          <div>
            <dt>Estado</dt>
            <dd>
              {reviewStatusLabel(record.status)}
              {record.deletedAt && <small>Excluído</small>}
            </dd>
          </div>
        </dl>
        {monthly ? (
          <MonthField
            className="form-grid__full"
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
