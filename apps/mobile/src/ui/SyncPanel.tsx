import {
  syncActivityLabel,
  revisionSummary,
  pairingQr,
} from '@lionpocket/sync-local';
import React, { useEffect, useState } from 'react';
import {
  Text,
  TextInput,
  View,
  Share,
  NativeModules,
  Image,
} from 'react-native';
import type { SyncStatus } from '@lionpocket/sync-local';
import { pairingErrorMessage } from '@lionpocket/sync-protocol';
import { syncController, betaEndpoint } from '../sync/sync';
import { Button, useStyles } from './components';
export function SyncPanel({
  onChanged,
  initialInvitation,
}: {
  onChanged: () => Promise<void>;
  initialInvitation?: string;
}) {
  const styles = useStyles(),
    [status, setStatus] = useState<SyncStatus>(),
    [endpoint, setEndpoint] = useState(betaEndpoint),
    [invitation, setInvitation] = useState(initialInvitation ?? ''),
    [inviteInfo, setInviteInfo] = useState<{ id: string; endpoint: string }>(),
    [pairingLink, setPairingLink] = useState(''),
    [fingerprint, setFingerprint] = useState(''),
    [authority, setAuthority] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [recoveryCode, setRecoveryCode] = useState(''),
    [confirmedCode, setConfirmedCode] = useState(''),
    [revokeId, setRevokeId] = useState(''),
    [setup, setSetup] = useState(false),
    [advanced, setAdvanced] = useState(false),
    [adding, setAdding] = useState(false);
  const refresh = async () => {
    const s = await (await syncController()).status();
    setStatus(s);
    setEndpoint(s.endpoint);
  };
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let lastCompleted: string | undefined;
    {
      void refresh().catch((e) => setError(pairingErrorMessage(e)));
      void syncController()
        .then((c) => {
          if (!disposed)
            unsubscribe = c.subscribe(() => {
              void refresh().catch(() => {
                /* Status remains best effort; local use continues. */
              });
              if (
                c.coordinator.lastCompletedAt &&
                c.coordinator.lastCompletedAt !== lastCompleted
              ) {
                lastCompleted = c.coordinator.lastCompletedAt;
                void onChanged().catch(() => {
                  /* Refresh cannot affect saved data. */
                });
              }
            });
        })
        .catch(() => {
          /* Status remains best effort; local use continues. */
        });
    }
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
      await onChanged();
    } catch (e) {
      setError(pairingErrorMessage(e));
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
  useEffect(() => {
    let cancelled = false;
    setInviteInfo(undefined);
    if (invitation.trim())
      void syncController()
        .then((c) => c.inspectPairingInvitation(invitation))
        .then((info) => {
          if (!cancelled) {
            setInviteInfo(info);
            setError('');
          }
        })
        .catch((e) => {
          if (!cancelled) setError(pairingErrorMessage(e));
        });
    return () => {
      cancelled = true;
    };
  }, [invitation]);
  if (!status)
    return (
      <Text accessibilityRole="alert">
        {error || 'Carregando sincronização…'}
      </Text>
    );
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>
        {initialInvitation ? 'Conectar aparelho' : 'Sincronização'}
      </Text>
      <Text style={styles.text}>
        {initialInvitation
          ? 'Seu acesso será liberado depois da aprovação no aparelho conectado.'
          : 'Conecte seus aparelhos para manter seus dados atualizados, com criptografia de ponta a ponta.'}
      </Text>
      {(!initialInvitation || status.phase !== 'local') && (
        <Text style={styles.text}>
          {syncActivityLabel[status.activity]}
          {!!status.sync?.pending &&
            ` · ${status.sync.pending} alteração(ões) pendente(s)`}
        </Text>
      )}
      {status.lastCompletedAt && (
        <Text style={styles.muted}>
          Último sync concluído:{' '}
          {new Date(status.lastCompletedAt).toLocaleString('pt-BR')}
        </Text>
      )}
      {status.phase === 'bound' && (
        <Text style={styles.muted}>
          Seus dados são salvos primeiro neste aparelho. A sincronização
          acontece enquanto o aplicativo está ativo.
        </Text>
      )}
      {status.phase === 'local' && status.pairingStep === 'preparing' && (
        <Text style={styles.text}>Preparando conexão…</Text>
      )}
      {status.phase === 'local' &&
        !setup &&
        !invitation &&
        !initialInvitation && (
          <Button
            label="Configurar sincronização"
            tone="primary"
            onPress={() => setSetup(true)}
          />
        )}
      {status.phase === 'local' &&
        (setup || !!initialInvitation) &&
        !invitation && (
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
              label="Conectar"
              tone="primary"
              disabled={busy || !endpoint.trim()}
              onPress={() =>
                act(async (c) => {
                  await c.configure(endpoint);
                  await c.create();
                })
              }
            />
          </>
        )}
      {status.phase === 'local' && (
        <>
          {!initialInvitation && (
            <>
              <Button
                label="Escanear QR Code"
                disabled={busy}
                onPress={() =>
                  act(async () =>
                    setInvitation(await NativeModules.LionPocketPairing.scan()),
                  )
                }
              />
              <TextInput
                style={styles.input}
                accessibilityLabel="Convite do cofre"
                placeholder="Ou cole o convite do outro aparelho"
                value={invitation}
                onChangeText={setInvitation}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </>
          )}
          {inviteInfo && (
            <>
              <Text style={styles.heading}>Conectar ao cofre pessoal</Text>
              <Text style={styles.text}>
                {new URL(inviteInfo.endpoint).host}
              </Text>
              <Text style={styles.muted}>
                O outro aparelho precisa aprovar seu acesso.
              </Text>
              <Button
                label="Conectar"
                tone="primary"
                disabled={busy}
                onPress={() => act((c) => c.connectInvitation(invitation))}
              />
            </>
          )}
          {!initialInvitation && (
            <Button
              label="Recuperação de um cofre antigo"
              onPress={() => setAdvanced(!advanced)}
            />
          )}
          {advanced && (
            <Button
              label="Verificar convite de recuperação"
              disabled={busy || !invitation}
              onPress={() =>
                act(async (c) => {
                  const info = await c.inspectInvitation(invitation);
                  setAuthority(info.fingerprint);
                  setFingerprint(info.fingerprint);
                })
              }
            />
          )}
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
      {status.phase === 'recovery' && (
        <View>
          <Text style={styles.heading}>Guarde seu código de recuperação</Text>
          <Text style={styles.text}>
            Este código é necessário para recuperar seus dados criptografados se
            você perder todos os dispositivos. Guarde-o junto do convite fora do
            aplicativo.
          </Text>
          <Button
            label={
              recoveryCode
                ? 'Gerar outro código'
                : 'Mostrar código de recuperação'
            }
            disabled={busy}
            onPress={() =>
              act(async (c) =>
                setRecoveryCode((await c.generateRecovery()).code),
              )
            }
          />
          {!!recoveryCode && (
            <>
              <Text style={styles.text} selectable>
                {recoveryCode}
              </Text>
              <Text style={styles.muted}>Guarde estas informações juntas:</Text>
              <Text
                style={styles.text}
                selectable
              >{`Servidor: ${status.endpoint}\nCódigo de recuperação: ${recoveryCode}\nConvite: ${status.invitation}`}</Text>
              <TextInput
                style={styles.input}
                accessibilityLabel="Digite o código que você guardou"
                placeholder="Digite o código que você guardou"
                secureTextEntry
                value={confirmedCode}
                onChangeText={setConfirmedCode}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Button
                label="Guardei o código · Ativar sincronização"
                tone="primary"
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
          <Text style={styles.muted}>
            Convite para recuperação (guarde também):
          </Text>
          <Text style={styles.text} selectable>
            {status.invitation}
          </Text>
        </View>
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
          <Text style={styles.heading}>
            {status.pairingStep === 'preparing'
              ? 'Preparando conexão…'
              : status.pairingStep === 'connecting'
                ? 'Conectando…'
                : 'Aguardando aprovação no outro aparelho'}
          </Text>
          <Text style={styles.text}>
            Código de segurança: {status.pairingCode}
          </Text>
          <Text style={styles.muted}>
            Confira o mesmo código no aparelho conectado antes de aprovar.
          </Text>
          {status.pairingError &&
            /^(Convite|Pedido recusado|Este convite)/.test(
              status.pairingError,
            ) &&
            !initialInvitation && (
              <TextInput
                style={styles.input}
                accessibilityLabel="Novo convite do cofre"
                placeholder="Cole um novo convite do aparelho conectado"
                value={invitation}
                onChangeText={setInvitation}
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}
          {inviteInfo && inviteInfo.id !== status.pairingInviteId && (
            <>
              <Text style={styles.heading}>Conectar ao cofre pessoal</Text>
              <Text style={styles.text}>
                {new URL(inviteInfo.endpoint).host}
              </Text>
              <Button
                label="Conectar"
                tone="primary"
                disabled={busy}
                onPress={() => act((c) => c.connectInvitation(invitation))}
              />
            </>
          )}
        </>
      )}
      {status.phase === 'bound' && (
        <Text style={styles.heading}>
          {status.lastCompletedAt
            ? 'Sincronização pronta'
            : 'Sincronizando dados…'}
        </Text>
      )}
      {status.phase === 'bound' &&
        (!status.recoveryPhase || status.recoveryPhase === 'recovered') && (
          <>
            {status.owner && (
              <Button
                label="Adicionar aparelho"
                disabled={busy}
                onPress={() =>
                  act(async (c) => {
                    const result = await c.createInvitation();
                    setPairingLink(result.link);
                    setAdding(true);
                  })
                }
              />
            )}
            {status.owner && adding && status.pairingRequests.length === 0 && (
              <>
                <Text style={styles.heading}>Escaneie no outro aparelho</Text>
                {!!pairingLink && <PairingQR link={pairingLink} />}
                <Text style={styles.muted}>
                  Convite válido por 15 minutos e para um aparelho.
                </Text>
                <Button
                  label="Compartilhar convite"
                  onPress={() => void Share.share({ message: pairingLink })}
                />
                <Text style={styles.text} selectable>
                  {pairingLink}
                </Text>
                <Button
                  label="Cancelar convite"
                  disabled={busy}
                  onPress={() =>
                    act(async (c) => {
                      await c.cancelInvitation();
                      setAdding(false);
                      setPairingLink('');
                    })
                  }
                />
              </>
            )}
            {status.owner &&
              status.pairingRequests.map((r) => (
                <View key={r.deviceId} style={styles.card}>
                  <Text style={styles.heading}>Novo aparelho</Text>
                  <Text style={styles.text}>{r.deviceName}</Text>
                  <Text style={styles.muted}>Solicitando acesso agora</Text>
                  <Text style={styles.text}>
                    Código de segurança: {r.securityCode}
                  </Text>
                  <Text style={styles.muted}>
                    Confira o mesmo código no novo aparelho.
                  </Text>
                  <Button
                    label="Recusar"
                    disabled={busy}
                    onPress={() =>
                      act(async (c) => {
                        await c.deny(r.deviceId);
                        setAdding(false);
                        setPairingLink('');
                      })
                    }
                  />
                  <Button
                    label="Aprovar aparelho"
                    tone="primary"
                    disabled={busy}
                    onPress={() =>
                      act(async (c) => {
                        await c.approve(r.deviceId);
                        setAdding(false);
                        setPairingLink('');
                      })
                    }
                  />
                </View>
              ))}
            {status.owner && status.recoveryVersion === '0' && (
              <>
                <Text accessibilityRole="alert" style={styles.text}>
                  Proteja seu cofre: guarde um código de recuperação caso perca
                  todos os aparelhos.
                </Text>
                <Button
                  label="Proteger meu cofre"
                  onPress={() => setAdvanced(true)}
                />
              </>
            )}
            {status.restoreReview && (
              <>
                <Text style={styles.text}>
                  Cópia restaurada: reconecte no mesmo aparelho, cofre e
                  histórico do servidor. As diferenças locais serão rascunhos;
                  receba e revise o remoto antes de liberar envio.
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
            <Button
              label={
                advanced
                  ? 'Ocultar detalhes avançados'
                  : 'Detalhes avançados e dispositivos'
              }
              onPress={() => setAdvanced(!advanced)}
            />
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
            {advanced && (
              <>
                <Text style={styles.heading}>Dispositivos</Text>
                {status.devices.map((d) => (
                  <Text key={d.registryVersion}>
                    {d.deviceId} · {d.status}
                  </Text>
                ))}
              </>
            )}
            {status.sync?.conflicts.map((c) => (
              <View key={c.objectId}>
                <Text style={styles.heading}>Conflito financeiro</Text>
                {c.branches.map((b) => (
                  <View key={b.revisionId}>
                    <Text style={styles.heading}>
                      {revisionSummary(b.revision).title}
                    </Text>
                    {revisionSummary(b.revision).lines.map((line, index) => (
                      <Text style={styles.text} key={index}>
                        {line}
                      </Text>
                    ))}
                    <Text style={styles.muted}>
                      Alterado em{' '}
                      {new Date(b.revision.authoredAt).toLocaleString('pt-BR')}
                    </Text>
                    {advanced && (
                      <Text style={styles.text} selectable>
                        {JSON.stringify(b.revision)}
                      </Text>
                    )}
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
            {status.reviews
              .filter((r) => r.reason === 'restored_missing_record')
              .map((r) => (
                <View key={String(r.review_id)}>
                  <Text style={styles.text}>
                    A cópia restaurada não contém este registro. Confirme a
                    exclusão somente se deseja removê-lo dos outros aparelhos.
                  </Text>
                  <Button
                    disabled={busy}
                    label="Confirmar exclusão agora"
                    onPress={() =>
                      act((c) =>
                        c.confirmLegacyDeletion(String(r.object_id), true),
                      )
                    }
                  />
                </View>
              ))}
            {!!status.reviews.length && (
              <Text style={styles.text}>
                {status.reviews.length} registro(s) precisam de revisão antes de
                concluir a sincronização.
              </Text>
            )}
            {!!status.quarantine.length && (
              <Text style={styles.text}>
                Alguns recebimentos foram preservados para revisão. Seus dados
                locais continuam disponíveis.
              </Text>
            )}
            {advanced && (
              <>
                {status.reviews.map((r) => (
                  <Text key={String(r.review_id)}>
                    {String(r.reason)} · {String(r.object_id)}
                  </Text>
                ))}
                {status.quarantine.map((q) => (
                  <Text key={String(q.commit_id)}>{String(q.last_error)}</Text>
                ))}
              </>
            )}
          </>
        )}
      {(status.recoveryPhase ||
        (status.anchorRecoveryAvailable &&
          status.compatibilityMessage?.includes('histórico'))) && (
        <View>
          <Text style={styles.muted}>
            {status.recoveryPhase === 'recovered'
              ? 'Sincronização recuperada'
              : status.recoveryPhase === 'prepared'
                ? 'Pronto para ativar'
                : status.recoveryPhase === 'activation_requested'
                  ? 'Ativando sincronização'
                  : [
                        'remote_active',
                        'installing_local',
                        'local_db_installed',
                        'profile_installed',
                        'finalizing',
                      ].includes(status.recoveryPhase ?? '')
                    ? 'Finalizando neste aparelho'
                    : status.recoveryPhase
                      ? 'Preparando recuperação'
                      : 'Servidor restaurado'}
          </Text>
          {(!status.recoveryPhase ||
            [
              'identity_reserved',
              'secrets_prepared',
              'recovery_pending_confirmation',
              'recovery_confirmed',
              'staging',
              'staged',
            ].includes(status.recoveryPhase)) && (
            <Button
              label="Preparar recuperação neste aparelho"
              disabled={busy}
              onPress={() =>
                act(async (c) => {
                  const result = await c.prepareServerRecovery(true);
                  if ('code' in result) setRecoveryCode(result.code);
                })
              }
            />
          )}
          {status.recoveryPhase === 'recovery_pending_confirmation' &&
            recoveryCode && (
              <>
                <Text>Guarde seu código de recuperação: {recoveryCode}</Text>
                <TextInput
                  accessibilityLabel="Confirme o código de recuperação do servidor"
                  value={confirmedCode}
                  onChangeText={setConfirmedCode}
                />
                <Button
                  label="Guardei e conferi o código"
                  disabled={busy || confirmedCode !== recoveryCode}
                  onPress={() =>
                    act(async (c) => {
                      await c.confirmServerRecovery(confirmedCode);
                      setRecoveryCode('');
                      setConfirmedCode('');
                    })
                  }
                />
              </>
            )}
          {status.recoveryPhase === 'prepared' && (
            <>
              <Text>
                Depois desta etapa, o servidor passará a usar os dados
                reconstruídos deste aparelho como nova base de sincronização.
              </Text>
              <Button
                label="Ativar sincronização recuperada"
                tone="primary"
                disabled={busy}
                onPress={() => act((c) => c.activateServerRecovery(true))}
              />
            </>
          )}
          {[
            'activation_requested',
            'remote_active',
            'installing_local',
            'local_db_installed',
            'profile_installed',
            'finalizing',
          ].includes(status.recoveryPhase ?? '') && (
            <Button
              label="Continuar finalização"
              disabled={busy}
              onPress={() => act((c) => c.activateServerRecovery(false))}
            />
          )}
        </View>
      )}
      {status.pairingError && status.phase === 'pairing' && (
        <Text accessibilityRole="alert">{status.pairingError}</Text>
      )}
      {status.compatibilityMessage && (
        <Text accessibilityRole="alert">{status.compatibilityMessage}</Text>
      )}
      {!!error && <Text accessibilityRole="alert">{error}</Text>}
    </View>
  );
}

function PairingQR({ link }: { link: string }) {
  const [uri, setUri] = useState('');
  useEffect(() => {
    let cancelled = false;
    const rows = pairingQr(link).map((row) =>
      row.map((dark) => (dark ? '1' : '0')).join(''),
    );
    void NativeModules.LionPocketPairing.renderQr(rows)
      .then((value: string) => {
        if (!cancelled) setUri(value);
      })
      .catch(() => {
        /* Sharing the same local invitation stays available. */
      });
    return () => {
      cancelled = true;
    };
  }, [link]);
  return uri ? (
    <Image
      accessibilityLabel="QR Code para conectar outro aparelho"
      source={{ uri }}
      style={{
        width: 280,
        height: 280,
        alignSelf: 'center',
        backgroundColor: '#fff',
      }}
    />
  ) : (
    <Text>Preparando QR Code…</Text>
  );
}
