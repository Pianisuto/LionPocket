import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { DevelopmentSyncStatus } from '@lionpocket/sync-local';
import { database } from '../db/connection';
import {
  AndroidDevelopmentSync,
  androidSyntheticOptIn,
} from '../sync/development';
import { androidDevelopmentOidc } from '../sync/oidc';
import { Button, useStyles } from './components';
export function DevelopmentSync({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const styles = useStyles(),
    [controller, setController] = useState<AndroidDevelopmentSync>(),
    [status, setStatus] = useState<DevelopmentSyncStatus>(),
    [pin, setPin] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (androidSyntheticOptIn())
      void database()
        .then((db) => {
          const c = new AndroidDevelopmentSync(db);
          setController(c);
          return c.status();
        })
        .then(setStatus)
        .catch(() => {});
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const result = await action();
      setNotice(
        typeof result === 'object' ? JSON.stringify(result) : String(result),
      );
      try {
        setStatus(await controller!.status());
      } catch {
        /* Pairing is pending. */
      }
      await onChanged();
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!controller) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Sync sintético de desenvolvimento</Text>
      <Text>Somente lançamentos manuais sem vínculos.</Text>
      {!status?.enabled && (
        <>
          <TextInput
            accessibilityLabel="Convite público do vault"
            multiline
            value={pin}
            onChangeText={setPin}
            placeholder="Cole o JSON público do convite"
          />
          <Button
            label="Entrar e pedir pareamento"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const session = await androidDevelopmentOidc();
                const request = await controller.pair(JSON.parse(pin), session);
                return { request, fingerprint: request.fingerprint };
              })
            }
          />
          <Button
            label="Entrar e receber chave aprovada"
            disabled={busy}
            onPress={() =>
              void run(async () =>
                controller.receive(await androidDevelopmentOidc()),
              )
            }
          />
        </>
      )}
      <Text selectable>{notice}</Text>
      {status && (
        <>
          <Text>
            Recebido: {status.received} · Aplicado: {status.applied} ·
            Pendentes: {status.pending} · Quarentena: {status.quarantined}
          </Text>
          <Button
            label="Entrar e sincronizar agora"
            disabled={busy || !status.enabled}
            onPress={() =>
              void run(async () =>
                controller.sync(await androidDevelopmentOidc()),
              )
            }
          />
          {status.conflicts.map((c) => (
            <View key={c.objectId}>
              <Text>Conflito {c.objectId}</Text>
              <Text selectable>Heads revisados: {c.heads.join(', ')}</Text>
              {c.branches.map((b) => (
                <View key={b.revisionId}>
                  <Text selectable>
                    {JSON.stringify(
                      b.revision.action === 'put'
                        ? b.revision.snapshot
                        : { action: 'delete' },
                    )}
                  </Text>
                  <Button
                    label={
                      c.deleted && b.revision.action === 'put'
                        ? 'Recuperar como novo lançamento'
                        : b.revision.action === 'delete'
                          ? 'Confirmar exclusão'
                          : 'Usar este ramo'
                    }
                    disabled={busy}
                    onPress={() =>
                      void run(() =>
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
        </>
      )}
    </View>
  );
}
