import React, { useRef, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import type { LocalPreferences } from '../../db/preferences';
import { useAppearance } from '../Appearance';
import { Choice, useStyles } from '../components';
import { SettingsGroup, SettingsRow, useSettingsStyles } from './SettingsKit';

/** Appearance and display preferences, saved on this device. */
export function GeneralSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const styles = useStyles();
  const settingsStyles = useSettingsStyles();
  const { preferences, colors, update } = useAppearance();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const save = async (patch: Partial<LocalPreferences>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      await update(patch);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Não foi possível salvar a preferência.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  return (
    <>
      <SettingsGroup title="Aparência">
        <View
          pointerEvents={busy ? 'none' : 'auto'}
          style={{ padding: 16, gap: 10 }}
        >
          <Choice
            label="Tema"
            inline
            value={preferences.theme}
            options={[
              { value: 'dark', label: 'Escuro' },
              { value: 'light', label: 'Claro' },
            ]}
            onChange={(theme) => void save({ theme: theme as 'dark' | 'light' })}
          />
          <Text style={settingsStyles.rowDescription}>
            O tema escuro é o padrão do LionPocket. A escolha vale para este aparelho.
          </Text>
        </View>
      </SettingsGroup>
      <SettingsGroup title="Exibição">
        <SettingsRow
          first
          icon="pin"
          title="Mostrar prioridades"
          description="Exibe os controles para fixar e ordenar contas. Ocultar mantém a ordem e as prioridades salvas."
          trailing={
            <Switch
              accessibilityLabel="Mostrar prioridades nos lançamentos"
              value={preferences.showPriorities}
              disabled={busy}
              trackColor={{ false: colors.lineStrong, true: colors.primary }}
              thumbColor={colors.text}
              onValueChange={(showPriorities) => void save({ showPriorities })}
            />
          }
        />
      </SettingsGroup>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </>
  );
}
