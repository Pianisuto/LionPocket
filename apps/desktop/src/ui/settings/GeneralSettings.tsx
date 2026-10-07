import { Moon, Sun } from 'lucide-react';
import type { Theme } from '../theme';
import { SettingsGroup, SettingsRow } from './SettingsKit';
import type { SettingsContext } from './sections';

const themes: Array<{ value: Theme; label: string; icon: typeof Moon }> = [
  { value: 'dark', label: 'Escuro', icon: Moon },
  { value: 'light', label: 'Claro', icon: Sun },
];

export function GeneralSettings({
  theme,
  onThemeChange,
  showPriorities,
  onShowPrioritiesChange,
}: SettingsContext) {
  return (
    <div className="settings-general">
      <SettingsGroup title="Aparência" description="Como o LionPocket aparece neste computador.">
        <SettingsRow
          title="Tema"
          description="O escuro ameixa é o visual padrão. A escolha fica salva neste computador."
          control={
            <div className="settings-segmented" role="radiogroup" aria-label="Tema">
              {themes.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={theme === value}
                  className={theme === value ? 'is-selected' : ''}
                  onClick={() => onThemeChange(value)}
                >
                  <Icon size={15} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Exibição" description="Escolha quais recursos aparecem no seu dia a dia.">
        <SettingsRow
          title="Mostrar prioridades nos lançamentos"
          description="Exibe a área para fixar e ordenar as contas mais importantes. Ocultar mantém a ordem salva."
          htmlFor="settings-show-priorities"
          control={
            <input
              id="settings-show-priorities"
              className="settings-switch"
              type="checkbox"
              role="switch"
              checked={showPriorities}
              onChange={(event) => onShowPrioritiesChange(event.target.checked)}
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}
