import { deviceStatusLabel } from '@lionpocket/sync-local';
import { useState } from 'react';
import { Plus, Smartphone } from 'lucide-react';
import { PairingQR, SyncSection } from './primitives';
import type { SyncSession } from './useSyncSession';

/** Linked devices and, for the vault owner, adding and approving new ones. */
export function DevicesSection({ status, busy, run }: SyncSession) {
  const [adding, setAdding] = useState(false);
  const [pairingLink, setPairingLink] = useState('');
  const closeInvite = () => {
    setAdding(false);
    setPairingLink('');
  };
  return (
    <SyncSection
      icon={Smartphone}
      title="Aparelhos"
      description="Aparelhos com acesso a este cofre."
    >
      <ul className="sync-device-list">
        {status.devices.map((d) => (
          <li key={d.registryVersion}>
            <Smartphone size={17} aria-hidden="true" />
            <span className="sync-identifier">{d.deviceId}</span>
            <span className="sync-device-status">
              {deviceStatusLabel(d.status)}
            </span>
          </li>
        ))}
      </ul>
      {!status.devices.length && <p>Nenhum aparelho listado neste momento.</p>}
      {status.owner && (
        <>
          <div className="sync-actions">
            <button
              className="button button--primary"
              disabled={busy}
              onClick={() =>
                void run('invite-create', [], (result) => {
                  setPairingLink((result as { link: string }).link);
                  setAdding(true);
                })
              }
            >
              <Plus size={16} aria-hidden="true" />
              Adicionar aparelho
            </button>
          </div>
          {adding && status.pairingRequests.length === 0 && (
            <div className="sync-invite">
              {pairingLink && <PairingQR link={pairingLink} />}
              <div className="sync-invite__copy">
                <p>
                  Escaneie com outro celular ou abra o link no computador.
                  Convite válido por 15 minutos e para um aparelho.
                </p>
                <div className="sync-actions">
                  <button
                    className="button"
                    onClick={() => void navigator.clipboard.writeText(pairingLink)}
                  >
                    Copiar link
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      if (navigator.share) void navigator.share({ text: pairingLink });
                      else void navigator.clipboard.writeText(pairingLink);
                    }}
                  >
                    Compartilhar convite
                  </button>
                  <button
                    className="button"
                    onClick={() => void navigator.clipboard.writeText(pairingLink)}
                  >
                    Copiar convite
                  </button>
                  <button
                    className="button button--ghost"
                    disabled={busy}
                    onClick={() => void run('invite-revoke', [], closeInvite)}
                  >
                    Cancelar convite
                  </button>
                </div>
              </div>
            </div>
          )}
          {status.pairingRequests.map((r) => (
            <div className="sync-request" key={r.deviceId}>
              <div>
                <strong>Novo aparelho · {r.deviceName}</strong>
                <p>Solicitando acesso agora</p>
              </div>
              <div className="sync-fingerprint">
                <span>Código de segurança</span>
                <code>{r.securityCode}</code>
                <small>Confira o mesmo código no novo aparelho.</small>
              </div>
              <div className="sync-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void run('pairing-deny', [r.deviceId], closeInvite)}
                >
                  Recusar
                </button>
                <button
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void run('approve', [r.deviceId], closeInvite)}
                >
                  Aprovar aparelho
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </SyncSection>
  );
}
