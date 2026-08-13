import { useState } from 'react';
import { DatabaseBackup, Download, FileJson, FileSpreadsheet, HardDrive, Plus, ShieldCheck } from 'lucide-react';
import type { CatalogInput, Catalogs, MoneyKind } from '../../shared/types';

export const Settings = ({ catalogs, month, refreshCatalogs, notify }: {
  catalogs: Catalogs;
  month: string;
  refreshCatalogs: () => Promise<void>;
  notify: (message: string) => void;
}) => {
  const [newName, setNewName] = useState('');
  const [type, setType] = useState<CatalogInput['type']>('category');
  const [kind, setKind] = useState<MoneyKind>('expense');
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
    await window.lionPocket.createCatalogItem({ type, name: newName, kind });
    setNewName('');
    await refreshCatalogs();
    notify('Item adicionado à lista.');
  };
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
          <label className="field"><span>Tipo de lista</span><select value={type} onChange={(event) => setType(event.target.value as CatalogInput['type'])}><option value="category">Categoria</option><option value="paymentMethod">Forma de pagamento</option><option value="card">Cartão</option></select></label>
          {type === 'category' && <label className="field"><span>Usada em</span><select value={kind} onChange={(event) => setKind(event.target.value as MoneyKind)}><option value="expense">Saídas</option><option value="income">Entradas</option></select></label>}
          <label className="field catalog-form__name"><span>Nome</span><input required value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Digite o nome" /></label>
          <button className="button button--primary"><Plus size={17} /> Adicionar</button>
        </form>
        <div className="catalog-columns">
          <div><h4>Categorias de saída <span>{catalogs.categories.filter((item) => item.kind === 'expense').length}</span></h4><div className="tag-list">{catalogs.categories.filter((item) => item.kind === 'expense').map((item) => <span key={item.id}><i style={{ background: item.color }} />{item.name}</span>)}</div></div>
          <div><h4>Formas e cartões</h4><div className="tag-list">{catalogs.paymentMethods.map((item) => <span key={item.id}>{item.name}</span>)}{catalogs.cards.map((item) => <span className="tag-card" key={item.id}>{item.name}</span>)}</div></div>
        </div>
      </div>
    </section>
  );
};

