import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarSync,
  CreditCard,
  LayoutDashboard,
  Plus,
  ReceiptText,
  RefreshCw,
  Settings as SettingsIcon,
  Target,
  X,
} from 'lucide-react';
import type {
  Catalogs,
  Goal,
  InstallmentPurchase,
  Overview,
  RecurringExpense,
  Transaction,
  UpdateInfo,
} from './shared/types';
import { Modal, MonthPicker } from './ui/components';
import { Leo } from './ui/Leo';
import { TitleBar } from './ui/TitleBar';
import { useTheme } from './ui/theme';
import { GoalForm, InstallmentForm, RecurringForm, TransactionForm } from './ui/forms';
import { currentMonthIso, monthLabel, todayIso } from './ui/format';
import { Dashboard } from './ui/screens/Dashboard';
import { Goals } from './ui/screens/Goals';
import { Installments } from './ui/screens/Installments';
import { Recurring } from './ui/screens/Recurring';
import { Settings } from './ui/screens/Settings';
import { Transactions } from './ui/screens/Transactions';

type View = 'dashboard' | 'transactions' | 'recurring' | 'installments' | 'goals' | 'settings';
type ModalState =
  | { type: 'transaction'; item?: Transaction | null }
  | { type: 'recurring'; item?: RecurringExpense | null }
  | { type: 'installment'; item?: InstallmentPurchase | null }
  | { type: 'goal'; item?: Goal | null }
  | null;

const emptyCatalogs: Catalogs = { categories: [], paymentMethods: [], cards: [] };

const views: Array<{ id: View; label: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: 'Visão geral', icon: <LayoutDashboard size={20} /> },
  { id: 'transactions', label: 'Lançamentos', icon: <ReceiptText size={20} /> },
  { id: 'recurring', label: 'Recorrências', icon: <CalendarSync size={20} /> },
  { id: 'installments', label: 'Parcelas', icon: <CreditCard size={20} /> },
  { id: 'goals', label: 'Objetivos', icon: <Target size={20} /> },
];

