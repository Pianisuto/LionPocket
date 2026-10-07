import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Check, Plus } from 'lucide-react';
import type { CreditCard } from '@lionpocket/core/types';
import { NumberField } from '../../components';

const cancelOnEscape = (onCancel: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    onCancel();
  }
};

/**
 * Inline form for items identified only by name. It stays open after saving,
 * so several items can be added in sequence.
 */
export function CatalogNameForm({
  label,
  placeholder,
  onSave,
  onCancel,
}: {
  label: string;
  placeholder: string;
  onSave: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Informe um nome.');
      return;
    }
    setSaving(true);
    const saved = await onSave(name.trim());
    setSaving(false);
    if (saved) {
      setName('');
      input.current?.focus();
    }
  };
  return (
    <form className="catalog-inline-form" onSubmit={submit} onKeyDown={cancelOnEscape(onCancel)}>
      <label className="field">
        <input
          ref={input}
          autoFocus
          aria-label={label}
          aria-invalid={Boolean(error)}
          value={name}
          placeholder={placeholder}
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
        />
        {error && <small className="field__error" role="alert">{error}</small>}
      </label>
      <div className="catalog-inline-form__actions">
        <button type="button" className="button button--ghost button--compact" onClick={onCancel}>Cancelar</button>
        <button className="button button--primary button--compact" disabled={saving}>
          <Plus size={16} aria-hidden="true" />Adicionar
        </button>
      </div>
    </form>
  );
}

/** Adds or edits a credit card with its closing and due days. */
export function CardForm({
  card,
  onSave,
  onCancel,
}: {
  card?: CreditCard;
  onSave: (input: { name: string; closingDay: number; dueDay: number }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(card?.name ?? '');
  const [nameError, setNameError] = useState('');
  const [closingDay, setClosingDay] = useState(
    card ? (card.closingDay === null ? '' : String(card.closingDay)) : '14',
  );
  const [dueDay, setDueDay] = useState(card ? String(card.dueDay) : '10');
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setNameError('Informe um nome.');
      return;
    }
    setSaving(true);
    const saved = await onSave({ name: name.trim(), closingDay: Number(closingDay), dueDay: Number(dueDay) });
    setSaving(false);
    if (saved && !card) {
      setName('');
      onCancel();
    }
  };
  return (
    <form
      className="catalog-card-form"
      aria-label={card ? `Editar cartão ${card.name}` : 'Novo cartão'}
      onSubmit={submit}
      onKeyDown={cancelOnEscape(onCancel)}
    >
      <label className="field catalog-card-form__name">
        <span>Nome do cartão</span>
        <input
          required
          autoFocus
          aria-invalid={Boolean(nameError)}
          value={name}
          placeholder="Ex.: Nubank"
          onInvalid={(event) => {
            event.preventDefault();
            setNameError('Informe um nome.');
          }}
          onChange={(event) => {
            setName(event.target.value);
            setNameError('');
          }}
        />
        {nameError && <small className="field__error" role="alert">{nameError}</small>}
      </label>
      <NumberField label="Dia do fechamento" required min={1} max={31} value={closingDay} onChange={setClosingDay} />
      <NumberField label="Dia do vencimento" required min={1} max={31} value={dueDay} onChange={setDueDay} />
      <div className="catalog-inline-form__actions">
        <button type="button" className="button button--ghost button--compact" onClick={onCancel}>Cancelar</button>
        <button className="button button--primary button--compact" disabled={saving}>
          {card ? <Check size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
          {card ? 'Salvar' : 'Adicionar'}
        </button>
      </div>
    </form>
  );
}
