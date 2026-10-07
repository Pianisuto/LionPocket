import { settingsSections, type SettingsContext, type SettingsSectionId } from './sections';

/** Settings with a side navigation: one area at a time, each with its own page. */
export function SettingsScreen({
  section,
  onSectionChange,
  ...context
}: SettingsContext & {
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
}) {
  const active = settingsSections.find((item) => item.id === section) ?? settingsSections[0];
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Áreas das configurações">
        {settingsSections.map((item) => {
          const Icon = item.icon;
          const current = item.id === active.id;
          return (
            <button
              key={item.id}
              type="button"
              className={current ? 'is-active' : ''}
              aria-current={current ? 'page' : undefined}
              onClick={() => onSectionChange(item.id)}
            >
              <span className="settings-nav__icon"><Icon size={18} aria-hidden="true" /></span>
              <span className="settings-nav__text">
                <strong>{item.label}</strong>
                <small>{item.summary}</small>
              </span>
            </button>
          );
        })}
      </nav>
      <section className="settings-page" aria-labelledby="settings-page-title">
        <header className="settings-page__header">
          <div>
            <h2 id="settings-page-title">{active.label}</h2>
            <p>{active.description}</p>
          </div>
          {'badge' in active && active.badge}
        </header>
        <div className="settings-page__body" key={active.id}>
          {active.render(context)}
        </div>
      </section>
    </div>
  );
}
