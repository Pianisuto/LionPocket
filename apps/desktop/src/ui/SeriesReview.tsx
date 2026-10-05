import { useEffect, useState } from 'react';
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
            <th>
              <span className="sr-only">Editar</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((record, i) => {
            const choice =
              choices.find((item) => item.localId === record.localId) ??
              initialSeriesChoices(series).find(
                (item) => item.localId === record.localId,
              )!;
            return (
              <tr key={record.localId}>
                <td>
                  {record.description}
                  <small>Registro {series.slots.indexOf(record) + 1}</small>
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
                    <small>Identidade separada</small>
                  )}
                </td>
                <td>
                  <button
                    className="button button--ghost"
                    disabled={busy}
                    aria-label={`Editar registro ${series.slots.indexOf(record) + 1}`}
                    onClick={() =>
                      setEditing(
                        editing === record.localId ? null : record.localId,
                      )
                    }
                  >
                    {editing === record.localId ? 'Fechar edição' : 'Editar'}
                  </button>
                  {editing === record.localId && (
                    <div className="series-review__editor">
                      <label>
                        Data original / mês de associação
                        <input
                          aria-label={`Data original do registro ${i + 1}`}
                          type="date"
                          value={choice.originalDate}
                          disabled={busy}
                          onChange={(event) =>
                            change(record.localId, {
                              originalDate: event.target.value,
                            })
                          }
                        />
                      </label>
                      {series.entityType === 'installmentPurchase' && (
                        <label>
                          Posição original
                          <input
                            type="number"
                            min="1"
                            value={choice.originalIndex ?? ''}
                            disabled={busy}
                            onChange={(event) =>
                              change(record.localId, {
                                originalIndex: Number(event.target.value),
                              })
                            }
                          />
                        </label>
                      )}
                      <small>
                        Altera somente a associação; o lançamento e seu
                        pagamento permanecem como estão.
                      </small>
                    </div>
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
          {duplicates.length > 1 && (
            <div className="series-review__group">
              <p>
                O mesmo problema aparece em {duplicates.length} grupos. Manter
                todos afeta {duplicateRecords.length} registros; cada um terá
                identidade própria.
              </p>
              <button
                className="button button--soft"
                disabled={busy}
                onClick={() => {
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
              >
                Manter todos separadamente ({duplicateRecords.length} registros)
              </button>
            </div>
          )}
          {groups.map((group) => (
            <section className="series-review__group" key={group.id}>
              <h5>{group.title}</h5>
              <p>{group.explanation}</p>
              {recordsTable(group.records)}
              <p className="series-review__impact">
                Esta decisão afeta {group.records.length} registros.
              </p>
              <div className="series-review__actions">
                {(group.kind === 'duplicate' || group.kind === 'schedule') && (
                  <button
                    className="button button--soft"
                    disabled={busy}
                    onClick={() => {
                      setChoices((old) =>
                        keepSeriesRecords(series, old, group.records),
                      );
                      decide(
                        group.id,
                        `Conservar ${group.records.length} registros com identidades separadas`,
                      );
                    }}
                  >
                    {group.kind === 'duplicate'
                      ? group.records.length === 2
                        ? 'Manter ambos'
                        : `Manter os ${group.records.length} registros`
                      : `Conservar separadamente (${group.records.length} registros)`}
                  </button>
                )}
                <button
                  className="button button--ghost"
                  disabled={busy}
                  onClick={() => setEditing(group.records[0].localId)}
                >
                  {group.kind === 'duplicate'
                    ? series.entityType === 'installmentPurchase'
                      ? 'Associar a outra parcela'
                      : ['monthly', 'manual'].includes(series.frequency)
                        ? 'Associar a outro mês'
                        : 'Associar a outra data'
                    : 'Corrigir um registro'}
                </button>
                {group.kind !== 'schedule' && (
                  <button
                    className="button button--soft"
                    disabled={busy || !!error}
                    onClick={() =>
                      decide(
                        group.id,
                        `Usar as associações exibidas em ${group.records.length} registros`,
                      )
                    }
                  >
                    {group.kind === 'duplicate'
                      ? 'Aplicar associações corrigidas'
                      : group.kind === 'position'
                        ? `Usar posições exibidas (${group.records.length} registros)`
                        : `Usar datas exibidas (${group.records.length} registros)`}
                  </button>
                )}
              </div>
              {decisions[group.id] && (
                <p role="status">Decisão preparada: {decisions[group.id]}.</p>
              )}
            </section>
          ))}
          {!!unambiguous.length && (
            <div className="series-review__preview">
              <button
                className="button button--ghost"
                aria-expanded={preview}
                onClick={() => setPreview(!preview)}
              >
                {preview
                  ? 'Recolher prévia'
                  : `Prévia: ${unambiguous.length} ocorrências sem ambiguidade`}
              </button>
              {preview && recordsTable(unambiguous)}
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          {!ready && (
            <p>Resolva os grupos indicados para conferir o resumo da série.</p>
          )}
          {!confirming ? (
            <button
              className="button button--primary"
              disabled={busy || !ready}
              onClick={() => {
                setConfirming(true);
                setEditing(null);
              }}
            >
              Conferir resumo da série
            </button>
          ) : (
            <div className="series-review__confirmation">
              <h5>Confirmar revisão de {series.description}</h5>
              <p>{seriesPreservationSummary(series)}</p>
              {!!associationChanges.length && (
                <details className="series-review__changes">
                  <summary>
                    {associationChanges.length}{' '}
                    {associationChanges.length === 1
                      ? 'associação alterada'
                      : 'associações alteradas'}{' '}
                    — conferir antes de confirmar
                  </summary>
                  {associationChanges.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </details>
              )}
              {Object.entries(decisions).map(([id, decision]) => (
                <p key={id}>
                  {groups.find((group) => group.id === id)?.title} {decision}.
                </p>
              ))}
              <div className="series-review__actions">
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
    </section>
  );
}
