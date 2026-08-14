import { useState } from 'react';
import { DatabaseBackup, Download, FileJson, FileSpreadsheet, HardDrive, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { CatalogInput, Catalogs, MoneyKind } from '../../shared/types';
import { SelectField } from '../components';

export const Settings = ({ catalogs, month, refreshCatalogs, notify }: {
  catalogs: Catalogs;
  month: string;
  refreshCatalogs: () => Promise<void>;
  notify: (message: string) => void;
}) => {
  const [newName, setNewName] = useState('');
  const [type, setType] = useState<CatalogInput['type']>('category');
  const [kind, setKind] = useState<MoneyKind>('expense');
  const [cardDueDay, setCardDueDay] = useState('10');
  const [editingCardId, setEditingCardId] = useState('');
  const [deletingCatalogId, setDeletingCatalogId] = useState('');
  const [busy, setBusy] = useState('');
  const run = async (name: string, action: () => Promise<string | null | object>) => {
    setBusy(name);
    try {
      const result = await action();
      if (result) notify(name === 'import' ? `Planilha importada: ${Object.values(result as object).join(' registros, ')} registros.` : 'Arquivo criado com sucesso.');
    } finally { setBusy(''); }
  };
  const addCatalog = async (event: React.FormEvent) => {
    event.preventDefault();
    await window.lionPocket.createCatalogItem({
      id: editingCardId || undefined,
      type,
      name: newName,
      kind,
      dueDay: type === 'card' ? Number(cardDueDay) : undefined,
    });
    setNewName('');
    setEditingCardId('');
    await refreshCatalogs();
    notify(editingCardId ? 'Cartão atualizado.' : 'Item adicionado à lista.');
  };
  const chooseType = (value: string) => {
    setType(value as CatalogInput['type']);
    setEditingCardId('');
    setNewName('');
  };
  const editCard = (card: Catalogs['cards'][number]) => {
    setType('card');
    setEditingCardId(card.id);
    setNewName(card.name);
    setCardDueDay(String(card.dueDay));
  };
  const cancelCardEdit = () => {
    setEditingCardId('');
    setNewName('');
  };
  const deleteCatalogItem = async (itemType: 'category' | 'card', item: { id: string; name: string }) => {
    const itemLabel = itemType === 'card' ? 'cartão' : 'categoria';
    const unlinkLabel = itemType === 'card' ? 'sem cartão informado' : 'sem categoria';
    if (!window.confirm(`Excluir ${itemLabel} “${item.name}”? Os lançamentos existentes serão preservados e ficarão ${unlinkLabel}.`)) return;
    setDeletingCatalogId(item.id);
    try {
      await window.lionPocket.deleteCatalogItem(itemType, item.id);
      if (editingCardId === item.id) cancelCardEdit();
      await refreshCatalogs();
      notify(`${itemType === 'card' ? 'Cartão' : 'Categoria'} excluída.`);
    } finally {
      setDeletingCatalogId('');
    }
  };
  const categoryList = (categoryKind: MoneyKind) => catalogs.categories.filter((item) => item.kind === categoryKind);
  return (
    <section className="page-section settings-grid">
      <div className="panel settings-panel">
        <header className="panel__header"><div className="settings-icon"><HardDrive size={20} /></div><div><h3>Seus dados</h3><p>Importe a planilha, faça cópias e leve seus lançamentos com você.</p></div></header>
        <div className="settings-actions">
          <button disabled={Boolean(busy)} onClick={() => run('import', () => window.lionPocket.importSpreadsheet())}><FileSpreadsheet size={21} /><span><strong>Importar planilha</strong><small>Lê o arquivo Planejamento_Financeiro_2026.xlsx</small></span><Download size={17} /></button>
          <button disabled={Boolean(busy)} onClick={() => run('backup', () => window.lionPocket.createBackup())}><DatabaseBackup size={21} /><span><strong>Criar cópia de segurança</strong><small>Salva uma cópia completa do banco local</small></span><Download size={17} /></button>
          <button disabled={Boolean(busy)} onClick={() => run('csv', () => window.lionPocket.exportCsv(month))}><FileSpreadsheet size={21} /><span><strong>Exportar mês em CSV</strong><small>Abre no Excel, LibreOffice ou Google Planilhas</small></span><Download size={17} /></button>
          <button disabled={Boolean(busy)} onClick={() => run('json', () => window.lionPocket.exportJson())}><FileJson size={21} /><span><strong>Exportar tudo em JSON</strong><small>Arquivo completo para uso futuro</small></span><Download size={17} /></button>
        </div>
      </div>

      <div className="panel settings-panel">
        <header className="panel__header"><div className="settings-icon settings-icon--safe"><ShieldCheck size={20} /></div><div><h3>Privacidade local</h3><p>Nesta versão, nada sai do seu computador.</p></div></header>
        <div className="privacy-card"><ShieldCheck size={26} /><div><strong>Banco local protegido pelo sistema</strong><p>O LionPocket não envia dados para a internet. Para proteção contra acesso físico ao computador, mantenha a criptografia de disco do Linux ou Windows ativada.</p></div></div>
      </div>

      <div className="panel settings-panel settings-panel--wide">
        <header className="panel__header"><div><h3>Listas personalizadas</h3><p>Adicione categorias, formas de pagamento e cartões aos formulários.</p></div></header>
        <form className="catalog-form" onSubmit={addCatalog}>
          <SelectField label="Tipo de lista" value={type} onChange={chooseType} options={[{ value: 'category', label: 'Categoria' }, { value: 'paymentMethod', label: 'Forma de pagamento' }, { value: 'card', label: 'Cartão' }]} />
          {type === 'category' && <SelectField label="Usada em" value={kind} onChange={(value) => setKind(value as MoneyKind)} options={[{ value: 'expense', label: 'Saídas' }, { value: 'income', label: 'Entradas' }]} />}
          <label className="field catalog-form__name"><span>Nome</span><input required value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Digite o nome" /></label>
          {type === 'card' && <label className="field"><span>Dia do vencimento</span><input required min="1" max="31" type="number" value={cardDueDay} onChange={(event) => setCardDueDay(event.target.value)} /></label>}
          <div className="catalog-form__actions">
            {editingCardId && <button type="button" className="button button--ghost" onClick={cancelCardEdit}>Cancelar</button>}
            <button className="button button--primary">{editingCardId ? <Pencil size={17} /> : <Plus size={17} />}{editingCardId ? 'Salvar' : 'Adicionar'}</button>
          </div>
        </form>
        <div className="catalog-columns">
          <div className="catalog-category-groups">
            {(['income', 'expense'] as const).map((categoryKind) => (
              <div key={categoryKind}>
                <h4>Categorias de {categoryKind === 'income' ? 'entrada' : 'saída'} <span>{categoryList(categoryKind).length}</span></h4>
                <div className="tag-list">{categoryList(categoryKind).map((item) => (
                  <span key={item.id}>
                    <i style={{ background: item.color }} />{item.name}
                    <button
                      type="button"
                      className="tag-item__action tag-item__action--danger"
                      disabled={deletingCatalogId === item.id}
                      onClick={() => deleteCatalogItem('category', item)}
                      title={`Excluir ${item.name}`}
                      aria-label={`Excluir categoria ${item.name}`}
                    ><Trash2 size={12} /></button>
                  </span>
                ))}</div>
              </div>
            ))}
          </div>
          <div><h4>Formas e cartões</h4><div className="tag-list">{catalogs.paymentMethods.map((item) => <span key={item.id}>{item.name}</span>)}{catalogs.cards.map((item) => (
            <span className="tag-card" key={item.id}>
              {item.name} · vence dia {item.dueDay}
              <button type="button" className="tag-item__action" onClick={() => editCard(item)} title={`Editar ${item.name}`} aria-label={`Editar cartão ${item.name}`}><Pencil size={12} /></button>
              <button
                type="button"
                className="tag-item__action tag-item__action--danger"
                disabled={deletingCatalogId === item.id}
                onClick={() => deleteCatalogItem('card', item)}
                title={`Excluir ${item.name}`}
                aria-label={`Excluir cartão ${item.name}`}
              ><Trash2 size={12} /></button>
            </span>
          ))}</div></div>
        </div>
      </div>
    </section>
  );
};
