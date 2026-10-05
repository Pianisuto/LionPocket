import { SeriesReviewForm } from './SeriesReview';
import { syncActivityLabel, revisionSummary } from '@lionpocket/sync-local';
import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type {
  SyncStatus,
  SeriesReview,
  CatalogReview,
} from '@lionpocket/sync-local';
import type { PairingRequest } from '@lionpocket/sync-protocol';
import { syncController, betaEndpoint } from '../sync/sync';
import { Button, useStyles } from './components';
export function SyncPanel({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const styles = useStyles(),
    [status, setStatus] = useState<SyncStatus>(),
    [endpoint, setEndpoint] = useState(betaEndpoint),
    [invitation, setInvitation] = useState(''),
    [fingerprint, setFingerprint] = useState(''),
    [authority, setAuthority] = useState(''),
    [requests, setRequests] = useState<PairingRequest[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [recoveryCode, setRecoveryCode] = useState(''),
    [confirmedCode, setConfirmedCode] = useState(''),
    [revokeId, setRevokeId] = useState(''),
    [setup, setSetup] = useState(false),
    [path, setPath] = useState<'create' | 'pair' | ''>(''),
    [advanced, setAdvanced] = useState(false),
    [adding, setAdding] = useState(false);
  const [series, setSeries] = useState<SeriesReview[]>([]),
    [catalogs, setCatalogs] = useState<CatalogReview[]>([]);
  const refresh = async () => {
    const s = await (await syncController()).status();
    setStatus(s);
    setEndpoint(s.endpoint);
    if (s.phase === 'bound') {
      const c = await syncController();
      setSeries(await c.seriesReviews());
      setCatalogs(await c.catalogReviews());
    }
  };
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let lastCompleted: string | undefined;
    {
      void refresh().catch((e) => setError(String(e)));
      void syncController().then(c => {
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
    action: (c: Awaited<ReturnType<typeof syncController>>) => Promise<unknown>,
  ) => void run(async () => action(await syncController()));
  const configured = !!status?.discovered && endpoint === status.endpoint;
  if (!status)
    return (
      <Text accessibilityRole="alert">
        {error || 'Carregando sincronização…'}
      </Text>
    );
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Sincronização</Text>
      <Text style={styles.text}>
        Seus dados ficam neste aparelho. Configure um servidor próprio para sincronizar seus aparelhos com criptografia ponta a ponta.
      </Text>
      <Text style={styles.text}>
        {syncActivityLabel[status.activity]}{!!status.sync?.pending && ` · ${status.sync.pending} alteração(ões) pendente(s)`}
      </Text>
      {status.lastCompletedAt && <Text style={styles.muted}>Último sync concluído: {new Date(status.lastCompletedAt).toLocaleString('pt-BR')}</Text>}
      {status.phase === 'bound' && <Text style={styles.muted}>Seus dados são salvos primeiro neste aparelho. A sincronização acontece enquanto o aplicativo está ativo.</Text>}
      {status.phase === 'local' && !setup && <Button label="Configurar sincronização" tone="primary" onPress={() => setSetup(true)} />}
      {status.phase === 'local' && setup && (
        <>
          <Text style={styles.text}>Servidor próprio</Text>
          <TextInput
            style={styles.input}
            accessibilityLabel="Servidor próprio"
            placeholder="https://sync.exemplo.com"
            value={endpoint}
            onChangeText={setEndpoint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Button
            label="Continuar" tone="primary"
            disabled={busy || !endpoint.trim()}
            onPress={() => act((c) => c.configure(endpoint))}
          />
          {configured && <>
            <Text style={styles.text}>Servidor próprio: {new URL(status.endpoint).host}. Login em {new URL(status.discovered!.oidc.issuer).host}.</Text>
            <Button label="Criar minha sincronização" onPress={() => setPath('create')} />
            <Button label="Tenho um convite" onPress={() => setPath('pair')} />
          </>}
          {configured && path && <>
          <Text style={styles.text}>Uma cópia de segurança será criada antes de vincular seus dados.</Text>
          <Button
            label={
              reviewed
                ? 'Base revisada. Backup e envio autorizados'
                : 'Revisar e autorizar backup e envio'
            }
            disabled={busy}
            onPress={() => setReviewed(!reviewed)}
          />
          {path === 'create' && <Button
            label="Entrar e criar cofre" tone="primary"
            disabled={busy || !reviewed}
            onPress={() => act((c) => c.create())}
          />}
          {path === 'pair' && <>
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
            label="Conferir convite"
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
                Código de segurança do cofre: {authority}
              </Text>
              <Text style={styles.text}>
                Compare no aparelho que criou o cofre.
              </Text>
              <TextInput
                style={styles.input}
                accessibilityLabel="Código de segurança do cofre conferido"
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
          </>}
          </>}
        </>
      )}
      {status.phase === 'local' && authority && (
        <>
          <Text style={styles.heading}>Recuperar cofre em nova instalação</Text>
          <TextInput
            style={styles.input}
            accessibilityLabel="Código de recuperação"
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
      {status.phase === 'recovery' && <View>
        <Text style={styles.heading}>Guarde seu código de recuperação</Text>
        <Text style={styles.text}>Este código é necessário para recuperar seus dados criptografados se você perder todos os dispositivos. Guarde-o junto do convite fora do aplicativo.</Text>
        <Button label={recoveryCode ? 'Gerar outro código' : 'Mostrar código de recuperação'} disabled={busy} onPress={() => act(async c => setRecoveryCode((await c.generateRecovery()).code))} />
        {!!recoveryCode && <>
          <Text style={styles.text} selectable>{recoveryCode}</Text>
          <Text style={styles.muted}>Guarde estas informações juntas:</Text>
          <Text style={styles.text} selectable>{`Servidor: ${status.endpoint}\nCódigo de recuperação: ${recoveryCode}\nConvite: ${status.invitation}`}</Text>
          <TextInput style={styles.input} accessibilityLabel="Digite o código que você guardou" placeholder="Digite o código que você guardou" secureTextEntry value={confirmedCode} onChangeText={setConfirmedCode} autoCapitalize="none" autoCorrect={false} />
          <Button label="Guardei o código · Ativar sincronização" tone="primary" disabled={busy || confirmedCode !== recoveryCode} onPress={() => act(async c => { await c.confirmRecovery(confirmedCode); setRecoveryCode(''); setConfirmedCode(''); })} />
        </>}
        <Text style={styles.muted}>Convite para recuperação (guarde também):</Text>
        <Text style={styles.text} selectable>{status.invitation}</Text>
      </View>}
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
            Confira e aprove no aparelho autorizado.
          </Text>
          <Button
            label="Entrar e receber chave aprovada"
            disabled={busy}
            onPress={() => act((c) => c.receive())}
          />
        </>
      )}
      {status.phase === 'bound' && (!status.recoveryPhase || status.recoveryPhase === 'recovered') && (
        <>
          {status.owner && <Button label="Adicionar dispositivo" onPress={() => setAdding(!adding)} />}
          {status.owner && adding && (
            <>
              <Text style={styles.heading}>Conectar outro aparelho</Text>
              <Text style={styles.text} selectable>
                {status.invitation}
              </Text>
              <Text style={styles.text} selectable>
                Código de segurança do cofre: {status.authorityFingerprint}
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
                Cópia restaurada: reconecte no mesmo aparelho, cofre e histórico do servidor. As
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
          <Button label={advanced ? 'Ocultar detalhes avançados' : 'Detalhes avançados e dispositivos'} onPress={() => setAdvanced(!advanced)} />
          {status.owner && advanced && (
            <>
              <Text style={styles.heading}>Recuperação e proteção</Text>
              <Text style={styles.text}>
                Versão da chave: {status.activeKeyVersion} · Recuperação
                confirmada: {status.recoveryVersion !== '0' ? 'Sim' : 'Não'}
              </Text>
              <Button
                label="Gerar código de recuperação"
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
                    accessibilityLabel="Código de recuperação guardado"
                    secureTextEntry
                    value={confirmedCode}
                    onChangeText={setConfirmedCode}
                    autoCapitalize="none"
                  />
                  <Button
                    label="Confirmar código de recuperação"
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
          {advanced && <>
          <Text style={styles.heading}>Dispositivos</Text>
          {status.devices.map((d) => (
            <Text key={d.registryVersion}>
              {d.deviceId} · {d.status}
            </Text>
          ))}
          </>}
          {status.sync?.conflicts.map((c) => (
            <View key={c.objectId}>
              <Text style={styles.heading}>Conflito financeiro</Text>
              {c.branches.map((b) => (
                <View key={b.revisionId}>
                  <Text style={styles.heading}>{revisionSummary(b.revision).title}</Text>
                  {revisionSummary(b.revision).lines.map((line, index) => <Text style={styles.text} key={index}>{line}</Text>)}
                  <Text style={styles.muted}>Alterado em {new Date(b.revision.authoredAt).toLocaleString('pt-BR')}</Text>
                  {advanced && <Text style={styles.text} selectable>{JSON.stringify(b.revision)}</Text>}
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
          {!!series.length && (
            <View>
              <Text style={styles.heading}>Preparar séries antigas</Text>
              <Text style={styles.text}>
                {series.length} série(s) ·{' '}
                {series.reduce((total, item) => total + item.slots.length, 0)} ocorrência(s).
                O LionPocket consegue reconstruir automaticamente a maioria delas sem alterar seus lançamentos.
              </Text>
              {!!series.filter((item) => item.autoResolvable).length && (
                <Button
                  label={`Resolver automaticamente ${series.filter((item) => item.autoResolvable).length} série(s)`}
                  disabled={busy}
                  onPress={() => act((c) => c.reviewSuggestedSeries(true))}
                />
              )}
              {!!series.filter((item) => !item.autoResolvable).length && (
                <Text style={styles.muted}>
                  {series.filter((item) => !item.autoResolvable).length} série(s)
                  precisam de decisões nos grupos indicados. Abra uma revisão para conferir os registros envolvidos.
                </Text>
              )}
            </View>
          )}
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
          {!!status.reviews.filter((r) => r.reason !== 'identity_unresolved').length && (
            <Text style={styles.text}>
              {status.reviews.filter((r) => r.reason !== 'identity_unresolved').length} registro(s) precisam de revisão antes de concluir a sincronização.
            </Text>
          )}
          {!!status.quarantine.length && <Text style={styles.text}>Alguns recebimentos foram preservados para revisão. Seus dados locais continuam disponíveis.</Text>}
          {advanced && <>
            {status.reviews.map(r => <Text key={String(r.review_id)}>{String(r.reason)} · {String(r.object_id)}</Text>)}
            {status.quarantine.map(q => <Text key={String(q.commit_id)}>{String(q.last_error)}</Text>)}
          </>}
        </>
      )}
      {(status.recoveryPhase || (status.anchorRecoveryAvailable && status.compatibilityMessage?.includes('histórico'))) && <View>
        <Text style={styles.muted}>{status.recoveryPhase === 'recovered' ? 'Sincronização recuperada' : status.recoveryPhase === 'prepared' ? 'Pronto para ativar' :
          status.recoveryPhase === 'activation_requested' ? 'Ativando sincronização' :
          ['remote_active','installing_local','local_db_installed','profile_installed','finalizing'].includes(status.recoveryPhase ?? '') ? 'Finalizando neste aparelho' :
          status.recoveryPhase ? 'Preparando recuperação' : 'Servidor restaurado'}</Text>
        {(!status.recoveryPhase || ['identity_reserved','secrets_prepared','recovery_pending_confirmation','recovery_confirmed','staging','staged'].includes(status.recoveryPhase)) &&
          <Button label="Preparar recuperação neste aparelho" disabled={busy} onPress={() => act(async c => {
            const result = await c.prepareServerRecovery(true); if ('code' in result) setRecoveryCode(result.code);
          })} />}
        {status.recoveryPhase === 'recovery_pending_confirmation' && recoveryCode && <>
          <Text>Guarde seu código de recuperação: {recoveryCode}</Text>
          <TextInput accessibilityLabel="Confirme o código de recuperação do servidor" value={confirmedCode} onChangeText={setConfirmedCode} />
          <Button label="Guardei e conferi o código" disabled={busy || confirmedCode !== recoveryCode} onPress={() => act(async c => {
            await c.confirmServerRecovery(confirmedCode);setRecoveryCode('');setConfirmedCode('');
          })} />
        </>}
        {status.recoveryPhase === 'prepared' && <>
          <Text>Depois desta etapa, o servidor passará a usar os dados reconstruídos deste aparelho como nova base de sincronização.</Text>
          <Button label="Ativar sincronização recuperada" tone="primary" disabled={busy} onPress={() => act(c => c.activateServerRecovery(true))} />
        </>}
        {['activation_requested','remote_active','installing_local','local_db_installed','profile_installed','finalizing'].includes(status.recoveryPhase ?? '') &&
          <Button label="Continuar finalização" disabled={busy} onPress={() => act(c => c.activateServerRecovery(false))} />}
      </View>}
      {status.compatibilityMessage && <Text accessibilityRole="alert">{status.compatibilityMessage}</Text>}
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
