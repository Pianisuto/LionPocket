import { SyncPanel } from './SyncPanel';
import React, { useRef, useState } from 'react';
import { Modal, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppearance } from './Appearance';
import { Choice, ScreenHeader, useStyles } from './components';
import type { LocalPreferences } from '../db/preferences';

export function PreferencesScreen({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const styles = useStyles(),
    { preferences, colors, update } = useAppearance();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  const save = async (patch: Partial<LocalPreferences>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await update(patch);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível salvar a preferência.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <SafeAreaView style={styles.safe}>
        <ScreenHeader title="Preferências" onClose={onClose} disabled={busy} />
        <ScrollView contentContainerStyle={styles.content}>
          <View pointerEvents={busy ? 'none' : 'auto'} style={styles.card}>
            <Choice
              label="Tema"
              inline
              value={preferences.theme}
              options={[
                { value: 'dark', label: 'Escuro' },
                { value: 'light', label: 'Claro' },
              ]}
              onChange={(theme) =>
                void save({ theme: theme as 'dark' | 'light' })
              }
            />
          </View>
          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={[styles.heading, { flex: 1 }]}>
                Mostrar prioridades
              </Text>
              <Switch
                accessibilityLabel="Mostrar prioridades nos lançamentos"
                value={preferences.showPriorities}
                disabled={busy}
                trackColor={{ false: colors.lineStrong, true: colors.primary }}
                thumbColor={colors.text}
                onValueChange={(showPriorities) =>
                  void save({ showPriorities })
                }
              />
            </View>
            <Text style={styles.muted}>
              Exibe os controles para fixar e ordenar contas. Ocultar mantém a
              ordem e as prioridades salvas.
            </Text>
          </View>
          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <SyncPanel onChanged={onChanged} />
          <View style={styles.card}>
            <Text style={styles.heading}>Privacidade local</Text>
            <Text style={styles.text}>
              Suas finanças ficam no banco deste aparelho. O LionPocket funciona
              sem internet. Você pode optar por sincronizar dados criptografados com seu servidor.
            </Text>
            <Text style={styles.muted}>
              O banco e as cópias privadas são protegidos pelo armazenamento do
              Android. Você escolhe onde salvar os arquivos exportados.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