const pageCopy: Record<View, { title: string; subtitle: string }> = {
  dashboard: { title: 'Visão geral', subtitle: 'O seu mês inteiro em uma olhada.' },
  transactions: { title: 'Lançamentos', subtitle: 'Tudo que entra e sai, no mesmo lugar.' },
  recurring: { title: 'Recorrências', subtitle: 'Entradas e saídas que acompanham você todo mês.' },
  installments: { title: 'Compras parceladas', subtitle: 'Compromissos futuros sem surpresas.' },
  goals: { title: 'Objetivos', subtitle: 'Transforme vontade em um plano possível.' },
  settings: { title: 'Configurações', subtitle: 'Dados, cópias e listas do seu jeito.' },
};

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [view, setView] = useState<View>('dashboard');
  const [month, setMonth] = useState(currentMonthIso);
  const [catalogs, setCatalogs] = useState<Catalogs>(emptyCatalogs);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState('');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3500);
  }, []);

  const refreshCatalogs = useCallback(async () => {
    setCatalogs(await window.lionPocket.getCatalogs());
  }, []);

  useEffect(() => {
    refreshCatalogs().catch(() => notify('Não foi possível carregar as listas.'));
  }, [refreshCatalogs, notify]);

  useEffect(() => window.lionPocket.onUpdateDownloaded(setUpdateInfo), []);

  useEffect(() => {
    let active = true;
    setOverviewLoading(true);
    window.lionPocket
      .getOverview(month)
      .then((data) => {
        if (active) setOverview(data);
      })
      .catch(() => notify('Não foi possível carregar o resumo.'))
      .finally(() => {
        if (active) setOverviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [month, refreshKey, notify]);

  // Ctrl+N abre um lançamento novo de qualquer tela — quem está preenchendo
  // um mês inteiro não precisa voltar ao botão a cada item.
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'n') return;
      event.preventDefault();
      setModal((current) => current ?? { type: 'transaction' });
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const changed = useCallback(() => setRefreshKey((value) => value + 1), []);
  const defaultDate = useMemo(() => {
    const today = todayIso();
    return today.startsWith(month) ? today : `${month}-01`;
  }, [month]);

  const safeAction = async (
    action: () => Promise<void>,
    successMessage: string,
    keepOpen = false,
  ) => {
    try {
      await action();
      if (!keepOpen) setModal(null);
      changed();
      notify(successMessage);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Algo não saiu como esperado.');
      return false;
    }
  };

  return (
    <div className="app-shell">
      <TitleBar theme={theme} onToggleTheme={toggleTheme} subtitle="Seu dinheiro, do seu jeito" />

      <div className="app-body">
      <aside className="sidebar">
        <nav className="sidebar__nav" aria-label="Navegação principal">
          <span className="sidebar__label">Meu dinheiro</span>
          {views.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? 'active' : ''}
              onClick={() => setView(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar__bottom">
          <button
            className={view === 'settings' ? 'active' : ''}
            onClick={() => setView('settings')}
          >
            <SettingsIcon size={20} />
            <span>Configurações</span>
          </button>
          <div className="local-badge">
            <span className="local-badge__dot" />
            <div>
              <strong>Dados locais</strong>
              <small>Somente neste computador</small>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <h1>{pageCopy[view].title}</h1>
            <p>{pageCopy[view].subtitle}</p>
          </div>
          <div className="topbar__actions">
            <MonthPicker month={month} onChange={setMonth} />
            {view !== 'settings' && (
              <button
                className="button button--primary button--compact"
                onClick={() => setModal({ type: 'transaction' })}
              >
                <Plus size={18} /> Adicionar
              </button>
            )}
          </div>
        </header>

        <div className="page-content">
          {view === 'dashboard' && (
            <Dashboard
              overview={overview}
              loading={overviewLoading}
              onAddTransaction={() => setModal({ type: 'transaction' })}
              onNavigate={(next) => setView(next as View)}
              onEditTransaction={(item) => setModal({ type: 'transaction', item })}
              onSettleTransactions={(items) =>
                safeAction(
                  () => window.lionPocket.settleTransactions(items.map((item) => item.id)).then(() => undefined),
                  items.length === 1 ? 'Conta marcada como paga.' : `${items.length} compras da fatura marcadas como pagas.`,
                )
              }
            />
          )}
          {view === 'transactions' && (
            <Transactions
              month={month}
              refreshKey={refreshKey}
              onAdd={() => setModal({ type: 'transaction' })}
              onEdit={(item) => setModal({ type: 'transaction', item })}
              onChanged={changed}
              notify={notify}
            />
          )}
          {view === 'recurring' && (
            <Recurring
              refreshKey={refreshKey}
              onAdd={() => setModal({ type: 'recurring' })}
              onEdit={(item) => setModal({ type: 'recurring', item })}
              onChanged={changed}
              notify={notify}
            />
          )}
          {view === 'installments' && (
            <Installments
              month={month}
              refreshKey={refreshKey}
              onAdd={() => setModal({ type: 'installment' })}
              onEdit={(item) => setModal({ type: 'installment', item })}
              onChanged={changed}
              notify={notify}
            />
          )}
          {view === 'goals' && (
            <Goals
              refreshKey={refreshKey}
              onAdd={() => setModal({ type: 'goal' })}
              onEdit={(item) => setModal({ type: 'goal', item })}
              onChanged={changed}
              notify={notify}
            />
          )}
          {view === 'settings' && (
            <Settings
              catalogs={catalogs}
              month={month}
              refreshCatalogs={refreshCatalogs}
              notify={(message) => {
                notify(message);
                changed();
              }}
            />
          )}
        </div>
      </main>
      </div>

      <Leo
        overview={overview}
        month={month}
        theme={theme}
        onToggleTheme={toggleTheme}
        onQuickAdd={() => setModal({ type: 'transaction' })}
        onNavigate={(next) => setView(next as View)}
        notify={notify}
      />

      {modal?.type === 'transaction' && (
        <TransactionForm
          transaction={modal.item}
          catalogs={catalogs}
          defaultDate={defaultDate}
          onClose={() => setModal(null)}
          onSave={(input, options) =>
            safeAction(
              () => window.lionPocket.saveTransaction(input).then(() => undefined),
              input.cardId
                ? `${input.id ? 'Compra atualizada' : 'Compra adicionada'} na fatura de ${monthLabel(input.dueDate.slice(0, 7))}.`
                : input.id ? 'Lançamento atualizado.' : 'Lançamento adicionado.',
              options?.keepOpen,
            )
          }
        />
      )}
      {modal?.type === 'recurring' && (
        <RecurringForm
          item={modal.item}
          catalogs={catalogs}
          defaultStartMonth={month}
          onClose={() => setModal(null)}
          onSave={(input) =>
            safeAction(
              () => window.lionPocket.saveRecurringExpense(input).then(() => undefined),
              input.id ? 'Recorrência atualizada.' : 'Recorrência criada.',
            )
          }
        />
      )}
      {modal?.type === 'installment' && (
        <InstallmentForm
          item={modal.item}
          catalogs={catalogs}
          onClose={() => setModal(null)}
          onSave={(input) =>
            safeAction(
              () => window.lionPocket.saveInstallmentPurchase(input).then(() => undefined),
              input.id ? 'Compra parcelada atualizada.' : 'Parcelas criadas com sucesso.',
            )
          }
        />
      )}
      {modal?.type === 'goal' && (
        <GoalForm
          goal={modal.item}
          catalogs={catalogs}
          onClose={() => setModal(null)}
          onSave={(input) =>
            safeAction(
              () => window.lionPocket.saveGoal(input).then(() => undefined),
              input.id ? 'Objetivo atualizado.' : 'Objetivo criado.',
            )
          }
        />
      )}

      {updateInfo && (
        <Modal title="Atualização pronta" description="Uma nova versão do LionPocket já foi baixada." onClose={() => setUpdateInfo(null)} closeDisabled={installingUpdate}>
          <div className="update-dialog">
            <div className="update-dialog__content">
              <span><RefreshCw size={21} /></span>
              <div>
                <strong>{updateInfo.version ? `Versão ${updateInfo.version}` : 'Nova versão disponível'}</strong>
                <p>Reinicie o aplicativo agora para concluir a instalação. Seus dados serão preservados.</p>
              </div>
            </div>
            <div className="modal__actions">
              <button type="button" className="button button--ghost" disabled={installingUpdate} onClick={() => setUpdateInfo(null)}>Depois</button>
              <button type="button" className="button button--primary" disabled={installingUpdate} onClick={async () => {
                setInstallingUpdate(true);
                try {
                  await window.lionPocket.installUpdate();
                } catch {
                  setInstallingUpdate(false);
                  notify('Não foi possível reiniciar para atualizar.');
                }
              }}><RefreshCw size={16} /> {installingUpdate ? 'Reiniciando…' : 'Reiniciar e atualizar'}</button>
            </div>
          </div>
        </Modal>
      )}

      {toast && (
        <div className="toast">
          <span>{toast}</span>
          <button onClick={() => setToast('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
