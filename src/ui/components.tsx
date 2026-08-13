import type { ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { monthLabel } from './format';

export const LionLogo = ({ compact = false }: { compact?: boolean }) => (
  <div className={`brand ${compact ? 'brand--compact' : ''}`}>
    <div className="brand__mark" aria-hidden="true">
      <svg viewBox="0 0 48 48" role="img">
        <path d="M9 19 4 9l11 5L24 5l9 9 11-5-5 10c2 3 3 7 3 11 0 10-8 15-18 15S6 40 6 30c0-4 1-8 3-11Z" fill="currentColor" />
        <path d="M15 27c2-4 5-6 9-6s7 2 9 6c-1 7-4 11-9 11s-8-4-9-11Z" fill="#F8D77B" />
        <circle cx="17" cy="24" r="2" fill="#12372A" />
        <circle cx="31" cy="24" r="2" fill="#12372A" />
        <path d="m21 30 3-2 3 2-3 3-3-3Z" fill="#12372A" />
      </svg>
    </div>
    {!compact && (
      <div>
        <strong>LionPocket</strong>
        <span>Seu dinheiro, do seu jeito</span>
      </div>
    )}
  </div>
);

export const MonthPicker = ({
  month,
  onChange,
}: {
  month: string;
  onChange: (month: string) => void;
}) => {
  const move = (amount: number) => {
    const [year, rawMonth] = month.split('-').map(Number);
    const date = new Date(year, rawMonth - 1 + amount, 1);
    onChange(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
  };
  return (
    <div className="month-picker">
      <button className="icon-button" onClick={() => move(-1)} aria-label="Mês anterior">
        <ChevronLeft size={18} />
      </button>
      <button className="month-picker__label" onClick={() => onChange(new Date().toISOString().slice(0, 7))}>
        {monthLabel(month)}
      </button>
      <button className="icon-button" onClick={() => move(1)} aria-label="Próximo mês">
        <ChevronRight size={18} />
      </button>
    </div>
  );
};

export const EmptyState = ({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) => (
  <div className="empty-state">
    <div className="empty-state__icon">{icon}</div>
    <h3>{title}</h3>
    <p>{description}</p>
    {action}
  </div>
);

export const Modal = ({
  title,
  description,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) => (
  <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <section className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true">
      <header className="modal__header">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Fechar">
          <X size={20} />
        </button>
      </header>
      {children}
    </section>
  </div>
);

export const SearchField = ({ value, onChange, placeholder = 'Buscar' }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) => (
  <label className="search-field">
    <Search size={18} />
    <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
  </label>
);

export const ProgressBar = ({ value, color = '#F3B45C' }: { value: number; color?: string }) => (
  <div className="progress" aria-label={`${Math.round(value * 100)}% concluído`}>
    <span style={{ width: `${Math.max(0, Math.min(100, value * 100))}%`, background: color }} />
  </div>
);

export const CheckButton = ({ checked, onClick, label }: {
  checked: boolean;
  onClick: () => void;
  label: string;
}) => (
  <button className={`check-button ${checked ? 'check-button--checked' : ''}`} onClick={onClick} aria-label={label}>
    {checked && <Check size={14} strokeWidth={3} />}
  </button>
);

export const Skeleton = ({ className = '' }: { className?: string }) => (
  <div className={`skeleton ${className}`} />
);

