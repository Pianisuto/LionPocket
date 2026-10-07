import { useState } from 'react';
import {
  DatabaseBackup,
  Download,
  FileJson,
  FileSpreadsheet,
  HardDrive,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { monthLabel } from '../format';
import { SettingsActionRow, SettingsGroup, SettingsNote } from './SettingsKit';
import type { SettingsContext } from './sections';

type DataAction = 'import' | 'backup' | 'csv' | 'json';

export function DataSettings({ month, notify }: SettingsContext) {
  const [busy, setBusy] = useState<DataAction | ''>('');
  const run = async (name: DataAction, action: () => Promise<string | null | object>) => {
    setBusy(name);
    try {
      const result = await action();
      if (result) notify(name === 'import' ? `Planilha importada: ${Object.values(result as object).join(' registros, ')} registros.` : 'Arquivo criado com sucesso.');
    } catch {
      notify('Não foi possível concluir a operação com o arquivo.');
    } finally {
      setBusy('');
    }
  };
  return (
    <>
      <SettingsGroup title="Importar" description="Traga lançamentos de uma planilha para este computador.">
        <div className="settings-actions-list">
          <SettingsActionRow
            icon={FileSpreadsheet}
            actionIcon={Upload}
            title="Importar planilha"
            description="Lê o arquivo Planejamento_Financeiro_2026.xlsx"
            disabled={Boolean(busy)}
            onClick={() => void run('import', () => window.lionPocket.importSpreadsheet())}
          />
        </div>
      </SettingsGroup>
      <SettingsGroup title="Cópias e exportação" description="Guarde uma cópia completa ou leve seus lançamentos para outros programas.">
        <div className="settings-actions-list">
          <SettingsActionRow
            icon={DatabaseBackup}
            actionIcon={Download}
            title="Criar cópia de segurança"
            description="Salva uma cópia completa do banco local"
            disabled={Boolean(busy)}
            onClick={() => void run('backup', () => window.lionPocket.createBackup())}
          />
          <SettingsActionRow
            icon={FileSpreadsheet}
            actionIcon={Download}
            title="Exportar mês em CSV"
            description={`${monthLabel(month)} · abre no Excel, LibreOffice ou Google Planilhas`}
            disabled={Boolean(busy)}
            onClick={() => void run('csv', () => window.lionPocket.exportCsv(month))}
          />
          <SettingsActionRow
            icon={FileJson}
            actionIcon={Download}
            title="Exportar tudo em JSON"
            description="Arquivo completo para uso futuro"
            disabled={Boolean(busy)}
            onClick={() => void run('json', () => window.lionPocket.exportJson())}
          />
        </div>
      </SettingsGroup>
      <div className="settings-notes">
        <SettingsNote icon={HardDrive} title="Seus dados são salvos primeiro aqui">
          <p>O LionPocket salva seus dados neste computador e funciona sem conta e sem internet. Com a sincronização ativada, seus dados financeiros também são enviados criptografados ao servidor. Cópias e exportações são salvas no local que você escolher.</p>
        </SettingsNote>
        <SettingsNote icon={ShieldCheck} title="Proteja também o computador">
          <p>O banco e as cópias locais ficam em claro. Ative a criptografia de disco do Linux ou Windows para protegê-los contra acesso físico.</p>
        </SettingsNote>
      </div>
    </>
  );
}
