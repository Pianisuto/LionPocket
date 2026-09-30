import type { MoneyKind, TransactionStatus, RecurringFrequency, RecurringIntervalUnit, GoalPriority, GoalStatus } from '@lionpocket/core';

// Wire strings are validated at runtime; local SQLite IDs are never coerced into these IDs.
export type GlobalId = string;
export type Decimal64 = string;
export type Base64Url = string;
export const cryptoSuite = 'lp-sodium-v1' as const;
// Contracts only. Neither application imports this package or starts a transport.
export const stage0Capabilities = { syncEnabled: false, protocolVersions: [1], domainSchemas: [1], entityScopes: [] } as const;

export type Source =
  | { type: 'manual' }
  | { type: 'recurring'; seriesId: GlobalId; slotKey: string }
  | { type: 'installment'; purchaseId: GlobalId; slotId: GlobalId }
  | { type: 'imported'; importKey: string; importAlgorithmVersion: 1 };
export interface TransactionSnapshot {
  kind: MoneyKind;
  description: string;
  categoryId: GlobalId | null;
  plannedAmountCents: number;
  actualAmountCents: number | null;
  purchaseDate: string | null;
  dueDate: string;
  settledDate: string | null;
  status: TransactionStatus;
  paymentMethodId: GlobalId | null;
  cardId: GlobalId | null;
  notes: string;
  source: Source;
  installmentNumber: number | null;
  installmentTotal: number | null;
  occurrenceDate: string | null;
}
export interface CategorySnapshot { name: string; kind: MoneyKind; color: string }
export interface PaymentMethodSnapshot { name: string }
export interface CardSnapshot { name: string; dueDay: number; closingDay: number | null }
export interface SlotAlias { slotKey: string; objectId: GlobalId; originalDate: string | null }
export interface RecurringSnapshot {
  kind: MoneyKind; active: boolean; description: string;
  startMonth: string; startDate: string | null; frequency: RecurringFrequency;
  intervalCount: number; intervalUnit: RecurringIntervalUnit; anchorToActual: boolean;
  manualMonths: string[]; scheduleEpoch: GlobalId;
  categoryId: GlobalId | null; paymentMethodId: GlobalId | null; cardId: GlobalId | null;
  plannedAmountCents: number; dueDay: number; chargeDay: number | null; notes: string;
  identityStatus: 'resolved' | 'identity_unresolved'; aliases: SlotAlias[];
}
export interface InstallmentSnapshot {
  description: string; categoryId: GlobalId | null; paymentMethodId: GlobalId | null;
  cardId: GlobalId | null; installmentAmountCents: number; totalInstallments: number;
  startingInstallment: number; purchaseDate: string | null; firstDueDate: string;
  status: 'active' | 'completed' | 'cancelled'; notes: string;
  identityStatus: 'resolved' | 'identity_unresolved';
  slots: { slotId: GlobalId; originalIndex: number; objectId: GlobalId }[];
}
export interface GoalSnapshot {
  name: string; itemModel: string; link: string; categoryId: GlobalId | null;
  targetAmountCents: number; savedAmountCents: number; priority: GoalPriority;
  dueDate: string | null; status: GoalStatus; notes: string;
}
export interface Snapshots {
  transaction: TransactionSnapshot;
  category: CategorySnapshot;
  paymentMethod: PaymentMethodSnapshot;
  card: CardSnapshot;
  recurring: RecurringSnapshot;
  installmentPurchase: InstallmentSnapshot;
  goal: GoalSnapshot;
  recurringPriorityList: { entries: { seriesId: GlobalId; pinnedFromMonth: string }[] };
  monthlyPriorityList: { month: string; transactionIds: GlobalId[] };
}
export type EntityType = keyof Snapshots;
export interface RevisionMetadata {
  domainSchema: 1;
  authoredAt: string;
  // Legacy audit values remain raw in provenance, not fabricated UTC authorship.
  provenance: { localScopeId: GlobalId; origin: 'local' | 'migration' | 'import' | 'restore'; legacyCreatedAt: string | null; legacyUpdatedAt: string | null; legacyDeletedAt: string | null };
  dependencies: { objectId: GlobalId; revisionId: GlobalId }[];
  restoredFrom: GlobalId | null;
}
export type RevisionPlaintext = {
  [K in EntityType]: RevisionMetadata & { entityType: K } & (
    | { action: 'put'; snapshot: Snapshots[K] }
    | { action: 'delete'; snapshot: null; reason: 'user' | 'legacy_unknown'; deletedAt: string | null; slotKey: string | null; importKey: string | null }
  )
}[EntityType];
export interface CommitHeader {
  protocolVersion: 1;
  serverId: GlobalId;
  serverEpoch: GlobalId;
  vaultId: GlobalId;
  deviceId: GlobalId;
  deviceSeq: Decimal64;
  commitId: GlobalId;
  keyVersion: number;
  deviceRegistryVersion: Decimal64;
  cryptoSuite: typeof cryptoSuite;
}
export interface OperationEnvelope {
  opId: GlobalId;
  objectId: GlobalId;
  parents: GlobalId[];
  expectedHeads?: GlobalId[];
  nonce: Base64Url;
  ciphertext: Base64Url;
}
export interface UnsignedCommit extends CommitHeader { operations: OperationEnvelope[] }
export interface CommitEnvelope extends UnsignedCommit { signature: Base64Url }
export interface CursorScope { serverId: GlobalId; serverEpoch: GlobalId; vaultId: GlobalId }
export interface CommitReceipt extends CursorScope {
  commitId: GlobalId; deviceId: GlobalId; deviceSeq: Decimal64;
  result: 'accepted' | 'alreadyAccepted'; logPosition: Decimal64;
  envelopeSha256: Base64Url; heads: { objectId: GlobalId; revisionIds: GlobalId[] }[];
}
export interface ChangesPage extends CursorScope {
  upperBound: Decimal64; nextCursor: Decimal64; hasMore: boolean;
  commits: { logPosition: Decimal64; envelope: CommitEnvelope }[];
}
export type SyncErrorCode = 'unauthenticated' | 'forbidden' | 'device_revoked' | 'epoch_changed'
  | 'idempotency_mismatch' | 'heads_changed' | 'missing_parents' | 'unsupported_version'
  | 'payload_too_large' | 'rate_limited' | 'invalid_envelope' | 'temporary_failure';
