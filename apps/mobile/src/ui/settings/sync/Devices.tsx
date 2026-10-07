import { deviceStatusLabel } from '@lionpocket/sync-local';
import React, { useState } from 'react';
import { NativeModules, Share, Text, View } from 'react-native';
import { useAppearance } from '../../Appearance';
import { Button } from '../../components';
import { Icon } from '../../Icon';
import { PairingQR, SyncCard, useSyncStyles } from './kit';
import type { SyncSession } from './useSyncSession';

/** Linked devices and, for the vault owner, adding and approving new ones. */
export function DevicesSection({ status, busy, act }: SyncSession) {
  const styles = useSyncStyles();
  const { colors } = useAppearance();
  const [adding, setAdding] = useState(false);
  const [pairingLink, setPairingLink] = useState('');
  const closeInvite = () => {
    setAdding(false);
    setPairingLink('');
  };
  const copyLink = () =>
    act(() => NativeModules.LionPocketPairing.copyLink(pairingLink));
  return (
    <SyncCard
      icon="device"
      title="Aparelhos"
      description="Aparelhos com acesso a este cofre."
    >
      <View>
        {status.devices.map((d) => (
          <View key={d.registryVersion} style={styles.row}>
            <Icon name="device" size={18} />
            <Text style={[styles.text, styles.grow]} numberOfLines={1}>
              {d.deviceId}
            </Text>
            <Text
              style={[
                styles.muted,
                d.status === 'approved' && { color: colors.positive },
              ]}
            >
              {deviceStatusLabel(d.status)}
            </Text>
          </View>
        ))}
        {!status.devices.length && (
          <Text style={styles.muted}>Nenhum aparelho listado neste momento.</Text>
        )}
      </View>
      {status.owner && (
        <>
          {!(adding && status.pairingRequests.length === 0) && (
            <Button
              label="Adicionar aparelho"
              icon="plus"
              tone="primary"
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
          {adding && status.pairingRequests.length === 0 && (
            <View style={[styles.card, { backgroundColor: colors.primaryWash }]}>
              <Text style={styles.cardTitle}>Adicionar aparelho</Text>
              {!!pairingLink && <PairingQR link={pairingLink} />}
              <Text style={styles.text}>
                Escaneie com outro celular ou abra o link no computador.
              </Text>
              <Text style={styles.muted}>
                Convite válido por 15 minutos e para um aparelho.
              </Text>
              <View style={styles.actions}>
                <Button
                  label="Compartilhar convite"
                  tone="primary"
                  onPress={() => void Share.share({ message: pairingLink })}
                />
                <Button label="Copiar link" icon="copy" onPress={copyLink} />
                <Button label="Copiar convite" onPress={copyLink} />
                <Button
                  label="Cancelar convite"
                  disabled={busy}
                  onPress={() =>
                    act(async (c) => {
                      await c.cancelInvitation();
                      closeInvite();
                    })
                  }
                />
              </View>
            </View>
          )}
          {status.pairingRequests.map((r) => (
            <View key={r.deviceId} style={[styles.card, { borderColor: colors.primary }]}>
              <View style={styles.grow}>
                <Text style={styles.cardTitle}>Novo aparelho</Text>
                <Text style={styles.text}>{r.deviceName}</Text>
                <Text style={styles.muted}>Solicitando acesso agora</Text>
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>Código de segurança</Text>
                <Text selectable style={styles.code}>
                  {r.securityCode}
                </Text>
                <Text style={styles.muted}>
                  Confira o mesmo código no novo aparelho.
                </Text>
              </View>
              <View style={styles.actions}>
                <Button
                  label="Aprovar aparelho"
                  tone="primary"
                  disabled={busy}
                  onPress={() =>
                    act(async (c) => {
                      await c.approve(r.deviceId);
                      closeInvite();
                    })
                  }
                />
                <Button
                  label="Recusar"
                  disabled={busy}
                  onPress={() =>
                    act(async (c) => {
                      await c.deny(r.deviceId);
                      closeInvite();
                    })
                  }
                />
              </View>
            </View>
          ))}
        </>
      )}
    </SyncCard>
  );
}
