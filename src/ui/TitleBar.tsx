import { useEffect, useState } from 'react';
import { Minus, Moon, Plus, Square, SunMedium, X } from 'lucide-react';
import { LionMark } from './Lion';
import type { Theme } from './theme';

/** Ícone de restaurar: dois quadrados sobrepostos, como no gerenciador nativo. */
const RestoreIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="2.5" y="4.5" width="8" height="8" rx="1.5" />
    <path d="M5.2 4.3V3.2a1.5 1.5 0 0 1 1.5-1.5h5.8a1.5 1.5 0 0 1 1.5 1.5V9a1.5 1.5 0 0 1-1.5 1.5h-1.1" />
  </svg>
);

/**
 * Barra de título do próprio app: a janela é criada sem moldura do sistema
 * (frame: false), então arrastar, maximizar e fechar passam por aqui.
 */
export const TitleBar = ({
  theme,
  onToggleTheme,
  subtitle,
  showAddTransaction,
  onAddTransaction,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  subtitle: string;
  showAddTransaction: boolean;
  onAddTransaction: () => void;
}) => {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.lionPocket.isWindowMaximized().then(setMaximized).catch(() => undefined);
    return window.lionPocket.onWindowState((state) => setMaximized(state.maximized));
  }, []);

  const toggleMaximize = () => {
    window.lionPocket.toggleMaximizeWindow().then(setMaximized).catch(() => undefined);
  };

  return (
    <header className="titlebar" onDoubleClick={toggleMaximize}>
      <div className="titlebar__brand">
        <LionMark className="titlebar__mark" />
        <div className="titlebar__names">
          <strong>
            Lion<span>Pocket</span>
          </strong>
          <small>{subtitle}</small>
        </div>
      </div>

      {/* Faixa arrastável: tudo que não for botão move a janela. */}
      <div className="titlebar__drag" />

      {showAddTransaction && (
        <button className="titlebar__quick-add" onClick={onAddTransaction} onDoubleClick={(event) => event.stopPropagation()} aria-label="Adicionar lançamento">
          <Plus size={14} /> Lançamento
        </button>
      )}

      <div className="titlebar__controls">
        <button
          className="titlebar__button titlebar__button--theme"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Mudar para o tema claro' : 'Mudar para o tema escuro'}
          aria-label={theme === 'dark' ? 'Mudar para o tema claro' : 'Mudar para o tema escuro'}
        >
          {theme === 'dark' ? <SunMedium size={15} /> : <Moon size={15} />}
        </button>
        <span className="titlebar__divider" />
        <button className="titlebar__button" onClick={() => window.lionPocket.minimizeWindow()} aria-label="Minimizar">
          <Minus size={15} />
        </button>
        <button
          className="titlebar__button"
          onClick={toggleMaximize}
          aria-label={maximized ? 'Restaurar' : 'Maximizar'}
        >
          {maximized ? <RestoreIcon /> : <Square size={13} />}
        </button>
        <button
          className="titlebar__button titlebar__button--close"
          onClick={() => window.lionPocket.closeWindow()}
          aria-label="Fechar"
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
};
