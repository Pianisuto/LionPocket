import type { ServerResetIntent } from './server-reset';
import { syncActivityLabel, type SyncStatus } from './sync';

/**
 * Presentation shared by the desktop and Android sync screens. It only derives
 * labels and visibility from SyncStatus; every operation stays in the controller.
 */

export const recoveryPreparingPhases = [
  'identity_reserved',
  'secrets_prepared',
  'recovery_pending_confirmation',
  'recovery_confirmed',
  'staging',
  'staged',
];

export const recoveryFinalizingPhases = [
  'activation_requested',
  'remote_active',
  'installing_local',
  'local_db_installed',
  'profile_installed',
  'finalizing',
];

export type ServerRecoveryStep =
  | 'start'
  | 'preparing'
  | 'prepared'
  | 'finalizing'
  | 'recovered'
  | 'other';

export function serverRecoveryStep(
  phase: string | null | undefined,
): ServerRecoveryStep {
  if (!phase) return 'start';
  if (phase === 'recovered') return 'recovered';
  if (phase === 'prepared') return 'prepared';
  if (recoveryFinalizingPhases.includes(phase)) return 'finalizing';
  if (recoveryPreparingPhases.includes(phase)) return 'preparing';
  return 'other';
}

export function serverRecoveryTitle(phase: string | null | undefined): string {
  switch (serverRecoveryStep(phase)) {
    case 'recovered':
      return 'Sincronização recuperada';
    case 'prepared':
      return 'Pronto para ativar';
    case 'finalizing':
      return phase === 'activation_requested'
        ? 'Ativando sincronização'
        : 'Finalizando neste aparelho';
    case 'start':
      return 'Recuperar sincronização';
    default:
      return 'Preparando recuperação';
  }
}

export function syncPanelState(status: SyncStatus) {
  const resetReady =
    status.phase === 'local' && status.serverReset?.phase === 'ready';
  const connected = status.phase === 'bound' && !status.unlinkPending;
  return {
    /** Backup/unlink finished; the next step depends on the durable intent. */
    resetReady,
    joiningRecreated: resetReady && status.serverReset?.intent === 'join-existing',
    creatingFromReset:
      resetReady && status.serverReset?.intent === 'source-of-truth',
    connected,
    canUnlink: status.phase !== 'local' || !!status.discovered || !!status.serverReset || !!status.unlinkPending,
    /** Device, protection and review tools are hidden during server recovery. */
    canManage:
      connected &&
      (!status.recoveryPhase || status.recoveryPhase === 'recovered'),
    needsAttention: [
      'paused',
      'unavailable',
      'review',
      'action-required',
    ].includes(status.activity),
    showServerRecovery: !status.unlinkPending && Boolean(
      status.recoveryPhase ||
        (status.anchorRecoveryAvailable &&
          status.compatibilityMessage?.includes('histórico')),
    ),
    pending: status.sync?.pending ?? 0,
    hasReviews: Boolean(status.reviews.length || status.quarantine.length),
  };
}

export function syncStatusTitle(status: SyncStatus): string {
  if (status.unlinkPending) return 'Desvinculação pendente';
  return status.activity === 'paused'
    ? 'Sincronização pausada'
    : syncActivityLabel[status.activity];
}

export function syncStatusDescription(status: SyncStatus): string {
  if (status.unlinkPending) return 'Conclua a desvinculação neste aparelho. Seus dados financeiros locais estão preservados.';
  const pending = status.sync?.pending ?? 0;
  if (status.phase === 'local')
    return 'Funciona sem conta e sem conexão com a internet.';
  if (pending)
    return `${pending} ${pending === 1 ? 'alteração aguardando envio' : 'alterações aguardando envio'}. Seus dados já estão salvos neste aparelho.`;
  switch (status.activity) {
    case 'unavailable':
      return 'Seus dados continuam disponíveis. A sincronização pode ser retomada quando a conexão voltar.';
    case 'paused':
      return 'Você pode continuar usando o aplicativo e retomar quando quiser.';
    case 'review':
      return 'Confira as informações abaixo antes de concluir a sincronização.';
    case 'action-required':
      return 'Entre novamente ou desbloqueie as chaves para continuar.';
  }
  return status.phase === 'bound'
    ? 'Nenhuma alteração aguardando envio.'
    : 'Siga as etapas abaixo para conectar este aparelho.';
}

export function pairingStepTitle(step: SyncStatus['pairingStep']): string {
  return step === 'preparing'
    ? 'Preparando conexão…'
    : step === 'connecting'
      ? 'Conectando…'
      : 'Aguardando aprovação no outro aparelho';
}

/** A refused, expired or cancelled invitation can be replaced by a new one. */
export function canReplaceInvitation(pairingError: string | null): boolean {
  return Boolean(
    pairingError && /^(Convite|Pedido recusado|Este convite)/.test(pairingError),
  );
}

export function deviceStatusLabel(status: string): string {
  return status === 'approved'
    ? 'Aprovado'
    : status === 'revoked'
      ? 'Revogado'
      : status;
}

export const serverResetCopy = {
  title: 'Servidor de sincronização recriado',
  description:
    'O remoto anterior será abandonado. Um backup completo será criado antes de remover o vínculo. Seus dados financeiros locais não serão apagados.',
  question: 'Como este aparelho deve continuar?',
  choices: [
    {
      intent: 'source-of-truth',
      label: 'Usar este aparelho como fonte de verdade',
      description:
        'Depois do backup e da desvinculação, crie um novo cofre usando os dados deste aparelho. Usar esta opção em mais de um aparelho pode criar cofres independentes.',
    },
    {
      intent: 'join-existing',
      label: 'Conectar este aparelho a um cofre já recriado',
      description:
        'Outro aparelho já criou o novo cofre. Depois do backup e da desvinculação, use o convite LPV2 desse aparelho e aguarde sua aprovação. Este fluxo não cria um novo cofre.',
    },
  ] as const satisfies ReadonlyArray<{
    intent: ServerResetIntent;
    label: string;
    description: string;
  }>,
  consent:
    'Entendo que o remoto anterior será abandonado e que o backup será preservado antes de remover o vínculo.',
  action: 'Preservar backup e remover vínculo antigo',
};
