import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { currentMonthIso, formatDate, localDateIso, monthLabel, todayIso } from './format';

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
      <button className="month-picker__label" onClick={() => onChange(currentMonthIso())}>
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
  medium = false,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  medium?: boolean;
  wide?: boolean;
}) => {
  // Esc fecha. Quem estiver com um menu ou calendário aberto por cima marca o
  // evento como tratado, então o formulário inteiro não some junto.
  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className={`modal ${wide ? 'modal--wide' : medium ? 'modal--medium' : ''}`} role="dialog" aria-modal="true">
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
};

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

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

const HelpTip = ({ label, children, align = 'end' }: {
  label: string;
  children: string;
  align?: 'start' | 'end';
}) => {
  const tooltipId = useId();
  return (
    <span className={`help-tip help-tip--${align}`}>
      <button type="button" className="help-tip__trigger" aria-label={`Ajuda sobre ${label}`} aria-describedby={tooltipId}>?</button>
      <span id={tooltipId} className="help-tip__content" role="tooltip">{children}</span>
    </span>
  );
};

const findNextOption = (options: SelectOption[], current: number, direction: 1 | -1) => {
  if (options.length === 0) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (current + offset * direction + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return current;
};

export const SelectControl = ({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  className = '',
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = Math.min(260, Math.max(54, options.length * 38 + 12));
    const roomBelow = window.innerHeight - rect.bottom - 12;
    const openAbove = roomBelow < Math.min(estimatedHeight, 180) && rect.top > roomBelow;
    setMenuStyle({
      left: rect.left,
      top: openAbove ? Math.max(8, rect.top - estimatedHeight - 6) : rect.bottom + 6,
      width: rect.width,
      maxHeight: estimatedHeight,
    });
  }, [options.length]);

  const openMenu = (direction: 1 | -1 = 1) => {
    if (disabled) return;
    const fallback = direction === 1 ? -1 : 0;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : findNextOption(options, fallback, direction));
    updateMenuPosition();
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    closeMenu(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    updateMenuPosition();
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>(`[data-option-index="${activeIndex}"]`)?.focus();
    });
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    // Na captura e marcando o evento: assim o Esc fecha só a lista, e não o
    // formulário inteiro que está atrás dela.
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape, true);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [activeIndex, open, updateMenuPosition]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(event.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(findNextOption(options, index, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(findNextOption(options, event.key === 'Home' ? -1 : 0, event.key === 'Home' ? 1 : -1));
    }
  };

  return (
    <div className={`select-control ${open ? 'select-control--open' : ''} ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className="select-control__trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selected?.label ?? 'Selecione'}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={menuRef} id={menuId} className="select-control__menu" role="listbox" aria-label={ariaLabel} style={menuStyle}>
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="select-control__option"
              data-option-index={index}
              disabled={option.disabled}
              tabIndex={-1}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} strokeWidth={2.6} aria-hidden="true" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
};

export const SelectField = ({
  label,
  className = '',
  ...props
}: Omit<React.ComponentProps<typeof SelectControl>, 'ariaLabel'> & { label: string; className?: string }) => (
  <div className={`field ${className}`}>
    <span>{label}</span>
    <SelectControl {...props} ariaLabel={label} />
  </div>
);

const parseLocalDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const DateField = ({
  label,
  value,
  onChange,
  required = false,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  className?: string;
}) => {
  const selectedDate = parseLocalDate(value);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const initial = selectedDate ?? new Date();
    return new Date(initial.getFullYear(), initial.getMonth(), 1);
  });
  const [calendarStyle, setCalendarStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const calendarId = useId();

  const updateCalendarPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = 342;
    const roomBelow = window.innerHeight - rect.bottom - 12;
    const openAbove = roomBelow < estimatedHeight && rect.top > roomBelow;
    setCalendarStyle({
      left: Math.min(rect.left, window.innerWidth - Math.max(300, rect.width) - 8),
      top: openAbove ? Math.max(8, rect.top - estimatedHeight - 6) : rect.bottom + 6,
      width: Math.max(300, rect.width),
    });
  }, []);

  const openCalendar = () => {
    const initial = selectedDate ?? new Date();
    setVisibleMonth(new Date(initial.getFullYear(), initial.getMonth(), 1));
    updateCalendarPosition();
    setOpen(true);
  };

  const closeCalendar = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return undefined;
    updateCalendarPosition();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !calendarRef.current?.contains(target)) closeCalendar();
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeCalendar(true);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape, true);
    window.addEventListener('resize', updateCalendarPosition);
    window.addEventListener('scroll', updateCalendarPosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('resize', updateCalendarPosition);
      window.removeEventListener('scroll', updateCalendarPosition, true);
    };
  }, [open, updateCalendarPosition]);

  const firstDayOffset = (visibleMonth.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, index) => new Date(
    visibleMonth.getFullYear(),
    visibleMonth.getMonth(),
    index - firstDayOffset + 1,
  ));
  const visibleMonthValue = localDateIso(visibleMonth).slice(0, 7);
  const today = todayIso();

  const moveMonth = (amount: number) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  };

  const chooseDate = (date: Date) => {
    onChange(localDateIso(date));
    closeCalendar(true);
  };

  return (
    <div className={`field ${className}`}>
      <span>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className={`date-control__trigger ${open ? 'date-control__trigger--open' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? calendarId : undefined}
        onClick={() => (open ? closeCalendar() : openCalendar())}
      >
        <span className={value ? '' : 'is-placeholder'}>{value ? formatDate(value, 'dd/MM/yyyy') : 'Selecione uma data'}</span>
        <CalendarDays size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={calendarRef} id={calendarId} className="date-control__calendar" role="dialog" aria-label={`Calendário: ${label}`} style={calendarStyle}>
          <header className="date-control__header">
            <button type="button" onClick={() => moveMonth(-1)} aria-label="Mês anterior"><ChevronLeft size={17} /></button>
            <strong>{monthLabel(visibleMonthValue)}</strong>
            <button type="button" onClick={() => moveMonth(1)} aria-label="Próximo mês"><ChevronRight size={17} /></button>
          </header>
          <div className="date-control__weekdays" aria-hidden="true">
            {['S', 'T', 'Q', 'Q', 'S', 'S', 'D'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
          </div>
          <div className="date-control__days">
            {days.map((date) => {
              const iso = localDateIso(date);
              const outside = date.getMonth() !== visibleMonth.getMonth();
              return (
                <button
                  key={iso}
                  type="button"
                  className={`${outside ? 'is-outside' : ''} ${iso === value ? 'is-selected' : ''} ${iso === today ? 'is-today' : ''}`}
                  aria-label={formatDate(iso, "dd 'de' MMMM 'de' yyyy")}
                  aria-pressed={iso === value}
                  onClick={() => chooseDate(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <footer className="date-control__footer">
            {!required && value && <button type="button" onClick={() => { onChange(''); closeCalendar(true); }}>Limpar</button>}
            <button type="button" className="date-control__today" onClick={() => chooseDate(new Date())}>Hoje</button>
          </footer>
        </div>,
        document.body,
      )}
    </div>
  );
};

const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

export const MonthField = ({
  label,
  hint,
  value,
  onChange,
  min,
  className = '',
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  className?: string;
}) => {
  const selectedYear = Number(value.slice(0, 4));
  const [open, setOpen] = useState(false);
  const [visibleYear, setVisibleYear] = useState(selectedYear || new Date().getFullYear());
  const [pickerStyle, setPickerStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerId = useId();

  const updatePickerPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = 260;
    const width = Math.max(300, rect.width);
    const roomBelow = window.innerHeight - rect.bottom - 12;
    const openAbove = roomBelow < estimatedHeight && rect.top > roomBelow;
    setPickerStyle({
      left: Math.min(rect.left, window.innerWidth - width - 8),
      top: openAbove ? Math.max(8, rect.top - estimatedHeight - 6) : rect.bottom + 6,
      width,
    });
  }, []);

  const closePicker = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openPicker = () => {
    setVisibleYear(selectedYear || new Date().getFullYear());
    updatePickerPosition();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    updatePickerPosition();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !pickerRef.current?.contains(target)) closePicker();
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closePicker(true);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape, true);
    window.addEventListener('resize', updatePickerPosition);
    window.addEventListener('scroll', updatePickerPosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('resize', updatePickerPosition);
      window.removeEventListener('scroll', updatePickerPosition, true);
    };
  }, [open, updatePickerPosition]);

  const chooseMonth = (month: string) => {
    if (min && month < min) return;
    onChange(month);
    closePicker(true);
  };

  return (
    <div className={`field ${className}`}>
      <span className="field__label">{label}{hint && <HelpTip label={label} align={className.includes('form-grid__full') ? 'start' : 'end'}>{hint}</HelpTip>}</span>
      <button
        ref={triggerRef}
        type="button"
        className={`date-control__trigger ${open ? 'date-control__trigger--open' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        onClick={() => (open ? closePicker() : openPicker())}
      >
        <span className={value ? '' : 'is-placeholder'}>{value ? monthLabel(value) : 'Selecione um mês'}</span>
        <CalendarDays size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={pickerRef} id={pickerId} className="date-control__calendar month-control__calendar" role="dialog" aria-label={`Seletor de mês: ${label}`} style={pickerStyle}>
          <header className="date-control__header">
            <button type="button" onClick={() => setVisibleYear((year) => year - 1)} aria-label="Ano anterior"><ChevronLeft size={17} /></button>
            <strong>{visibleYear}</strong>
            <button type="button" onClick={() => setVisibleYear((year) => year + 1)} aria-label="Próximo ano"><ChevronRight size={17} /></button>
          </header>
          <div className="month-control__months">
            {monthNames.map((name, index) => {
              const month = `${visibleYear}-${String(index + 1).padStart(2, '0')}`;
              const disabled = Boolean(min && month < min);
              return (
                <button
                  key={month}
                  type="button"
                  className={`${month === value ? 'is-selected' : ''} ${month === currentMonthIso() ? 'is-current' : ''}`}
                  aria-label={monthLabel(month)}
                  aria-pressed={month === value}
                  disabled={disabled}
                  onClick={() => chooseMonth(month)}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <footer className="date-control__footer">
            <button type="button" className="date-control__today" disabled={Boolean(min && currentMonthIso() < min)} onClick={() => chooseMonth(currentMonthIso())}>Este mês</button>
          </footer>
        </div>,
        document.body,
      )}
    </div>
  );
};

export const ProgressBar = ({ value, color = 'var(--primary)' }: { value: number; color?: string }) => (
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
