import type { SyncActivity } from '@lionpocket/sync-local';
import {
  CheckCheck,
  CircleAlert,
  Clock3,
  CloudOff,
  HardDrive,
  LockKeyhole,
  Pause,
  RefreshCw,
  Settings2,
  type LucideIcon,
} from 'lucide-react';

type BadgePresentation = {
  label: string;
  icon: LucideIcon;
  tone: 'neutral' | 'positive' | 'pending' | 'attention' | 'alert' | 'configuring';
  description: string;
};

const presentations: Record<SyncActivity, BadgePresentation> = {
  synced: {
    label: 'Sincronizado', icon: CheckCheck, tone: 'positive',
    description: 'Sincronização criptografada concluída, sem alterações aguardando envio.',
  },
  syncing: {
    label: 'Sincronizando…', icon: RefreshCw, tone: 'pending',
    description: 'Sincronização criptografada em andamento.',
  },
  pending: {
    label: 'Aguardando envio', icon: Clock3, tone: 'pending',
    description: 'Seus dados estão salvos neste computador e há alterações aguardando envio.',
  },
  paused: {
    label: 'Sincronização pausada', icon: Pause, tone: 'neutral',
    description: 'Você pode continuar usando o aplicativo e retomar a sincronização nas configurações.',
  },
  unavailable: {
    label: 'Offline ou servidor indisponível', icon: CloudOff, tone: 'attention',
    description: 'Seus dados continuam disponíveis neste computador. Confira a conexão e o servidor nas configurações.',
  },
  review: {
    label: 'Revisão necessária', icon: CircleAlert, tone: 'attention',
    description: 'Confira a sincronização nas configurações: há informações que precisam da sua revisão.',
  },
  'action-required': {
    label: 'Ação necessária', icon: LockKeyhole, tone: 'alert',
    description: 'Abra a sincronização nas configurações para entrar novamente, desbloquear as chaves ou concluir a recuperação.',
  },
  configuring: {
    label: 'Configurando sincronização', icon: Settings2, tone: 'configuring',
    description: 'Conclua a conexão deste computador nas configurações de sincronização.',
  },
  ready: {
    label: 'Pronto para sincronizar', icon: RefreshCw, tone: 'neutral',
    description: 'Este computador está conectado ao cofre e pronto para iniciar a sincronização criptografada.',
  },
  local: {
    label: 'Somente neste computador', icon: HardDrive, tone: 'neutral',
    description: 'Seus dados estão salvos localmente, sem sincronização com um servidor.',
  },
};

const initialPresentation: BadgePresentation = {
  label: 'Salvos neste computador', icon: HardDrive, tone: 'neutral',
  description: 'Seus dados estão salvos neste computador. O status de sincronização ainda não está disponível.',
};

export function SyncStatusBadge({ activity }: { activity: SyncActivity | null }) {
  const presentation = activity ? presentations[activity] : initialPresentation;
  const Icon = presentation.icon;

  return (
    <div className="local-badge" role="status" aria-atomic="true" title={presentation.description}>
      <span className={`local-badge__indicator local-badge__indicator--${presentation.tone}`} aria-hidden="true">
        <Icon size={16} className={activity === 'syncing' ? 'sync-spinning' : undefined} />
      </span>
      <div>
        <strong>Seus dados</strong>
        <small>{presentation.label}</small>
      </div>
    </div>
  );
}
