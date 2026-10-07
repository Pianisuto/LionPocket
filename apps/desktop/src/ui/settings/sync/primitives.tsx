import { pairingQr } from '@lionpocket/sync-local';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  CircleAlert,
  Link2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export function SyncSection({
  icon: Icon,
  title,
  description,
  tone,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  tone?: 'danger';
  children: ReactNode;
}) {
  return (
    <section className={`sync-section${tone ? ` sync-section--${tone}` : ''}`}>
      <header className="sync-section__header">
        <Icon size={18} aria-hidden="true" />
        <div>
          <h4>{title}</h4>
          {description && <p>{description}</p>}
        </div>
      </header>
      <div className="sync-section__body">{children}</div>
    </section>
  );
}

export function SyncDisclosure({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <details className="sync-disclosure">
      <summary>
        <Icon size={18} aria-hidden="true" />
        <span>
          <strong>{title}</strong>
          {description && <small>{description}</small>}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className="sync-disclosure__chevron"
        />
      </summary>
      <div className="sync-disclosure__body">{children}</div>
    </details>
  );
}

export function SyncNotice({
  title,
  tone,
  children,
}: {
  title: string;
  tone: 'error' | 'warning';
  children: ReactNode;
}) {
  return (
    <div className={`sync-notice sync-notice--${tone}`} role="alert">
      <CircleAlert size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

export function RecoveryCode({
  code,
  confirmed,
  onConfirmChange,
  busy,
  confirmLabel,
  onConfirm,
  recoveryDetails,
  onRegenerate,
}: {
  code: string;
  confirmed: string;
  onConfirmChange: (value: string) => void;
  busy: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  recoveryDetails?: { endpoint: string; recoveryPackage: string };
  onRegenerate?: () => void;
}) {
  return (
    <div className="sync-recovery-code">
      <div className="sync-recovery-code__steps">
        <section className="sync-recovery-step">
          <header className="sync-recovery-step__header">
            <span aria-hidden="true">1</span>
            <div>
              <h5>Guarde seu código</h5>
              <p>Salve fora do aplicativo, em um lugar seguro.</p>
            </div>
          </header>
          <div className="sync-fingerprint">
            <code>{code}</code>
          </div>
          {recoveryDetails && (
            <details className="sync-recovery-kit">
              <summary>
                <Link2 size={14} aria-hidden="true" />
                Pacote de recuperação para guardar
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <label className="field">
                <span>Guarde o pacote e o código de recuperação juntos</span>
                <textarea
                  readOnly
                  aria-label="Informações para recuperar seus dados"
                  value={`Servidor: ${recoveryDetails.endpoint}\nCódigo de recuperação: ${code}\nPacote de recuperação: ${recoveryDetails.recoveryPackage}`}
                />
              </label>
            </details>
          )}
        </section>
        <section className="sync-recovery-step">
          <header className="sync-recovery-step__header">
            <span aria-hidden="true">2</span>
            <div>
              <h5>Confirme o que guardou</h5>
              <p>Digite o código para concluir esta etapa.</p>
            </div>
          </header>
          <label className="field">
            <span>Digite o código que você guardou</span>
            <input
              aria-label="Digite o código que você guardou"
              type="password"
              autoComplete="off"
              value={confirmed}
              onChange={(e) => onConfirmChange(e.target.value)}
            />
          </label>
        </section>
      </div>
      <div className="sync-recovery-code__footer">
        {onRegenerate ? (
          <button
            className="button button--ghost"
            disabled={busy}
            onClick={onRegenerate}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Gerar outro código
          </button>
        ) : (
          <span className="sync-recovery-code__hint">
            <LockKeyhole size={14} aria-hidden="true" />A confirmação exige o
            código completo.
          </span>
        )}
        <button
          className="button button--primary"
          disabled={busy || confirmed !== code}
          onClick={onConfirm}
        >
          <ShieldCheck size={16} aria-hidden="true" />
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

export function PairingQR({ link }: { link: string }) {
  const matrix = pairingQr(link);
  return (
    <svg
      role="img"
      aria-label="QR Code para conectar outro aparelho"
      width="320"
      height="320"
      viewBox={`0 0 ${matrix.length} ${matrix.length}`}
      className="sync-qr"
      shapeRendering="crispEdges"
    >
      <path
        d={matrix
          .flatMap((row, y) =>
            row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : '')),
          )
          .join('')}
        fill="#000"
      />
    </svg>
  );
}
