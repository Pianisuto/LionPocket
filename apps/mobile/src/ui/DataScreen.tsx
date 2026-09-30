import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { captureBackup } from '../db/backupRepository';
import { database } from '../db/connection';
import {
  commitImport,
  exportLocal,
  prepareImport,
  recoveryBackup,
  type PreparedImport,
} from '../files/localData';
import { localFiles, type RecoveryFile } from '../files/native';
import { Button, ScreenHeader, useStyles } from './components';
export function DataScreen({
  month,
  onClose,
  onChanged,
}: {
  month: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [backups, setBackups] = useState<RecoveryFile[]>([]);
  const [prepared, setPrepared] = useState<PreparedImport | null>(null);
  const [existingCount, setExistingCount] = useState(0);
  const refreshBackups = async () => setBackups(await localFiles.listBackups());
  useEffect(() => {
    void refreshBackups().catch((cause) => setError(String(cause)));
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível concluir a operação local.',
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const review = async (
    file: Awaited<ReturnType<typeof localFiles.pickFile>>,
  ) => {
    if (!file) {
      setNotice('Seleção cancelada.');
      return;
    }
    setPrepared(null);
    const next = await prepareImport(file);
    const current = await captureBackup(await database());
    setExistingCount(current.data.transactions.length);
    setPrepared(next);
  };
  const confirm = () => {
    if (!prepared || busy) return;
    Alert.alert(
      prepared.mode === 'restore'
        ? 'Substituir os dados locais?'
        : 'Confirmar importação?',
      prepared.mode === 'restore'
        ? `Todos os dados locais serão substituídos por “${prepared.fileName}”, incluindo lançamentos, cadastros, séries, objetivos, prioridades e preferências. Há ${existingCount} registro(s) de lançamentos no banco atual. Antes da troca, uma cópia de recuperação será salva neste aparelho. Se a cópia ou a gravação falhar, a restauração será interrompida.`
        : `Adicionar dados de “${prepared.fileName}”? Registros existentes serão preservados. Itens já importados serão ignorados; conflitos de IDs interrompem a operação. Uma cópia de recuperação será salva antes da importação.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text:
            prepared.mode === 'restore'
              ? 'Substituir e restaurar'
              : 'Adicionar dados',
          style: prepared.mode === 'restore' ? 'destructive' : 'default',
          onPress: () =>
            void run(async () => {
              const result = await commitImport(prepared);
              setPrepared(null);
              setNotice(result);
              await refreshBackups();
              await onChanged();
            }),
        },
      ],
    );
  };
  const exportFile = (
    format: 'json' | 'csv' | 'sqlite',
    selectedMonth?: string,
  ) =>
    void run(async () => {
      const saved = await exportLocal(format, selectedMonth);
      setNotice(
        saved ? 'Arquivo salvo no local escolhido.' : 'Exportação cancelada.',
      );
    });
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <SafeAreaView style={styles.safe}>
        <ScreenHeader
          title={'Dados locais'}
          onClose={onClose}
          disabled={busy}
        />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.muted}>
            Arquivos locais pelo seletor do Android. O LionPocket funciona sem
            internet e sem conta.
          </Text>
          {busy && (
            <ActivityIndicator accessibilityLabel="Processando arquivo local" />
          )}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {notice ? (
            <Text accessibilityLiveRegion="polite" style={styles.positive}>
              {notice}
            </Text>
          ) : null}
          <View style={styles.card}>
            <Text style={styles.heading}>Exportar</Text>
            <Button
              label="Exportar JSON completo"
              disabled={busy}
              onPress={() => exportFile('json')}
            />
            <Button
              label="Exportar CSV do mês"
              disabled={busy}
              onPress={() => exportFile('csv', month)}
            />
            <Button
              label="Exportar CSV de todos os lançamentos"
              disabled={busy}
              onPress={() => exportFile('csv')}
            />
            <Button
              label="Salvar backup SQLite em arquivo"
              disabled={busy}
              onPress={() => exportFile('sqlite')}
            />
            <Text style={styles.muted}>
              JSON e SQLite preservam registros, datas de realização,
              prioridades, planejamento, preferências e marcadores de exclusão.
              CSV segue as colunas do desktop e exporta por vencimento; não
              inclui séries, prioridades nem a data de realização. Use JSON ou
              SQLite para restauração completa.
            </Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.heading}>Importar ou restaurar</Text>
            <Button
              label="Escolher arquivo local"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await review(await localFiles.pickFile());
                })
              }
            />
            <Text style={styles.muted}>
              CSV de lançamentos e XLSX do modelo financeiro do desktop
              adicionam dados. JSON do desktop importa sem substituir. JSON e
              SQLite do Mobile restauram o banco completo após confirmação.
            </Text>
            <Text style={styles.muted}>
              Backups antigos do Mobile são migrados em uma cópia antes da
              restauração. Arquivos inválidos e versões futuras são recusados.
              Lançamentos e recorrências aceitam valor planejado zero. Parcelas
              precisam ter valor positivo.
            </Text>
            {prepared && (
              <>
                <Text selectable style={styles.heading}>
                  {prepared.fileName}
                </Text>
                <Text style={styles.text}>
                  {prepared.mode === 'restore'
                    ? 'Restauração completa · substitui os dados'
                    : 'Importação · adiciona dados'}
                </Text>
                {prepared.backup && (
                  <Text style={styles.muted}>
                    {prepared.backup.data.transactions.length} registro(s) de
                    lançamentos ·{' '}
                    {prepared.backup.data.recurring_expenses.length}{' '}
                    recorrência(s) ·{' '}
                    {prepared.backup.data.installment_purchases.length}{' '}
                    compra(s) parcelada(s) · {prepared.backup.data.goals.length}{' '}
                    objetivo(s)
                  </Text>
                )}
                {prepared.sourceVersion !== undefined && (
                  <Text style={styles.muted}>
                    Banco de origem: versão {prepared.sourceVersion}. A cópia
                    está pronta na versão {prepared.backup?.schemaVersion}.
                    {prepared.mode === 'restore' && prepared.sourceVersion < 5
                      ? ' Este backup não contém preferências; serão usados os padrões de tema e do Léo.'
                      : ''}
                  </Text>
                )}
                {prepared.counts && (
                  <Text style={styles.text}>
                    {prepared.counts.transactions} lançamento(s),{' '}
                    {prepared.counts.recurring} recorrência(s),{' '}
                    {prepared.counts.goals} objetivo(s) e{' '}
                    {prepared.counts.catalogs} cadastro(s) novos.{' '}
                    {prepared.counts.skipped} já existente(s) ignorado(s).
                  </Text>
                )}
                {prepared.added !== undefined && (
                  <Text style={styles.text}>
                    {prepared.added} registro(s) novo(s), {prepared.skipped} já
                    existente(s) ignorado(s).
                  </Text>
                )}
                <Button
                  label={
                    prepared.mode === 'restore'
                      ? 'Restaurar dados'
                      : 'Importar dados'
                  }
                  tone={prepared.mode === 'restore' ? 'danger' : 'primary'}
                  disabled={busy}
                  onPress={confirm}
                />
                <Button
                  label="Descartar seleção"
                  disabled={busy}
                  onPress={() => setPrepared(null)}
                />
              </>
            )}
          </View>
          <View style={styles.card}>
            <Text style={styles.heading}>Cópias no aparelho</Text>
            <Button
              label="Criar cópia no aparelho"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await recoveryBackup();
                  await refreshBackups();
                  setNotice('Cópia local criada.');
                })
              }
            />
            <Text style={styles.muted}>
              Inclui as cópias automáticas anteriores a importações e
              restaurações. Para guardar fora do app, salve em arquivo.
              Desinstalar ou limpar o armazenamento remove estas cópias.
            </Text>
            {!backups.length && (
              <Text style={styles.muted}>Nenhuma cópia neste aparelho.</Text>
            )}
            {backups.map((file) => (
              <View key={file.name} style={styles.card}>
                <Text style={styles.text}>
                  {new Date(file.createdAt).toLocaleString('pt-BR')}
                </Text>
                <Text style={styles.muted}>
                  {Math.ceil(file.size / 1024)} KB
                </Text>
                <Button
                  label="Revisar esta cópia"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await review(await localFiles.copyBackup(file.name));
                    })
                  }
                />
                <Button
                  label="Salvar esta cópia em arquivo"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      const saved = await localFiles.saveFile(
                        file.location,
                        file.name,
                        'application/octet-stream',
                        file.name,
                      );
                      setNotice(
                        saved
                          ? 'Cópia salva no local escolhido.'
                          : 'Exportação cancelada.',
                      );
                    })
                  }
                />
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
