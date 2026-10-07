import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { captureBackup } from '../../db/backupRepository';
import { database } from '../../db/connection';
import {
  commitImport,
  exportLocal,
  prepareImport,
  recoveryBackup,
  type PreparedImport,
} from '../../files/localData';
import { localFiles, type RecoveryFile } from '../../files/native';
import { useAppearance } from '../Appearance';
import { Button, useStyles } from '../components';
import { SettingsGroup, SettingsNote, SettingsRow, useSettingsStyles } from './SettingsKit';

const monthLabel = (month: string) =>
  new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(
    new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 15),
  );

/** Import, export and on-device copies. Everything goes through the Android file picker. */
export function DataSettings({
  month,
  onChanged,
  onBusyChange,
}: {
  month: string;
  onChanged: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const styles = useStyles();
  const settingsStyles = useSettingsStyles();
  const { colors } = useAppearance();
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
    onBusyChange(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Não foi possível concluir a operação local.',
      );
    } finally {
      running.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  const review = async (file: Awaited<ReturnType<typeof localFiles.pickFile>>) => {
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
      prepared.mode === 'restore' ? 'Substituir os dados locais?' : 'Confirmar importação?',
      prepared.mode === 'restore'
        ? `Todos os dados locais serão substituídos por “${prepared.fileName}”, incluindo lançamentos, cadastros, séries, objetivos, prioridades e preferências. Há ${existingCount} registro(s) de lançamentos no banco atual. Antes da troca, uma cópia de recuperação será salva neste aparelho. Se a cópia ou a gravação falhar, a restauração será interrompida.`
        : `Adicionar dados de “${prepared.fileName}”? Registros existentes serão preservados. Somente linhas com proveniência já importada serão ignoradas. Categorias, cartões e formas de pagamento de mesmo nome serão associados aos cadastros locais: confira essa decisão antes de adicionar. Recorrências e objetivos de nomes iguais serão registros distintos; conflitos de IDs interrompem a operação. Uma cópia de recuperação será salva antes da importação.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: prepared.mode === 'restore' ? 'Substituir e restaurar' : 'Adicionar dados',
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
  const exportFile = (format: 'json' | 'csv' | 'sqlite', selectedMonth?: string) =>
    void run(async () => {
      const saved = await exportLocal(format, selectedMonth);
      setNotice(saved ? 'Arquivo salvo no local escolhido.' : 'Exportação cancelada.');
    });

  return (
    <>
      <Text style={settingsStyles.lead}>
        Importe, exporte e guarde cópias usando o seletor de arquivos do
        Android.
      </Text>
      {busy && (
        <ActivityIndicator color={colors.primary} accessibilityLabel="Processando arquivo local" />
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!!notice && (
        <Text accessibilityLiveRegion="polite" style={settingsStyles.notice}>
          {notice}
        </Text>
      )}

      <SettingsGroup title="Importar ou restaurar">
        <SettingsRow
          first
          icon="upload"
          title="Escolher arquivo local"
          description="CSV e XLSX do desktop adicionam dados. JSON e SQLite do Mobile restauram o banco completo após confirmação."
          disabled={busy}
          onPress={() => void run(async () => review(await localFiles.pickFile()))}
        />
        {prepared && (
          <View style={{ padding: 16, gap: 10, borderTopWidth: 1, borderTopColor: colors.line }}>
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
                {prepared.backup.data.transactions.length} registro(s) de lançamentos ·{' '}
                {prepared.backup.data.recurring_expenses.length} recorrência(s) ·{' '}
                {prepared.backup.data.installment_purchases.length} compra(s) parcelada(s) ·{' '}
                {prepared.backup.data.goals.length} objetivo(s)
              </Text>
            )}
            {prepared.sourceVersion !== undefined && (
              <Text style={styles.muted}>
                Banco de origem: versão {prepared.sourceVersion}. A cópia está
                pronta na versão {prepared.backup?.schemaVersion}.
                {prepared.mode === 'restore' && prepared.sourceVersion < 5
                  ? ' Este backup não contém preferências; serão usados os padrões de tema e do Léo.'
                  : ''}
              </Text>
            )}
            {prepared.counts && (
              <Text style={styles.text}>
                {prepared.counts.transactions} lançamento(s), {prepared.counts.recurring}{' '}
                recorrência(s), {prepared.counts.goals} objetivo(s) e{' '}
                {prepared.counts.catalogs} cadastro(s) novos. {prepared.counts.skipped} já
                existente(s) ignorado(s).
              </Text>
            )}
            {prepared.added !== undefined && (
              <Text style={styles.text}>
                {prepared.added} registro(s) novo(s), {prepared.skipped} já existente(s)
                ignorado(s).
              </Text>
            )}
            <Button
              label={prepared.mode === 'restore' ? 'Restaurar dados' : 'Importar dados'}
              tone={prepared.mode === 'restore' ? 'danger' : 'primary'}
              disabled={busy}
              onPress={confirm}
            />
            <Button label="Descartar seleção" disabled={busy} onPress={() => setPrepared(null)} />
          </View>
        )}
      </SettingsGroup>
      <Text style={settingsStyles.lead}>
        Backups antigos do Mobile são migrados em uma cópia antes da restauração.
        Arquivos inválidos e versões futuras são recusados. Lançamentos e
        recorrências aceitam valor planejado zero. Parcelas precisam ter valor
        positivo.
      </Text>

      <SettingsGroup title="Exportar">
        <SettingsRow
          first
          icon="download"
          title="Exportar JSON completo"
          description="Restauração completa, com planejamento e preferências."
          disabled={busy}
          onPress={() => exportFile('json')}
        />
        <SettingsRow
          icon="download"
          title="Exportar CSV do mês"
          description={`${monthLabel(month)} · abre em planilhas.`}
          disabled={busy}
          onPress={() => exportFile('csv', month)}
        />
        <SettingsRow
          icon="download"
          title="Exportar CSV de todos os lançamentos"
          disabled={busy}
          onPress={() => exportFile('csv')}
        />
        <SettingsRow
          icon="data"
          title="Salvar backup SQLite em arquivo"
          description="Cópia exata do banco deste aparelho."
          disabled={busy}
          onPress={() => exportFile('sqlite')}
        />
      </SettingsGroup>
      <Text style={settingsStyles.lead}>
        JSON e SQLite preservam registros, datas de realização, prioridades,
        planejamento, preferências e marcadores de exclusão. CSV segue as colunas
        do desktop e exporta por vencimento; não inclui séries, prioridades nem a
        data de realização. Use JSON ou SQLite para restauração completa.
      </Text>

      <SettingsGroup
        title="Cópias no aparelho"
        count={backups.length}
        action={
          <Button
            compact
            icon="plus"
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
        }
      >
        {!backups.length && <SettingsRow first title="Nenhuma cópia neste aparelho." />}
        {backups.map((file, index) => (
          <View
            key={file.name}
            style={[
              { padding: 16, gap: 10 },
              index > 0 && { borderTopWidth: 1, borderTopColor: colors.line },
            ]}
          >
            <View>
              <Text style={styles.text}>{new Date(file.createdAt).toLocaleString('pt-BR')}</Text>
              <Text style={styles.muted}>{Math.ceil(file.size / 1024)} KB</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Button
                compact
                label="Revisar esta cópia"
                disabled={busy}
                onPress={() =>
                  void run(async () => review(await localFiles.copyBackup(file.name)))
                }
              />
              <Button
                compact
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
                    setNotice(saved ? 'Cópia salva no local escolhido.' : 'Exportação cancelada.');
                  })
                }
              />
            </View>
          </View>
        ))}
      </SettingsGroup>
      <Text style={settingsStyles.lead}>
        Inclui as cópias automáticas anteriores a importações e restaurações.
        Para guardar fora do app, salve em arquivo. Desinstalar ou limpar o
        armazenamento remove estas cópias.
      </Text>

      <View style={{ gap: 10 }}>
        <SettingsNote icon="data" title="Seus dados são salvos primeiro aqui">
          O LionPocket salva seus dados neste aparelho e funciona sem conta e
          sem internet. Com a sincronização ativada, seus dados financeiros
          também são enviados criptografados ao servidor.
        </SettingsNote>
        <SettingsNote icon="shield" title="Protegidos pelo Android">
          O banco e as cópias privadas são protegidos pelo armazenamento do
          Android. Você escolhe onde salvar os arquivos exportados.
        </SettingsNote>
      </View>
    </>
  );
}
