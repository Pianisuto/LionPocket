import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, Search, Trash2, X } from 'lucide-react';
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
  closeDisabled = false,
  medium = false,
  role = 'dialog',
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  closeDisabled?: boolean;
  medium?: boolean;
  role?: 'dialog' | 'alertdialog';
  wide?: boolean;
}) => {
  const titleId = useId();
  // Esc fecha. Quem estiver com um menu ou calendário aberto por cima marca o
  // evento como tratado, então o formulário inteiro não some junto.
  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !closeDisabled) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeDisabled, onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !closeDisabled) onClose();
    }}>
      <section className={`modal ${wide ? 'modal--wide' : medium ? 'modal--medium' : ''}`} role={role} aria-modal="true" aria-labelledby={titleId}>
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" disabled={closeDisabled} onClick={onClose} aria-label="Fechar">
            <X size={20} />
          </button>
        </header>
        <div className="modal__body">
          {children}
        </div>
      </section>
    </div>
  );
};

export const ConfirmDialog = ({
  title,
  itemName,
  description,
  confirmLabel = 'Excluir',
  loading = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  itemName: string;
  description: string;
  confirmLabel?: string;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) => (
  <Modal title={title} onClose={onCancel} closeDisabled={loading} role="alertdialog">
    <div className="confirm-dialog">
      <div className="confirm-dialog__item">
        <span className="confirm-dialog__icon"><Trash2 size={21} /></span>
        <div>
          <strong>{itemName}</strong>
          <p>{description}</p>
          <p className="confirm-dialog__warning">Esta ação não pode ser desfeita.</p>
        </div>
      </div>
      <div className="modal__actions">
        <button type="button" className="button button--ghost" disabled={loading} onClick={onCancel} autoFocus>Cancelar</button>
        <button type="button" className="button button--danger" disabled={loading} onClick={() => void onConfirm()}>
          <Trash2 size={16} /> {loading ? 'Excluindo…' : confirmLabel}
        </button>
      </div>
    </div>
  </Modal>
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

export type SelectOption = {
  value: string;
  label: string;
  details?: string[];
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
  const [search, setSearch] = useState('');
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pointerFocusRef = useRef(false);
  const suppressFocusOpenRef = useRef(false);
  const focusSearchOnOpenRef = useRef(false);
  const menuId = useId();
  const listboxId = `${menuId}-listbox`;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const filteredOptions = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => option.label.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(normalizedSearch));

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = Math.min(310, Math.max(108, options.length * 38 + 62));
    const roomBelow = window.innerHeight - rect.bottom - 12;
    const openAbove = roomBelow < Math.min(estimatedHeight, 180) && rect.top > roomBelow;
    setMenuStyle({
      left: rect.left,
      top: openAbove ? Math.max(8, rect.top - estimatedHeight - 6) : rect.bottom + 6,
      width: rect.width,
      maxHeight: estimatedHeight,
    });
  }, [options.length]);

  const openMenu = (direction: 1 | -1 = 1, focusFirst = false) => {
    if (disabled) return;
    const fallback = direction === 1 ? -1 : 0;
    setSearch('');
    setActiveIndex(focusFirst
      ? findNextOption(options, -1, 1)
      : selectedIndex >= 0 ? selectedIndex : findNextOption(options, fallback, direction));
    updateMenuPosition();
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setSearch('');
    if (restoreFocus) {
      suppressFocusOpenRef.current = true;
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
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
      if (focusSearchOnOpenRef.current) {
        focusSearchOnOpenRef.current = false;
        searchRef.current?.focus();
      } else {
        menuRef.current?.querySelector<HTMLButtonElement>(`[data-option-index="${activeIndex}"]`)?.focus();
      }
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

  const focusNextField = (backwards: boolean) => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const focusable = [...document.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      const currentIndex = focusable.indexOf(trigger);
      focusable[currentIndex + (backwards ? -1 : 1)]?.focus();
    });
  };

  const isPrintableKey = (event: KeyboardEvent<HTMLElement>) =>
    event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

  const moveFiltered = (currentIndex: number, direction: 1 | -1) => {
    if (filteredOptions.length === 0) return -1;
    const currentPosition = filteredOptions.findIndex(({ index }) => index === currentIndex);
    const start = currentPosition >= 0 ? currentPosition : direction === 1 ? -1 : 0;
    for (let offset = 1; offset <= filteredOptions.length; offset += 1) {
      const position = (start + offset * direction + filteredOptions.length) % filteredOptions.length;
      if (!filteredOptions[position].option.disabled) return filteredOptions[position].index;
    }
    return currentIndex;
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(event.key === 'ArrowDown' ? 1 : -1);
    } else if (isPrintableKey(event)) {
      event.preventDefault();
      focusSearchOnOpenRef.current = true;
      openMenu(1, true);
      setSearch(event.key);
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(moveFiltered(index, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(moveFiltered(-1, event.key === 'Home' ? 1 : -1));
    } else if (event.key === 'Tab') {
      event.preventDefault();
      focusNextField(event.shiftKey);
    } else if (isPrintableKey(event)) {
      event.preventDefault();
      setSearch(event.key);
      window.requestAnimationFrame(() => searchRef.current?.focus());
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(moveFiltered(activeIndex, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const activeCandidate = filteredOptions.find(({ index }) => index === activeIndex)?.option;
      const candidate = activeCandidate ?? filteredOptions.find(({ option }) => !option.disabled)?.option;
      if (candidate) choose(candidate);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      focusNextField(event.shiftKey);
    }
  };

  const optionContent = (option: SelectOption | undefined) => (
    <span className="select-control__value">
      <span className="select-control__label">{option?.label ?? 'Selecione'}</span>
      {option?.details && option.details.length > 0 && (
        <span className="select-control__details" aria-label={option.details.join(', ')}>
          {option.details.map((detail) => <small key={detail}>{detail}</small>)}
        </span>
      )}
    </span>
  );

  return (
    <div className={`select-control ${open ? 'select-control--open' : ''} ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        className="select-control__trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onPointerDown={() => { pointerFocusRef.current = true; }}
        onFocus={() => {
          if (suppressFocusOpenRef.current) {
            suppressFocusOpenRef.current = false;
            return;
          }
          if (pointerFocusRef.current) {
            pointerFocusRef.current = false;
            return;
          }
          if (!open) openMenu(1, true);
        }}
        onClick={() => {
          pointerFocusRef.current = false;
          if (open) closeMenu(); else openMenu();
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        {optionContent(selected)}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={menuRef} id={menuId} className="select-control__menu" style={menuStyle}>
          <label className="select-control__search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Pesquisar opções"
              aria-label={`Pesquisar em ${ariaLabel}`}
              autoComplete="off"
            />
          </label>
          <div id={listboxId} className="select-control__options" role="listbox" aria-label={ariaLabel}>
          {filteredOptions.map(({ option, index }) => (
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
              {optionContent(option)}
              {option.value === value && <Check size={15} strokeWidth={2.6} aria-hidden="true" />}
            </button>
          ))}
          {filteredOptions.length === 0 && <span className="select-control__empty">Nenhuma opção encontrada</span>}
          </div>
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
  return Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    ? null
    : date;
};

const datePartsIso = (day: string, month: string, year: string) => {
  if (day.length !== 2 || month.length !== 2 || year.length !== 4) return null;
  const iso = `${year}-${month}-${day}`;
  return parseLocalDate(iso) ? iso : null;
};

const validMonth = (month: string) => {
  const number = Number(month);
  return month.length === 2 && number >= 1 && number <= 12 ? number : null;
};

const validYear = (year: string) => {
  const number = Number(year);
  return year.length === 4 && number >= 1000 ? number : null;
};

const previewDateIso = (day: string, month: string, year: string, fallback: Date) => {
  const dayNumber = Number(day);
  if (day.length !== 2 || dayNumber < 1 || dayNumber > 31) return null;
  const monthNumber = month === '' ? fallback.getMonth() + 1 : validMonth(month);
  const yearNumber = year === '' ? fallback.getFullYear() : validYear(year);
  if (!monthNumber || !yearNumber) return null;
  return datePartsIso(
    String(dayNumber).padStart(2, '0'),
    String(monthNumber).padStart(2, '0'),
    String(yearNumber),
  );
};

const moneyFormatter = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const MoneyField = ({
  label,
  value,
  onChange,
  required = false,
  min = 0,
  className = '',
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  min?: number;
  className?: string;
}) => {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const numericValue = value === '' ? null : Number(value);
  const displayValue = numericValue === null || Number.isNaN(numericValue)
    ? ''
    : moneyFormatter.format(numericValue);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setCustomValidity(numericValue !== null && numericValue < min
      ? `O valor mínimo é ${moneyFormatter.format(min)}.`
      : '');
  }, [min, numericValue]);

  return (
    <label className={`field ${className}`} htmlFor={inputId}>
      <span>{label}</span>
      <div className={`money-input ${error ? 'is-invalid' : ''}`}>
        <span>R$</span>
        <input
          ref={inputRef}
          id={inputId}
          required={required}
          inputMode="numeric"
          autoComplete="off"
          value={displayValue}
          placeholder="0,00"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onFocus={(event) => event.currentTarget.select()}
          onInvalid={(event) => {
            event.preventDefault();
            setError(numericValue === null
              ? 'Informe um valor.'
              : numericValue < min
                ? `O valor mínimo é ${moneyFormatter.format(min)}.`
                : 'Informe um valor válido.');
          }}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, '');
            setError('');
            onChange(digits ? String(Number(digits) / 100) : '');
          }}
        />
      </div>
      {error && <small id={errorId} className="field__error" role="alert">{error}</small>}
    </label>
  );
};

export const NumberField = ({
  label,
  value,
  onChange,
  required = false,
  min,
  max,
  step = 1,
  placeholder,
  className = '',
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  className?: string;
}) => {
  const errorId = useId();
  const [error, setError] = useState('');
  const numericValue = value.trim() === '' ? null : Number(value);
  const atMinimum = numericValue !== null && min !== undefined && numericValue <= min;
  const atMaximum = numericValue !== null && max !== undefined && numericValue >= max;
  const changeBy = (direction: -1 | 1) => {
    const fallback = direction > 0 ? min ?? 0 : max ?? min ?? 0;
    const base = numericValue === null || Number.isNaN(numericValue) ? fallback : numericValue;
    const stepped = numericValue === null || Number.isNaN(numericValue) ? base : base + direction * step;
    const bounded = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, stepped));
    setError('');
    onChange(String(Number(bounded.toFixed(10))));
  };

  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      <div className={`number-input ${error ? 'is-invalid' : ''}`}>
        <input
          required={required}
          min={min}
          max={max}
          step={step}
          type="number"
          value={value}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onInvalid={(event) => {
            event.preventDefault();
            const validity = event.currentTarget.validity;
            setError(validity.valueMissing
              ? 'Informe um valor.'
              : validity.rangeUnderflow
                ? `O valor mínimo é ${min}.`
                : validity.rangeOverflow
                  ? `O valor máximo é ${max}.`
                  : 'Informe um número válido.');
          }}
          onChange={(event) => {
            setError('');
            onChange(event.target.value);
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={atMinimum}
          aria-label="Diminuir valor"
          onClick={() => changeBy(-1)}
        ><Minus size={16} strokeWidth={2.4} /></button>
        <button
          type="button"
          tabIndex={-1}
          disabled={atMaximum}
          aria-label="Aumentar valor"
          onClick={() => changeBy(1)}
        ><Plus size={16} strokeWidth={2.4} /></button>
      </div>
      {error && <small id={errorId} className="field__error" role="alert">{error}</small>}
    </label>
  );
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
  const [day, setDay] = useState(() => value.slice(8, 10));
  const [month, setMonth] = useState(() => value.slice(5, 7));
  const [year, setYear] = useState(() => value.slice(0, 4));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const initial = selectedDate ?? new Date();
    return new Date(initial.getFullYear(), initial.getMonth(), 1);
  });
  const [calendarStyle, setCalendarStyle] = useState<CSSProperties>({});
  const dateInputRef = useRef<HTMLDivElement>(null);
  const dayRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const suppressFocusOpenRef = useRef(false);
  const calendarId = useId();
  const errorId = useId();

  useEffect(() => {
    setDay(value.slice(8, 10));
    setMonth(value.slice(5, 7));
    setYear(value.slice(0, 4));
    setError('');
  }, [value]);

  useEffect(() => {
    const input = dayRef.current;
    if (!input) return;
    const empty = !day && !month && !year;
    const valid = empty ? !required : Boolean(datePartsIso(day, month, year));
    input.setCustomValidity(valid ? '' : empty ? 'Informe uma data.' : 'Informe uma data válida no formato dd/mm/aaaa.');
  }, [day, month, required, year]);

  const updateCalendarPosition = useCallback(() => {
    const input = dateInputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
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
    setVisibleMonth((current) => {
      const initial = selectedDate ?? current;
      return new Date(validYear(year) ?? initial.getFullYear(), (validMonth(month) ?? initial.getMonth() + 1) - 1, 1);
    });
    updateCalendarPosition();
    setOpen(true);
  };

  const closeCalendar = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      suppressFocusOpenRef.current = true;
      window.requestAnimationFrame(() => dayRef.current?.focus());
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    updateCalendarPosition();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!dateInputRef.current?.contains(target) && !calendarRef.current?.contains(target)) closeCalendar();
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
  const previewDate = previewDateIso(day, month, year, visibleMonth);

  const moveMonth = (amount: number) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  };

  const chooseDate = (date: Date) => {
    setError('');
    onChange(localDateIso(date));
    closeCalendar(true);
  };

  const applyParts = (nextDay: string, nextMonth: string, nextYear: string) => {
    setError('');
    const monthNumber = validMonth(nextMonth);
    const yearNumber = validYear(nextYear);
    if (monthNumber || yearNumber) {
      setVisibleMonth((current) => new Date(
        yearNumber ?? current.getFullYear(),
        (monthNumber ?? current.getMonth() + 1) - 1,
        1,
      ));
    }
    const iso = datePartsIso(nextDay, nextMonth, nextYear);
    if (iso) onChange(iso);
    else if (!nextDay && !nextMonth && !nextYear) onChange('');
  };

  const focusPart = (ref: React.RefObject<HTMLInputElement | null>) => {
    window.requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
  };

  const handlePartFocus = (event: React.FocusEvent<HTMLInputElement>) => {
    event.currentTarget.select();
    if (suppressFocusOpenRef.current) {
      suppressFocusOpenRef.current = false;
      return;
    }
    if (!open) openCalendar();
  };

  const handleDateBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && (dateInputRef.current?.contains(next) || calendarRef.current?.contains(next))) return;
    closeCalendar();
  };

  const handleDatePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const digits = event.clipboardData.getData('text').replace(/\D/g, '');
    if (digits.length !== 8) return;
    event.preventDefault();
    const nextDay = digits.slice(0, 2);
    const nextMonth = digits.slice(2, 4);
    const nextYear = digits.slice(4, 8);
    setDay(nextDay);
    setMonth(nextMonth);
    setYear(nextYear);
    applyParts(nextDay, nextMonth, nextYear);
    focusPart(yearRef);
  };

  return (
    <div className={`field ${className}`}>
      <span>{label}</span>
      <div
        ref={dateInputRef}
        className={`date-input date-input--segmented ${open ? 'date-input--open' : ''} ${error ? 'is-invalid' : ''}`}
        onPaste={handleDatePaste}
        onBlur={handleDateBlur}
      >
        <input
          ref={dayRef}
          className="date-input__segment date-input__segment--day"
          inputMode="numeric"
          autoComplete="off"
          maxLength={2}
          value={day}
          placeholder="dd"
          aria-label={`${label}: dia`}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onInvalid={(event) => {
            event.preventDefault();
            const empty = !day && !month && !year;
            setError(empty ? 'Informe uma data.' : 'Informe uma data válida no formato dd/mm/aaaa.');
          }}
          onFocus={handlePartFocus}
          onChange={(event) => {
            const nextDay = event.target.value.replace(/\D/g, '').slice(0, 2);
            setDay(nextDay);
            applyParts(nextDay, month, year);
            if (nextDay.length === 2) focusPart(monthRef);
          }}
          onKeyDown={(event) => {
            if (event.altKey && event.key === 'ArrowDown') {
              event.preventDefault();
              openCalendar();
            }
          }}
        />
        <span className="date-input__separator" aria-hidden="true">/</span>
        <input
          ref={monthRef}
          className="date-input__segment date-input__segment--month"
          inputMode="numeric"
          autoComplete="off"
          maxLength={2}
          value={month}
          placeholder="mm"
          aria-label={`${label}: mês`}
          onFocus={handlePartFocus}
          onChange={(event) => {
            const nextMonth = event.target.value.replace(/\D/g, '').slice(0, 2);
            setMonth(nextMonth);
            applyParts(day, nextMonth, year);
            if (nextMonth.length === 2) focusPart(yearRef);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && !month) {
              event.preventDefault();
              focusPart(dayRef);
            } else if (event.altKey && event.key === 'ArrowDown') {
              event.preventDefault();
              openCalendar();
            }
          }}
        />
        <span className="date-input__separator" aria-hidden="true">/</span>
        <input
          ref={yearRef}
          className="date-input__segment date-input__segment--year"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={year}
          placeholder="aaaa"
          aria-label={`${label}: ano`}
          onFocus={handlePartFocus}
          onChange={(event) => {
            const nextYear = event.target.value.replace(/\D/g, '').slice(0, 4);
            setYear(nextYear);
            applyParts(day, month, nextYear);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && !year) {
              event.preventDefault();
              focusPart(monthRef);
            } else if (event.altKey && event.key === 'ArrowDown') {
              event.preventDefault();
              openCalendar();
            }
          }}
        />
        <button
          ref={triggerRef}
          type="button"
          tabIndex={-1}
          aria-label={`Abrir calendário: ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? calendarId : undefined}
          onClick={() => (open ? closeCalendar() : openCalendar())}
        >
          <CalendarDays size={16} aria-hidden="true" />
        </button>
      </div>
      {error && <small id={errorId} className="field__error" role="alert">{error}</small>}
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
                  className={`${outside ? 'is-outside' : ''} ${iso === previewDate ? 'is-selected' : ''} ${iso === today ? 'is-today' : ''}`}
                  aria-label={formatDate(iso, "dd 'de' MMMM 'de' yyyy")}
                  aria-pressed={iso === previewDate}
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

const monthInputText = (value: string) => {
  const digits = value.replace(/\D/g, '').slice(0, 6);
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}/${digits.slice(2)}`;
};

const monthInputIso = (value: string) => {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 6) return null;
  const month = Number(digits.slice(0, 2));
  const year = Number(digits.slice(2));
  return month >= 1 && month <= 12 && year >= 1000
    ? `${year}-${String(month).padStart(2, '0')}`
    : null;
};

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
  const [draft, setDraft] = useState(() => value ? `${value.slice(5, 7)}/${value.slice(0, 4)}` : '');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [visibleYear, setVisibleYear] = useState(selectedYear || new Date().getFullYear());
  const [pickerStyle, setPickerStyle] = useState<CSSProperties>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerId = useId();
  const errorId = useId();

  useEffect(() => {
    setDraft(value ? `${value.slice(5, 7)}/${value.slice(0, 4)}` : '');
    setError('');
  }, [value]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const parsed = monthInputIso(draft);
    input.setCustomValidity(!parsed
      ? 'Informe um mês válido no formato mm/aaaa.'
      : min && parsed < min ? `Escolha ${monthLabel(min)} ou um mês posterior.` : '');
  }, [draft, min]);

  const updatePickerPosition = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
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
    if (restoreFocus) window.requestAnimationFrame(() => inputRef.current?.focus());
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
    setError('');
    onChange(month);
    closePicker(true);
  };

  return (
    <div className={`field ${className}`}>
      <span className="field__label">{label}{hint && <HelpTip label={label} align={className.includes('form-grid__full') ? 'start' : 'end'}>{hint}</HelpTip>}</span>
      <div className={`date-input ${open ? 'date-input--open' : ''} ${error ? 'is-invalid' : ''}`}>
        <input
          ref={inputRef}
          required
          inputMode="numeric"
          autoComplete="off"
          maxLength={7}
          value={draft}
          placeholder="mm/aaaa"
          aria-label={label}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onFocus={(event) => event.currentTarget.select()}
          onInvalid={(event) => {
            event.preventDefault();
            const parsed = monthInputIso(draft);
            setError(!parsed
              ? 'Informe um mês válido no formato mm/aaaa.'
              : `Escolha ${monthLabel(min ?? parsed)} ou um mês posterior.`);
          }}
          onChange={(event) => {
            const nextDraft = monthInputText(event.target.value);
            setError('');
            setDraft(nextDraft);
            const parsed = monthInputIso(nextDraft);
            if (parsed) onChange(parsed);
          }}
          onKeyDown={(event) => {
            if (event.altKey && event.key === 'ArrowDown') {
              event.preventDefault();
              openPicker();
            }
          }}
        />
        <button
          ref={triggerRef}
          type="button"
          tabIndex={-1}
          aria-label={`Abrir seletor de mês: ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? pickerId : undefined}
          onClick={() => (open ? closePicker() : openPicker())}
        >
          <CalendarDays size={16} aria-hidden="true" />
        </button>
      </div>
      {error && <small id={errorId} className="field__error" role="alert">{error}</small>}
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
