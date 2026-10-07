import type { ReactNode } from 'react';
import { HardDrive, LockKeyhole, RefreshCw, SlidersHorizontal, Tags } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Catalogs } from '@lionpocket/core/types';
import type { Theme } from '../theme';
import { CatalogSettings } from './catalogs/CatalogSettings';
import { DataSettings } from './DataSettings';
import { GeneralSettings } from './GeneralSettings';
import { SyncPanel } from './sync/SyncPanel';

/** Everything a settings page may read or change in the app. */
export type SettingsContext = {
  catalogs: Catalogs;
  refreshCatalogs: () => Promise<void>;
  month: string;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  showPriorities: boolean;
  onShowPrioritiesChange: (visible: boolean) => void;
  onSyncChanged: () => Promise<void>;
  notify: (message: string) => void;
};

export type SettingsSection = {
  id: string;
  label: string;
  /** Short hint shown in the navigation. */
  summary: string;
  icon: LucideIcon;
  description: string;
  badge?: ReactNode;
  render: (context: SettingsContext) => ReactNode;
};

/**
 * Settings registry. A new area is one entry here plus its own page
 * component; the screen and navigation pick it up automatically.
 */
export const settingsSections = [
  {
    id: 'general',
    label: 'Geral',
    summary: 'Aparência e exibição',
    icon: SlidersHorizontal,
    description: 'Ajuste a aparência e o que aparece no seu dia a dia.',
    render: (context) => <GeneralSettings {...context} />,
  },
  {
    id: 'catalogs',
    label: 'Cadastros',
    summary: 'Categorias, pagamentos e cartões',
    icon: Tags,
    description: 'As listas usadas nos formulários de lançamentos, recorrências e parcelas.',
    render: (context) => <CatalogSettings {...context} />,
  },
  {
    id: 'data',
    label: 'Dados e backup',
    summary: 'Importar, copiar e exportar',
    icon: HardDrive,
    description: 'Importe a planilha, faça cópias e leve seus lançamentos com você.',
    render: (context) => <DataSettings {...context} />,
  },
  {
    id: 'sync',
    label: 'Sincronização',
    summary: 'Servidor, aparelhos e recuperação',
    icon: RefreshCw,
    description: 'Seus dados em mais de um aparelho, com você no controle.',
    badge: (
      <span className="settings-badge">
        <LockKeyhole size={13} aria-hidden="true" />
        Criptografia de ponta a ponta
      </span>
    ),
    render: ({ onSyncChanged }) => <SyncPanel onChanged={onSyncChanged} />,
  },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof settingsSections)[number]['id'];
