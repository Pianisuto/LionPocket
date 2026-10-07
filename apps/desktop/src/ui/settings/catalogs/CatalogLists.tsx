import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, CreditCard as CardIcon, Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import type { Catalogs, CreditCard, MoneyKind } from '@lionpocket/core/types';
import { SettingsGroup } from '../SettingsKit';
import { CardForm, CatalogNameForm } from './CatalogForms';
import type { CatalogActions } from './CatalogSettings';

const kindCopy: Record<MoneyKind, { title: string; empty: string; singular: string; icon: typeof ArrowUpRight }> = {
  expense: { title: 'Saídas', empty: 'Nenhuma categoria de saída.', singular: 'saída', icon: ArrowDownRight },
  income: { title: 'Entradas', empty: 'Nenhuma categoria de entrada.', singular: 'entrada', icon: ArrowUpRight },
};

const AddButton = ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => (
  <button type="button" className="button button--soft button--compact" onClick={onClick} disabled={disabled}>
    <Plus size={16} aria-hidden="true" />{label}
  </button>
);

function CategoryColumn({ kind, catalogs, actions }: { kind: MoneyKind; catalogs: Catalogs; actions: CatalogActions }) {
  const [adding, setAdding] = useState(false);
  const copy = kindCopy[kind];
  const items = catalogs.categories.filter((item) => item.kind === kind);
  const Icon = copy.icon;
  return (
    <div className={`catalog-column catalog-column--${kind}`}>
      <header className="catalog-column__header">
        <h4><Icon size={16} aria-hidden="true" />{copy.title}<span className="settings-count">{items.length}</span></h4>
        <button
          type="button"
          className="icon-button"
          aria-label={`Adicionar categoria de ${copy.singular}`}
          title={`Adicionar categoria de ${copy.singular}`}
          disabled={adding}
          onClick={() => setAdding(true)}
        ><Plus size={17} /></button>
      </header>
      {adding && (
        <CatalogNameForm
          label={`Nome da categoria de ${copy.singular}`}
          placeholder="Nome da categoria"
          onSave={(name) => actions.save({ type: 'category', kind, name })}
          onCancel={() => setAdding(false)}
        />
      )}
      <ul className="catalog-list">
        {items.map((item) => (
          <li className="catalog-row" key={item.id}>
            <i className="catalog-row__swatch" style={{ background: item.color }} aria-hidden="true" />
            <span className="catalog-row__name">{item.name}</span>
            <div className="catalog-row__actions">
              <button
                type="button"
                className="icon-button icon-button--danger"
                disabled={actions.deletingId === item.id}
                onClick={() => actions.requestDelete('category', item)}
                title={`Excluir ${item.name}`}
                aria-label={`Excluir categoria ${item.name}`}
              ><Trash2 size={15} /></button>
            </div>
          </li>
        ))}
        {!items.length && !adding && <li className="catalog-empty">{copy.empty}</li>}
      </ul>
    </div>
  );
}

export function CategoryCatalog({ catalogs, actions }: { catalogs: Catalogs; actions: CatalogActions }) {
  return (
    <SettingsGroup
      title="Categorias"
      count={catalogs.categories.length}
      description="Organizam lançamentos, recorrências e relatórios. Entradas e saídas têm listas próprias."
    >
      <div className="catalog-columns">
        <CategoryColumn kind="expense" catalogs={catalogs} actions={actions} />
        <CategoryColumn kind="income" catalogs={catalogs} actions={actions} />
      </div>
    </SettingsGroup>
  );
}

export function PaymentMethodCatalog({ catalogs, actions }: { catalogs: Catalogs; actions: CatalogActions }) {
  const [adding, setAdding] = useState(false);
  return (
    <SettingsGroup
      title="Formas de pagamento"
      count={catalogs.paymentMethods.length}
      description="Como você paga ou recebe quando não usa um cartão de crédito."
      action={<AddButton label="Adicionar" disabled={adding} onClick={() => setAdding(true)} />}
    >
      {adding && (
        <CatalogNameForm
          label="Nome da forma de pagamento"
          placeholder="Ex.: Pix"
          onSave={(name) => actions.save({ type: 'paymentMethod', name })}
          onCancel={() => setAdding(false)}
        />
      )}
      <ul className="catalog-list catalog-list--grid">
        {catalogs.paymentMethods.map((item) => (
          <li className="catalog-row" key={item.id}>
            <Wallet size={16} aria-hidden="true" className="catalog-row__icon" />
            <span className="catalog-row__name">{item.name}</span>
          </li>
        ))}
        {!catalogs.paymentMethods.length && !adding && <li className="catalog-empty">Nenhuma forma de pagamento.</li>}
      </ul>
    </SettingsGroup>
  );
}

export function CardCatalog({ catalogs, actions }: { catalogs: Catalogs; actions: CatalogActions }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState('');
  const saveCard = (card?: CreditCard) => (input: { name: string; closingDay: number; dueDay: number }) =>
    actions.save({ type: 'card', id: card?.id, ...input }).then((saved) => {
      if (saved && card) setEditingId('');
      return saved;
    });
  return (
    <SettingsGroup
      title="Cartões de crédito"
      className="catalog-cards"
      count={catalogs.cards.length}
      description="O fechamento define em qual fatura cada compra entra; o vencimento, quando ela é paga."
      action={<AddButton label="Adicionar cartão" disabled={adding} onClick={() => { setAdding(true); setEditingId(''); }} />}
    >
      {adding && <CardForm onSave={saveCard()} onCancel={() => setAdding(false)} />}
      <ul className="catalog-list">
        {catalogs.cards.map((item) => editingId === item.id ? (
          <li key={item.id} className="catalog-row catalog-row--editing">
            <CardForm card={item} onSave={saveCard(item)} onCancel={() => setEditingId('')} />
          </li>
        ) : (
          <li className="catalog-row catalog-row--card" key={item.id}>
            <CardIcon size={17} aria-hidden="true" className="catalog-row__icon" />
            <span className="catalog-row__name">{item.name}</span>
            <span className={`catalog-row__meta catalog-row__closing ${item.closingDay === null ? 'is-missing' : ''}`}>
              {item.closingDay === null ? 'Fechamento não configurado' : <>Fecha dia <strong>{item.closingDay}</strong></>}
            </span>
            <span className="catalog-row__meta catalog-row__due">Vence dia <strong>{item.dueDay}</strong></span>
            <div className="catalog-row__actions">
              <button
                type="button"
                className="icon-button"
                onClick={() => { setEditingId(item.id); setAdding(false); }}
                title={`Editar ${item.name}`}
                aria-label={`Editar cartão ${item.name}`}
              ><Pencil size={15} /></button>
              <button
                type="button"
                className="icon-button icon-button--danger"
                disabled={actions.deletingId === item.id}
                onClick={() => actions.requestDelete('card', item)}
                title={`Excluir ${item.name}`}
                aria-label={`Excluir cartão ${item.name}`}
              ><Trash2 size={15} /></button>
            </div>
          </li>
        ))}
        {!catalogs.cards.length && !adding && <li className="catalog-empty">Nenhum cartão cadastrado.</li>}
      </ul>
    </SettingsGroup>
  );
}
