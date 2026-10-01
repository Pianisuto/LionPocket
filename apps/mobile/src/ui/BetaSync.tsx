import { betaActivityLabel } from '@lionpocket/sync-local';
import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type {
  BetaStatus,
  SeriesReview,
  CatalogReview,
  ReviewedSlot,
} from '@lionpocket/sync-local';
import type { PairingRequest } from '@lionpocket/sync-protocol';
import { betaSync, privateBeta } from '../sync/beta';
import { Button, useStyles } from './components';
export function BetaSyncPanel({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const styles = useStyles(),
    [status, setStatus] = useState<BetaStatus>(),
    [endpoint, setEndpoint] = useState('https://sync-beta.lionslab.dev'),
    [invitation, setInvitation] = useState(''),
    [fingerprint, setFingerprint] = useState(''),
    [authority, setAuthority] = useState(''),
    [requests, setRequests] = useState<PairingRequest[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [recoveryCode, setRecoveryCode] = useState(''),
    [confirmedCode, setConfirmedCode] = useState(''),
    [revokeId, setRevokeId] = useState('');
  const [series, setSeries] = useState<SeriesReview[]>([]),
    [catalogs, setCatalogs] = useState<CatalogReview[]>([]);
  const refresh = async () => {
    const s = await (await betaSync()).status();
    setStatus(s);
    setEndpoint(s.endpoint);
    if (s.phase === 'bound') {
      const c = await betaSync();
      setSeries(await c.seriesReviews());
      setCatalogs(await c.catalogReviews());
    }
  };
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let lastCompleted: string | undefined;
    if (privateBeta) {
      void refresh().catch((e) => setError(String(e)));
      void betaSync().then(c => {
        if (!disposed) unsubscribe = c.subscribe(() => {
          void refresh().catch(() => { /* Status remains best effort; local use continues. */ });
          if (c.coordinator.lastCompletedAt && c.coordinator.lastCompletedAt !== lastCompleted) {
            lastCompleted = c.coordinator.lastCompletedAt;
            void onChanged().catch(() => { /* Refresh cannot affect saved data. */ });
          }
        });
      }).catch(() => { /* Status remains best effort; local use continues. */ });
    }
    return () => { disposed = true; unsubscribe?.(); };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
      await onChanged();
    } catch (e) {
      setError(String(e));
      await refresh().catch(() => {
        /* Preserve the original operation error. */
      });
    } finally {
      setBusy(false);
    }
  };
  const act = (
    action: (c: Awaited<ReturnType<typeof betaSync>>) => Promise<unknown>,
  ) => void run(async () => action(await betaSync()));
  if (!privateBeta) return null;
  if (!status)
    return (
      <Text accessibilityRole="alert">
        {error || 'Carregando sincronização…'}
      </Text>
    );
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Sincronização · Beta privada</Text>
      <Text style={styles.text}>
        Este app mantém uma cópia separada. Você pode trabalhar offline. O
        conteúdo enviado é cifrado; banco e backups locais permanecem em claro.
      </Text>
      <Text style={styles.text}>
        {betaActivityLabel[status.activity]} · Pendentes: {status.sync?.pending ?? 0}
      </Text>
      {status.lastCompletedAt && <Text style={styles.muted}>Último sync concluído: {new Date(status.lastCompletedAt).toLocaleString('pt-BR')}</Text>}
      <Text style={styles.muted}>Salvo neste aparelho primeiro. Sync automático ao abrir/retomar e após salvar, com o app ativo. Android fechado não garante envio. “Sincronizar agora” continua disponível.</Text>
      {status.phase === 'local' && (
        <>
          <TextInput
            style={styles.input}
            accessibilityLabel="Servidor HTTPS"
            value={endpoint}
            onChangeText={setEndpoint}
            autoCapitalize="none"
          />
          <Button
            label="Conferir servidor"
            disabled={busy}
            onPress={() => act((c) => c.configure(endpoint))}
          />
          <Text style={styles.text}>
            Revisão da base:{' '}
            {Object.entries(status.counts)
              .map(([t, n]) => `${t}: ${n}`)
              .join(' · ')}
          </Text>
          <Button
            label={
              reviewed
                ? 'Base revisada. Backup e envio autorizados'
                : 'Revisar e autorizar backup e envio'
            }
            disabled={busy}
            onPress={() => setReviewed(!reviewed)}
          />
          <Button
            label="Entrar e criar cofre"
            disabled={busy || !reviewed}
            onPress={() => act((c) => c.create())}
          />
          <TextInput
            style={styles.input}
            accessibilityLabel="Convite do cofre"
            multiline
            value={invitation}
            onChangeText={(v) => {
              setInvitation(v);
              setAuthority('');
            }}
            placeholder="Cole o convite do outro aparelho"
            autoCapitalize="none"
          />
          <Button
            label="Conferir autoridade"
            disabled={busy || !invitation}
            onPress={() =>
              act(async (c) =>
                setAuthority(
                  (await c.inspectInvitation(invitation)).fingerprint,
                ),
              )
            }
          />
          {authority && (
            <>
              <Text style={styles.text} selectable>
                Código da autoridade: {authority}
              </Text>
              <Text style={styles.text}>
                Compare no aparelho que criou o cofre.
              </Text>
              <TextInput
                style={styles.input}
                accessibilityLabel="Código da autoridade conferido"
                value={fingerprint}
                onChangeText={setFingerprint}
                autoCapitalize="none"
              />
              <Button
                label="Entrar e pedir aprovação"
                disabled={busy || !reviewed || fingerprint !== authority}
                onPress={() => act((c) => c.pair(invitation, fingerprint))}
              />
            </>
          )}
        </>
      )}
      {status.phase === 'local' && authority && (
        <>
          <Text style={styles.heading}>Recuperar cofre em nova instalação</Text>
          <TextInput
            style={styles.input}
            accessibilityLabel="Código de recovery"
            secureTextEntry
            value={confirmedCode}
            onChangeText={setConfirmedCode}
            autoCapitalize="none"
          />
          <Button
            label="Entrar e recuperar cofre"
            disabled={busy || fingerprint !== authority || !confirmedCode}
            onPress={() =>
              act((c) => c.recover(invitation, fingerprint, confirmedCode))
            }
          />
        </>
      )}
      {status.phase === 'creating' && (
        <Button
          label="Retomar criação do cofre"
          disabled={busy}
          onPress={() => act((c) => c.create())}
        />
      )}
      {status.phase === 'pairing' && (
        <>
          <Text style={styles.text} selectable>
            Código deste aparelho: {status.pairingFingerprint}
          </Text>
          <Text style={styles.text}>
            Confira e aprove no aparelho fundador.
          </Text>
          <Button
            label="Entrar e receber chave aprovada"
            disabled={busy}
            onPress={() => act((c) => c.receive())}
          />
        </>
      )}
      {status.phase === 'bound' && (
        <>
          {status.owner && (
            <>
              <Text style={styles.heading}>Conectar outro aparelho</Text>
              <Text style={styles.text} selectable>
                {status.invitation}
              </Text>
              <Text style={styles.text} selectable>
                Código da autoridade: {status.authorityFingerprint}
              </Text>
              <Button
                label="Entrar e buscar pedidos"
                disabled={busy}
                onPress={() =>
                  act(async (c) => setRequests((await c.requests()).requests))
                }
              />
              {requests.map((r) => (
                <View key={r.deviceId}>
                  <Text style={styles.text} selectable>
                    Aparelho {r.deviceId} · Código: {r.fingerprint}
                  </Text>
                  <TextInput
                    style={styles.input}
                    accessibilityLabel="Código mostrado no aparelho"
                    value={fingerprint}
                    onChangeText={setFingerprint}
                    autoCapitalize="none"
                  />
                  <Button
                    label="Aprovar e entregar chave"
                    disabled={busy || fingerprint !== r.fingerprint}
                    onPress={() =>
                      act((c) => c.approve(r.deviceId, fingerprint))
                    }
                  />
                </View>
              ))}
            </>
          )}
          {status.restoreReview && (
            <>
              <Text style={styles.text}>
                Cópia restaurada: reconecte no mesmo aparelho, cofre e epoch. As
                diferenças locais serão rascunhos; receba e revise o remoto
                antes de liberar envio.
              </Text>
              <Button
                label={
                  reviewed ? 'Cópia revisada' : 'Revisei a cópia restaurada'
                }
                disabled={busy}
                onPress={() => setReviewed(!reviewed)}
              />
              <Button
                label="Reconectar cópia para revisão"
                disabled={busy || !reviewed}
                onPress={() => act((c) => c.reconnectRestored(true))}
              />
            </>
          )}
          <Button
            label={busy ? 'Aguarde…' : 'Sincronizar agora'}
            disabled={busy || status.paused || status.restoreReview}
            onPress={() => act((c) => c.sync())}
          />
          <Button
            label={
              status.paused
                ? 'Retomar sincronização'
                : 'Pausar mantendo pendências'
            }
            disabled={busy}
            onPress={() => act((c) => c.pause(!status.paused))}
          />
          {status.joiningReview && (
            <>
              <Text style={styles.heading}>Combinar bases preenchidas</Text>
              <Text style={styles.text}>
                Sincronize para receber a base remota. Nomes iguais exigem
                revisão. Os registros de identidades distintas são conservados.
              </Text>
              <Button
                label={
                  reviewed
                    ? 'Bases revisadas'
                    : 'Revisei as bases e desejo combinar'
                }
                disabled={busy}
                onPress={() => setReviewed(!reviewed)}
              />
              <Button
                label="Confirmar combinação e liberar envio"
                disabled={busy || !reviewed || !!status.quarantine.length}
                onPress={() => act((c) => c.confirmCombination())}
              />
            </>
          )}
          {status.owner && (
            <>
              <Text style={styles.heading}>Recuperação e proteção</Text>
              <Text style={styles.text}>
                Versão da chave: {status.activeKeyVersion} · Recovery
                confirmado: {status.recoveryVersion !== '0' ? 'Sim' : 'Não'}
              </Text>
              <Button
                label="Gerar código de recovery"
                disabled={busy}
                onPress={() =>
                  act(async (c) =>
                    setRecoveryCode((await c.generateRecovery()).code),
                  )
                }
              />
              {!!recoveryCode && (
                <>
                  <Text style={styles.text}>
                    Guarde o segredo fora do app. Ele recupera os dados e a
                    autoridade.
                  </Text>
                  <Text style={styles.text} selectable>
                    {recoveryCode}
                  </Text>
                  <TextInput
                    style={styles.input}
                    accessibilityLabel="Código de recovery guardado"
                    secureTextEntry
                    value={confirmedCode}
                    onChangeText={setConfirmedCode}
                    autoCapitalize="none"
                  />
                  <Button
                    label="Confirmar posse e ativar recovery"
                    disabled={busy || confirmedCode !== recoveryCode}
                    onPress={() =>
                      act(async (c) => {
                        await c.confirmRecovery(confirmedCode);
                        setRecoveryCode('');
                        setConfirmedCode('');
                      })
                    }
                  />
                </>
              )}
              <Button
                label="Rotacionar chave e retomar operação pendente"
                disabled={busy}
                onPress={() => act((c) => c.rotateKeys())}
              />
              <TextInput
                style={styles.input}
                accessibilityLabel="ID do aparelho a revogar"
                value={revokeId}
                onChangeText={setRevokeId}
                autoCapitalize="none"
              />
              <Button
                label="Revogar aparelho e rotacionar chave"
                disabled={busy || !revokeId}
                onPress={() => act((c) => c.revoke(revokeId, revokeId))}
              />
            </>
          )}
          <Text style={styles.heading}>Dispositivos</Text>
          {status.devices.map((d) => (
            <Text key={d.registryVersion}>
              {d.deviceId} · {d.status}
            </Text>
          ))}
          {status.sync?.conflicts.map((c) => (
            <View key={c.objectId}>
              <Text style={styles.heading}>Conflito financeiro</Text>
              {c.branches.map((b) => (
                <View key={b.revisionId}>
                  <Text style={styles.text} selectable>
                    {JSON.stringify(
                      b.revision.action === 'put'
                        ? b.revision.snapshot
                        : { action: 'delete' },
                    )}
                  </Text>
                  <Button
                    label={
                      c.deleted && b.revision.action === 'put'
                        ? 'Recuperar como novo registro'
                        : b.revision.action === 'delete'
                          ? 'Confirmar exclusão'
                          : 'Usar esta versão'
                    }
                    disabled={busy}
                    onPress={() =>
                      act((controller) =>
                        controller.resolve(
                          c.objectId,
                          c.heads,
                          b.revisionId,
                          c.deleted && b.revision.action === 'put',
                        ),
                      )
                    }
                  />
                </View>
              ))}
            </View>
          ))}
          {series.map((s) => (
            <SeriesReviewForm
              key={s.localId}
              series={s}
              busy={busy}
              submit={(slots) =>
                act((c) => c.reviewSeries(s.entityType, s.localId, slots))
              }
            />
          ))}
          {!!catalogs.length && (
            <CatalogBatchReview
              catalogs={catalogs}
              busy={busy}
              submit={(suffix) =>
                act((c) => c.preserveCatalogBatch(suffix, true))
              }
            />
          )}
          {catalogs.map((c) => (
            <CatalogReviewForm
              key={c.commitId + c.objectId}
              review={c}
              busy={busy}
              submit={(name) =>
                act((controller) =>
                  controller.preserveBothCatalogs(c.commitId, c.objectId, name),
                )
              }
            />
          ))}
          {status.reviews
            .filter(
              (r) =>
                r.reason === 'import_provenance_review' ||
                (r.reason === 'legacy_delete_review'||r.reason==='restored_missing_record'),
            )
            .map((r) => (
              <View key={String(r.review_id)}>
                <Text style={styles.text}>
                  {r.reason === 'import_provenance_review'
                    ? 'Origem importada antiga sem proveniência verificável. A conversão manual conserva a origem anterior na auditoria.'
                    : 'Exclusão antiga sem data verificável.'}{' '}
                  {String(r.object_id)}
                </Text>
                <Button
                  disabled={busy}
                  label={
                    r.reason === 'import_provenance_review'
                      ? 'Confirmar conversão para lançamento manual'
                      : 'Confirmar exclusão agora'
                  }
                  onPress={() =>
                    act((c) =>
                      r.reason === 'import_provenance_review'
                        ? c.reviewLegacyImport(String(r.object_id), true)
                        : c.confirmLegacyDeletion(String(r.object_id), true),
                    )
                  }
                />
              </View>
            ))}
          {status.reviews.map((r) => (
            <Text key={String(r.review_id)}>
              Revisão necessária: {String(r.reason)} · {String(r.object_id)}
            </Text>
          ))}
          {status.quarantine.map((q) => (
            <Text key={String(q.commit_id)}>
              Recebimento preservado: {String(q.last_error)}
            </Text>
          ))}
        </>
      )}
      {!!error && <Text accessibilityRole="alert">{error}</Text>}
    </View>
  );
}

