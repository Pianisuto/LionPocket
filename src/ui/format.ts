import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export {
  addMonths,
  cardStatementDueDate,
  currentMonthIso,
  dateForMonthDay,
  isPastDate,
  localDateIso,
  nextCardDueDate,
  settlementDateFor,
  todayIso,
} from '../shared/finance';

export const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export const compactCurrency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1,
});

export const formatDate = (date: string | null, pattern = "dd 'de' MMM") => {
  if (!date) return 'Sem data';
  return format(parseISO(date), pattern, { locale: ptBR });
};

/**
 * Há quanto tempo uma conta venceu, em texto curto.
 *
 * A data em si já aparece no selo ao lado, então repeti-la por extenso só
 * alonga a linha: o que falta saber é o tamanho do atraso.
 */
export const overdueLabel = (dueDate: string, today = new Date()) => {
  const days = differenceInCalendarDays(today, parseISO(dueDate));
  if (days <= 0) return 'vence hoje';
  return `${days} ${days === 1 ? 'dia' : 'dias'} em atraso`;
};

export const monthLabel = (month: string) => {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(year, number - 1, 1);
  const label = format(date, 'MMMM yyyy', { locale: ptBR });
  return label.charAt(0).toUpperCase() + label.slice(1);
};

export const statusLabel = (status: string) =>
  ({
    planned: 'Planejado',
    paid: 'Pago',
    received: 'Recebido',
    cancelled: 'Cancelado',
    saving: 'Juntando',
    completed: 'Concluído',
    paused: 'Pausado',
    active: 'Ativa',
  })[status] ?? status;

export const priorityLabel = (priority: string) =>
  ({ high: 'Alta', medium: 'Média', low: 'Baixa' })[priority] ?? priority;
