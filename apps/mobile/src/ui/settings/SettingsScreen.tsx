import { syncStatusTitle } from '@lionpocket/sync-local';
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Catalogs } from '@lionpocket/core';
import { syncController } from '../../sync/sync';
import { useStyles } from '../components';
import type { IconName } from '../Icon';
import { CatalogSettings, type CatalogHandlers } from './catalogs/CatalogSettings';
import { DataSettings } from './DataSettings';
import { GeneralSettings } from './GeneralSettings';
import { SettingsGroup, SettingsHeader, SettingsRow, useSettingsStyles } from './SettingsKit';
import { SyncPanel } from './sync/SyncPanel';

export type SettingsArea = 'general' | 'catalogs' | 'data' | 'sync';

const areas: { id: SettingsArea; label: string; summary: string; icon: IconName }[] = [
  { id: 'general', label: 'Geral', summary: 'Tema e exibição das prioridades', icon: 'sliders' },
  { id: 'catalogs', label: 'Cadastros', summary: 'Categorias, formas de pagamento e cartões', icon: 'catalog' },
  { id: 'data', label: 'Dados e backup', summary: 'Importar, exportar e cópias no aparelho', icon: 'data' },
  { id: 'sync', label: 'Sincronização', summary: 'Servidor, aparelhos e recuperação', icon: 'sync' },
];

/** Live one-line sync state for the settings list. */
function useSyncSummary(visible: boolean) {
  const [summary, setSummary] = useState('');
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void syncController()
      .then((c) => c.status())
      .then((status) => {
        if (!cancelled)
          setSummary(
            status.phase === 'local'
              ? 'Desativada · dados só neste aparelho'
              : syncStatusTitle(status),
          );
      })
      .catch(() => {
        /* The static summary stays visible. */
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);
  return summary;
}

/**
 * Settings as a small stack: a list of areas, each opening its own page.
 * The Android back button returns to the list before closing.
 */
export function SettingsScreen({
  catalogs,
  month,
  initialArea = null,
  onAreaChange,
  onClose,
  onDataChanged,
  onSyncChanged,
  ...catalogHandlers
}: CatalogHandlers & {
  catalogs: Catalogs;
  month: string;
  initialArea?: SettingsArea | null;
  onAreaChange?: (area: SettingsArea | null) => void;
  onClose: () => void;
  onDataChanged: () => Promise<void>;
  onSyncChanged: () => Promise<void>;
}) {
  const styles = useStyles();
  const settingsStyles = useSettingsStyles();
  const [area, setArea] = useState<SettingsArea | null>(initialArea);
  const [busy, setBusy] = useState(false);
  const syncSummary = useSyncSummary(area === null);
  const current = areas.find((item) => item.id === area);

  const go = (next: SettingsArea | null) => {
    setArea(next);
    onAreaChange?.(next);
  };
  const back = () => {
    if (busy) return;
    if (area) go(null);
    else onClose();
  };

  return (
    <Modal visible animationType="slide" onRequestClose={back}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <SettingsHeader
            title={current?.label ?? 'Configurações'}
            onBack={current ? back : undefined}
            onClose={onClose}
            disabled={busy}
          />
          <ScrollView
            key={area ?? 'home'}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={settingsStyles.page}
          >
            {!current && (
              <>
                <SettingsGroup title="Áreas">
                  {areas.map((item, index) => (
                    <SettingsRow
                      key={item.id}
                      first={index === 0}
                      icon={item.icon}
                      title={item.label}
                      description={
                        item.id === 'sync' && syncSummary ? syncSummary : item.summary
                      }
                      onPress={() => go(item.id)}
                    />
                  ))}
                </SettingsGroup>
                <Text style={settingsStyles.lead}>
                  Suas finanças ficam neste aparelho. A sincronização é opcional e
                  usa criptografia de ponta a ponta.
                </Text>
              </>
            )}
            {area === 'general' && <GeneralSettings onBusyChange={setBusy} />}
            {area === 'catalogs' && (
              <CatalogSettings catalogs={catalogs} onBusyChange={setBusy} {...catalogHandlers} />
            )}
            {area === 'data' && (
              <DataSettings month={month} onChanged={onDataChanged} onBusyChange={setBusy} />
            )}
            {area === 'sync' && <SyncPanel onChanged={onSyncChanged} />}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