function CatalogReviewForm({
  review,
  busy,
  submit,
}: {
  review: CatalogReview;
  busy: boolean;
  submit: (name: string) => void;
}) {
  const styles = useStyles();
  const [name, setName] = useState('');
  return (
    <View>
      <Text style={styles.text}>
        Cadastros distintos: {review.entityType} · {review.remoteName}. Escolha
        um nome local distinto para conservar ambos com suas referências.
      </Text>
      <TextInput
        style={styles.input}
        accessibilityLabel="Novo nome local"
        value={name}
        onChangeText={setName}
      />
      <Button
        label="Conservar ambos separadamente"
        disabled={busy || !name.trim() || name.trim() === review.remoteName}
        onPress={() => submit(name)}
      />
    </View>
  );
}
function SeriesReviewForm({
  series,
  busy,
  submit,
}: {
  series: SeriesReview;
  busy: boolean;
  submit: (slots: ReviewedSlot[]) => void;
}) {
  const styles = useStyles();
  const [choices, setChoices] = useState<ReviewedSlot[]>(() =>
      series.slots.map((t) => ({
        localId: t.localId,
        originalDate: '',
        slotKey: '',
        originalIndex: null,
        publish: false,
      })),
    ),
    [confirmed, setConfirmed] = useState(false);
  const change = (i: number, patch: Partial<ReviewedSlot>) =>
    setChoices((old) => old.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  return (
    <View>
      <Text style={styles.text}>
        Revisar série antiga: {series.description}
      </Text>
      <Text style={styles.text}>
        Confira as datas originais no histórico. Slots mensais usam
        monthly:AAAA-MM; outros exigem chave única. Parcelas exigem a posição
        original antes da renumeração.
      </Text>
      {series.slots.map((t, i) => (
        <View key={t.localId}>
          <Text style={styles.text}>
            {t.description} · {t.status} · atual {t.currentDate} · parcela atual{' '}
            {t.installmentNumber ?? '—'}
          </Text>
          <TextInput
            style={styles.input}
            accessibilityLabel="Data original AAAA-MM-DD"
            placeholder="Data original AAAA-MM-DD"
            value={choices[i].originalDate}
            onChangeText={(v) => change(i, { originalDate: v })}
          />
          <TextInput
            style={styles.input}
            accessibilityLabel="Chave original do slot"
            placeholder="Chave original do slot"
            value={choices[i].slotKey}
            onChangeText={(v) => change(i, { slotKey: v })}
          />
          {series.entityType === 'installmentPurchase' && (
            <TextInput
              style={styles.input}
              accessibilityLabel="Posição original"
              placeholder="Posição original"
              keyboardType="number-pad"
              value={
                choices[i].originalIndex === null
                  ? ''
                  : String(choices[i].originalIndex)
              }
              onChangeText={(v) => change(i, { originalIndex: Number(v) })}
            />
          )}
          <Button
            label={
              choices[i].publish
                ? 'Enviar esta ocorrência: sim'
                : 'Enviar esta ocorrência editada ou realizada: não'
            }
            disabled={busy}
            onPress={() => change(i, { publish: !choices[i].publish })}
          />
        </View>
      ))}
      <Button
        label={
          confirmed
            ? 'Identidades conferidas'
            : 'Conferi todas as identidades no histórico'
        }
        disabled={busy}
        onPress={() => setConfirmed(!confirmed)}
      />
      <Button
        label="Confirmar identidades e liberar série"
        disabled={
          busy ||
          !confirmed ||
          choices.some(
            (c) =>
              !c.originalDate ||
              !c.slotKey ||
              (series.entityType === 'installmentPurchase' && !c.originalIndex),
          )
        }
        onPress={() => submit(choices)}
      />
    </View>
  );
}

function CatalogBatchReview({
  catalogs,
  busy,
  submit,
}: {
  catalogs: CatalogReview[];
  busy: boolean;
  submit: (suffix: string) => void;
}) {
  const styles = useStyles();
  const [suffix, setSuffix] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  return (
    <View>
      <Text style={styles.text}>
        Revisar cadastros:{' '}
        {catalogs.map((c) => c.entityType + ': ' + c.localName).join(' · ')}
      </Text>
      <Text style={styles.text}>
        Conservar ambos mantém identidades e referências distintas. Os cadastros
        locais desta lista receberão o sufixo informado.
      </Text>
      <TextInput
        style={styles.input}
        accessibilityLabel="Sufixo para nomes locais"
        value={suffix}
        onChangeText={setSuffix}
      />
      <Button
        label={
          confirmed
            ? 'Lista conferida'
            : 'Conferi a lista e desejo conservar ambos'
        }
        disabled={busy}
        onPress={() => setConfirmed(!confirmed)}
      />
      <Button
        label="Conservar a lista separadamente"
        disabled={busy || !confirmed || !suffix.trim()}
        onPress={() => submit(suffix)}
      />
    </View>
  );
}
