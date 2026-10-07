import { useState } from 'react';
import type { CatalogInput } from '@lionpocket/core/types';
import { ConfirmDialog } from '../../components';
import type { SettingsContext } from '../sections';
import { CardCatalog, CategoryCatalog, PaymentMethodCatalog } from './CatalogLists';

type DeletableType = 'category' | 'card';

export type CatalogActions = {
  /** Resolves true when saved, so forms know whether to clear. */
  save: (input: CatalogInput) => Promise<boolean>;
  requestDelete: (type: DeletableType, item: { id: string; name: string }) => void;
  deletingId: string;
};

const deleteCopy: Record<DeletableType, { noun: string; article: string; done: string; detached: string }> = {
  category: { noun: 'categoria', article: 'a categoria', done: 'Categoria excluída.', detached: 'sem categoria' },
  card: { noun: 'cartão', article: 'o cartão', done: 'Cartão excluído.', detached: 'sem cartão informado' },
};

export function CatalogSettings({ catalogs, refreshCatalogs, notify }: SettingsContext) {
  const [deletingId, setDeletingId] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{
    type: DeletableType;
    item: { id: string; name: string };
  } | null>(null);

  const actions: CatalogActions = {
    deletingId,
    requestDelete: (type, item) => setPendingDelete({ type, item }),
    save: async (input) => {
      try {
        await window.lionPocket.createCatalogItem(input);
        await refreshCatalogs();
        notify(input.id ? 'Cartão atualizado.' : 'Item adicionado à lista.');
        return true;
      } catch {
        notify('Não foi possível salvar o cadastro.');
        return false;
      }
    },
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { type, item } = pendingDelete;
    const copy = deleteCopy[type];
    setDeletingId(item.id);
    try {
      await window.lionPocket.deleteCatalogItem(type, item.id);
      await refreshCatalogs();
      setPendingDelete(null);
      notify(copy.done);
    } catch {
      notify(`Não foi possível excluir ${copy.article}.`);
    } finally {
      setDeletingId('');
    }
  };

  const copy = pendingDelete && deleteCopy[pendingDelete.type];
  return (
    <>
      <CategoryCatalog catalogs={catalogs} actions={actions} />
      <PaymentMethodCatalog catalogs={catalogs} actions={actions} />
      <CardCatalog catalogs={catalogs} actions={actions} />
      {pendingDelete && copy && (
        <ConfirmDialog
          title={`Excluir ${copy.noun}?`}
          itemName={pendingDelete.item.name}
          description={`Os lançamentos existentes serão preservados e ficarão ${copy.detached}.`}
          confirmLabel={`Excluir ${copy.noun}`}
          loading={deletingId === pendingDelete.item.id}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </>
  );
}
