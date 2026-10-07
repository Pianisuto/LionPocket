import { serverRecoveryStep, serverRecoveryTitle } from '@lionpocket/sync-local';
import React, { useState } from 'react';
import { Text } from 'react-native';
import { Button } from '../../components';
import { SyncCard, SyncField, useSyncStyles } from './kit';
import type { SyncSession } from './useSyncSession';

/** Rebuilds the server history from this device after a server restore. */
export function ServerRecovery({ status, busy, act }: SyncSession) {
  const styles = useSyncStyles();
  const [recoveryCode, setRecoveryCode] = useState('');
  const [confirmedCode, setConfirmedCode] = useState('');
  const step = serverRecoveryStep(status.recoveryPhase);
  return (
    <SyncCard
      icon="shield"
      title={serverRecoveryTitle(status.recoveryPhase)}
      description={
        step === 'recovered'
          ? 'Este aparelho está pronto para sincronizar novamente.'
          : 'Seus dados locais estão preservados. Mantenha o aplicativo aberto durante a recuperação.'
      }
    >
      {(step === 'start' || step === 'preparing' || step === 'other') && (
        <Button
          label="Preparar recuperação neste aparelho"
          tone="primary"
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
        !!recoveryCode && (
          <>
            <Text style={styles.muted}>Guarde seu código de recuperação:</Text>
            <Text selectable style={styles.code}>
              {recoveryCode}
            </Text>
            <SyncField
              label="Confirme o código de recuperação do servidor"
              value={confirmedCode}
              onChangeText={setConfirmedCode}
            />
            <Button
              label="Guardei e conferi o código"
              tone="primary"
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
      {step === 'prepared' && (
        <>
          <Text style={styles.text}>
            Depois desta etapa, o servidor passará a usar os dados reconstruídos
            deste aparelho como nova base de sincronização.
          </Text>
          <Button
            label="Ativar sincronização recuperada"
            tone="primary"
            disabled={busy}
            onPress={() => act((c) => c.activateServerRecovery(true))}
          />
        </>
      )}
      {step === 'finalizing' && (
        <Button
          label="Continuar finalização"
          tone="primary"
          disabled={busy}
          onPress={() => act((c) => c.activateServerRecovery(false))}
        />
      )}
    </SyncCard>
  );
}