// Provisioning contracts only; no login, recovery, signing or key storage implementation.
export interface DeviceGrant {
  formatVersion: 1; serverId: GlobalId; serverEpoch: GlobalId; vaultId: GlobalId;
  registryVersion: Decimal64; previousRegistrySha256: Base64Url | null;
  deviceId: GlobalId; signingPublicKey: Base64Url; boxPublicKey: Base64Url;
  status: 'approved' | 'revoked'; signature: Base64Url;
}
export interface VaultKeyDelivery {
  formatVersion: 1; serverId: GlobalId; serverEpoch: GlobalId; vaultId: GlobalId;
  recipientDeviceId: GlobalId; registryVersion: Decimal64; keyVersion: number;
  sealedBox: Base64Url; authorDeviceId: GlobalId; signature: Base64Url;
}
/** LP1. + unpadded base64url of 32 random bytes; never a login password. */
export interface RecoveryEnvelope {
  formatVersion: 1; cryptoSuite: 'lp-sodium-v1';
  serverId: GlobalId; serverEpoch: GlobalId; vaultId: GlobalId;
  recoveryVersion: Decimal64; kdf: 'sodium-kdf-blake2b-LPRECOV1-1';
  nonce: Base64Url; ciphertext: Base64Url;
}
export interface RecoveryBundle {
  formatVersion: 1; serverId: GlobalId; serverEpoch: GlobalId; vaultId: GlobalId;
  recoveryVersion: Decimal64; registryVersion: Decimal64;
  authoritySignSeed: Base64Url; authorityPublicKey: Base64Url;
  activeKeyVersion: number; dataKeys: Array<{ keyVersion: number; vaultKey: Base64Url }>;
}
