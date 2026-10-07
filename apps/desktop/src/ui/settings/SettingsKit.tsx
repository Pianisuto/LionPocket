import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** A titled block of related settings inside a settings page. */
export function SettingsGroup({
  title,
  description,
  count,
  action,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`settings-group ${className}`} aria-label={title}>
      <header className="settings-group__header">
        <div>
          <h3>
            {title}
            {count !== undefined && <span className="settings-count">{count}</span>}
          </h3>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** One preference: what it does on the left, its control on the right. */
export function SettingsRow({
  title,
  description,
  control,
  htmlFor,
}: {
  title: string;
  description?: string;
  control: ReactNode;
  htmlFor?: string;
}) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className="settings-row">
      <Label className="settings-row__text" htmlFor={htmlFor}>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </Label>
      <div className="settings-row__control">{control}</div>
    </div>
  );
}

/** A whole row that runs one action, such as an export. */
export function SettingsActionRow({
  icon: Icon,
  title,
  description,
  actionIcon: ActionIcon,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actionIcon: LucideIcon;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="settings-action-row" disabled={disabled} onClick={onClick}>
      <span className="settings-action-row__icon"><Icon size={19} aria-hidden="true" /></span>
      <span className="settings-action-row__text">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <ActionIcon size={17} aria-hidden="true" className="settings-action-row__go" />
    </button>
  );
}

/** Context notes, such as where the data is stored. */
export function SettingsNote({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-note">
      <Icon size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}
