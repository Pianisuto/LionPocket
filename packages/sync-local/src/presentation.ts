import type { RevisionPlaintext } from '@lionpocket/sync-protocol';
const money = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const labels: Record<string, string> = { expense: 'Despesa', income: 'Receita', planned: 'Previsto', settled: 'Realizado', skipped: 'Ignorado', active: 'Ativo', completed: 'Concluído', cancelled: 'Cancelado', paused: 'Pausado' };
/** Local presentation only; financial plaintext never goes into diagnostics/logs. */
export function revisionSummary(revision: RevisionPlaintext): { title: string; lines: string[] } {
  if (revision.action === 'delete') return { title: 'Registro excluído', lines: [revision.deletedAt ?? 'Data de exclusão não disponível'] };
  switch (revision.entityType) {
    case 'transaction': { const s = revision.snapshot; return { title: s.description, lines: [labels[s.kind], 'Previsto: ' + money(s.plannedAmountCents), s.actualAmountCents == null ? 'Valor realizado não informado' : 'Realizado: ' + money(s.actualAmountCents), 'Vencimento: ' + s.dueDate, labels[s.status] ?? s.status, s.notes].filter(Boolean) }; }
    case 'category': return { title: revision.snapshot.name, lines: [labels[revision.snapshot.kind]] };
    case 'paymentMethod': return { title: revision.snapshot.name, lines: ['Forma de pagamento'] };
    case 'card': return { title: revision.snapshot.name, lines: ['Vencimento: dia ' + revision.snapshot.dueDay, 'Fechamento: ' + (revision.snapshot.closingDay ?? 'não informado')] };
    case 'recurring': return { title: revision.snapshot.description, lines: [money(revision.snapshot.plannedAmountCents), 'Início: ' + revision.snapshot.startMonth, revision.snapshot.active ? 'Recorrência ativa' : 'Recorrência pausada', revision.snapshot.notes].filter(Boolean) };
    case 'installmentPurchase': return { title: revision.snapshot.description, lines: [money(revision.snapshot.installmentAmountCents) + ' por parcela', revision.snapshot.totalInstallments + ' parcelas', 'Primeiro vencimento: ' + revision.snapshot.firstDueDate, labels[revision.snapshot.status], revision.snapshot.notes].filter(Boolean) };
    case 'goal': return { title: revision.snapshot.name, lines: ['Meta: ' + money(revision.snapshot.targetAmountCents), 'Guardado: ' + money(revision.snapshot.savedAmountCents), revision.snapshot.dueDate ? 'Prazo: ' + revision.snapshot.dueDate : 'Sem prazo', revision.snapshot.notes].filter(Boolean) };
    case 'recurringPriorityList': return { title: 'Ordem das prioridades recorrentes', lines: [revision.snapshot.entries.length + ' prioridades'] };
    case 'monthlyPriorityList': return { title: 'Ordem das prioridades de ' + revision.snapshot.month, lines: [revision.snapshot.transactionIds.length + ' prioridades'] };
  }
}
