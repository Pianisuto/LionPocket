import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useAppearance } from '../../Appearance';
import { Button } from '../../components';
import { SyncDisclosure, SyncField, SyncNotice, useSyncStyles } from './kit';
import type { SyncSession } from './useSyncSession';

/** Recovery code and key management for the vault owner. */
export function ProtectionSection({ status, busy, act }: SyncSession) {
  const styles = useSyncStyles();
  const { colors } = useAppearance();
  const [open, setOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [confirmedCode, setConfirmedCode] = useState('');
  const [revokeId, setRevokeId] = useState('');
  const confirmed = status.recoveryVersion !== '0';
  return (
    <>
      {!confirmed && (
        <View style={styles.panel}>
          <SyncNotice tone="warning">
            Proteja seu cofre: guarde um código de recuperação caso perca todos
            os aparelhos.
          </SyncNotice>
          {!open && (
            <Button
              label="Proteger meu cofre"
              icon="shield"
              onPress={() => setOpen(true)}
            />
          )}
        </View>
      )}
      <SyncDisclosure
        icon="lock"
        title="Recuperação e proteção"
        description="Guarde o acesso ao cofre e gerencie as chaves dos seus aparelhos."
        open={open}
        onToggle={() => setOpen(!open)}
      >
        <View style={styles.card}>
          <Text style={[styles.strong, confirmed && { color: colors.positive }]}>
            Recuperação {confirmed ? 'confirmada' : 'não confirmada'}
          </Text>
          <Text style={styles.muted}>
            Versão da chave: {status.activeKeyVersion}
          </Text>
          {!!status.recoveryPackage && (
            <View style={styles.field}>
              <Text style={styles.label}>
                Pacote atual · guarde com o código e atualize a cópia após
                recuperar o servidor.
              </Text>
              <Text style={styles.text} selectable>
                {status.recoveryPackage}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Código de recuperação</Text>
          <Text style={styles.muted}>
            Guarde o segredo fora do app. Ele recupera os dados e a autoridade.
          </Text>
          <Button
            label="Gerar código de recuperação"
            disabled={busy}
            onPress={() =>
              act(async (c) => setRecoveryCode((await c.generateRecovery()).code))
            }
          />
          {!!recoveryCode && (
            <>
              <Text style={styles.code} selectable>
                {`Pacote de recuperação: ${status.recoveryPackage}\nCódigo de recuperação: ${recoveryCode}`}
              </Text>
              <SyncField
                label="Código de recuperação guardado"
                secureTextEntry
                value={confirmedCode}
                onChangeText={setConfirmedCode}
              />
              <Button
                label="Confirmar código de recuperação"
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
        </View>
        <SyncDisclosure
          icon="shield"
          title="Gerenciar chaves e acesso"
          description="Opções avançadas de proteção do cofre."
          open={keysOpen}
          onToggle={() => setKeysOpen(!keysOpen)}
        >
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Atualizar a chave</Text>
            <Text style={styles.muted}>
              Gere uma nova versão da chave e retome uma operação pendente.
            </Text>
            <Button
              label="Rotacionar chave e retomar operação pendente"
              disabled={busy}
              onPress={() => act((c) => c.rotateKeys())}
            />
          </View>
          <View style={[styles.card, styles.cardDanger]}>
            <Text style={[styles.cardTitle, { color: colors.alert }]}>
              Remover o acesso de um aparelho
            </Text>
            <Text style={styles.muted}>
              O aparelho será revogado e a chave do cofre será atualizada.
              Confira o identificador na lista de Aparelhos.
            </Text>
            <SyncField
              label="ID do aparelho a revogar"
              value={revokeId}
              onChangeText={setRevokeId}
            />
            <Button
              label="Revogar aparelho e rotacionar chave"
              tone="danger"
              disabled={busy || !revokeId}
              onPress={() => act((c) => c.revoke(revokeId, revokeId))}
            />
          </View>
        </SyncDisclosure>
      </SyncDisclosure>
    </>
  );
}
