import { canonicalStringify } from './canonical';
import { decodeCanonical, encodeUtf8 } from './decoder';
import { assertUuid } from './validation';
import {
  assertTrustPin,
  exactObject,
  type ControlCrypto,
  type TrustPin,
  type PairingRequest,
} from './provisioning';

/** LPV1 remains public recovery metadata. Only this purpose-scoped, signed version is a capability. */
export interface PairingInvite {
  version: 2;
  purpose: 'device-pairing';
  id: string;
  endpoint: string;
  pin: TrustPin;
  expiresAt: number;
  capabilityHash: string;
  capabilityPublicKey: string;
  signature: string;
}
export interface PairingInvitation {
  invite: PairingInvite;
  capability: string;
}
export interface NamedPairing extends PairingRequest {
  deviceName?: string;
  securityCode?: string;
  pairingAuth?: {
    invite: PairingInvite;
    deviceName: string;
    capabilitySignature: string;
  };
}
export function inviteSigningInput(
  invite: Omit<PairingInvite, 'signature'>,
): string {
  return canonicalStringify({
    context: 'LionPocket/device-pairing-invite/v2',
    ...invite,
  });
}
export function verifyInvite(
  value: unknown,
  crypto: ControlCrypto,
): asserts value is PairingInvite {
  const v = exactObject(value, [
    'version',
    'purpose',
    'id',
    'endpoint',
    'pin',
    'expiresAt',
    'capabilityHash',
    'capabilityPublicKey',
    'signature',
  ]);
  if (v.version !== 2 || v.purpose !== 'device-pairing')
    throw new Error('invite_invalid');
  assertUuid(v.id, '4');
  assertTrustPin(v.pin);
  if (
    typeof v.endpoint !== 'string' ||
    !Number.isSafeInteger(v.expiresAt) ||
    Number(v.expiresAt) <= 0 ||
    typeof v.capabilityPublicKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.capabilityPublicKey) ||
    typeof v.capabilityHash !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.capabilityHash)
  )
    throw new Error('invite_invalid');
  const { signature, ...unsigned } = value as PairingInvite;
  if (
    !crypto.verify(
      signature,
      inviteSigningInput(unsigned),
      unsigned.pin.authorityPublicKey,
    )
  )
    throw new Error('invite_invalid');
}
export function parsePairingInvitation(
  input: string,
  crypto: ControlCrypto & {
    decode(text: string): Uint8Array;
    encode(bytes: Uint8Array): string;
  },
): PairingInvitation {
  const text = input.trim().replace(/^lionpocket:\/\/pair\//, '');
  if (text.startsWith('LPV1.')) throw new Error('invite_legacy');
  if (!text.startsWith('LPV2.') || text.length > 4096)
    throw new Error('invite_invalid');
  try {
    const raw = text.slice(5),
      bytes = crypto.decode(raw);
    if (crypto.encode(bytes) !== raw) throw new Error('invite_invalid');
    const obj = exactObject(decodeCanonical(bytes, 4096), [
      'invite',
      'capability',
    ]);
    verifyInvite(obj.invite, crypto);
    if (
      typeof obj.capability !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(obj.capability) ||
      crypto.decode(obj.capability).length !== 32 ||
      crypto.hash(obj.capability) !== obj.invite.capabilityHash
    )
      throw new Error('invite_invalid');
    return obj as unknown as PairingInvitation;
  } catch {
    throw new Error('invite_invalid');
  }
}
export function pairingCapabilityInput(
  invite: PairingInvite,
  request: PairingRequest,
  deviceName: string,
): string {
  return canonicalStringify({
    context: 'LionPocket/pairing-request-capability/v2',
    inviteEnvelope: inviteSigningInput(
      (({ signature: _signature, ...unsigned }) => unsigned)(invite),
    ),
    request,
    deviceName,
  });
}
export function barePairing(request: NamedPairing): PairingRequest {
  return {
    formatVersion: request.formatVersion,
    serverId: request.serverId,
    serverEpoch: request.serverEpoch,
    vaultId: request.vaultId,
    deviceId: request.deviceId,
    signingPublicKey: request.signingPublicKey,
    boxPublicKey: request.boxPublicKey,
    nonce: request.nonce,
    fingerprint: request.fingerprint,
    signature: request.signature,
  };
}
export function pairingLink(
  value: PairingInvitation,
  crypto: { encode(bytes: Uint8Array): string },
): string {
  return (
    'lionpocket://pair/LPV2.' +
    crypto.encode(encodeUtf8(canonicalStringify(value)))
  );
}
/** SAS binds the signed request (both device keys and nonce) to this authority/invitation. Visual comparison only. */
export function pairingSecurityCode(
  inviteId: string,
  request: PairingRequest,
  crypto: ControlCrypto,
): string {
  const digest = crypto.hash(
    canonicalStringify({
      context: 'LionPocket/pairing-sas/v2',
      inviteId,
      fingerprint: request.fingerprint,
    }),
  );
  // SHA-256 base64url prefix -> six decimal digits. No fingerprints or secrets in UI.
  let value = 0;
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (const c of digest.slice(0, 5)) value = value * 64 + alphabet.indexOf(c);
  const code = String(value % 1000000).padStart(6, '0');
  return code.slice(0, 3) + ' ' + code.slice(3);
}
export function pairingErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    invite_invalid: 'Convite inválido',
    invite_expired: 'Convite expirado',
    invite_revoked: 'Convite cancelado',
    invite_consumed:
      'Este convite já foi usado. Gere outro no aparelho conectado.',
    invite_legacy:
      'Convite antigo. Abra Adicionar aparelho no aparelho conectado para gerar um novo.',
    pairing_denied: 'Pedido recusado',
    client_upgrade_required: 'Atualização do aplicativo necessária',
    unsupported_version: 'Atualização do aplicativo necessária',
    unsupported_capability: 'Atualização do aplicativo necessária',
    epoch_changed: 'Convite cancelado. Gere outro no aparelho conectado.',
    pairing_unavailable:
      'Este aparelho não pode autorizar outros. Use o aparelho que criou o cofre.',
  };
  if (Object.values(messages).includes(code)) return code;
  for (const [internal, message] of Object.entries(messages))
    if (code === internal || code.endsWith(': ' + internal)) return message;
  if (code === 'Leitor indisponível. Cole o convite.') return code;
  if (
    code.startsWith('Use uma URL HTTPS') ||
    code === 'Use um endpoint HTTPS sem caminho.'
  )
    return 'Informe um servidor HTTPS válido, como https://sync.exemplo.com.';
  return 'Servidor indisponível';
}
