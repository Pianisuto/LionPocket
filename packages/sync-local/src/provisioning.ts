import type { KeyCheckpoint } from './security';
import { sha256 } from '@noble/hashes/sha256';
import {
  activeDevice,
  assertKeyBundle,
  assertTrustPin,
  canonicalStringify,
  decodeCanonical,
  encodeUtf8,
  deviceGrantSigningInput,
  httpProofSigningInput,
  keyDeliverySigningInput,
  nextRegistryVersion,
  pairingFingerprintInput,
  pairingSigningInput,
  sameScope,
  validateDelivery,
  validateGrantChain,
  verifyPairing,
  type ControlCrypto,
  type DeviceGrant,
  type HttpProof,
  type KeyBundle,
  type PairingRequest,
  type RegistryCheckpoint,
  type TrustPin,
  type VaultKeyDelivery,
} from '@lionpocket/sync-protocol';
import { uuidFromRandom, type SecretScope, type SecretStore } from './secrets';

/** Both pinned sodium bindings implement this byte API; no private key leaves the runtime. */
export interface ProvisioningSodium {
  randombytes_buf(size: number): Uint8Array;
  to_base64(bytes: Uint8Array, variant: number): string;
  from_base64(text: string, variant: number): Uint8Array;
  base64_variants: { URLSAFE_NO_PADDING: number };
  crypto_sign_seed_keypair(seed: Uint8Array): {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  };
  crypto_box_seed_keypair(seed: Uint8Array): {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  };
  crypto_sign_detached(bytes: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_sign_verify_detached(
    signature: Uint8Array,
    bytes: Uint8Array,
    key: Uint8Array,
  ): boolean;
  crypto_box_seal(bytes: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_box_seal_open(
    bytes: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
  ): Uint8Array | null;
}
export class ProvisioningCrypto implements ControlCrypto {
  constructor(readonly sodium: ProvisioningSodium) {}
  encode(bytes: Uint8Array) {
    return this.sodium.to_base64(
      bytes,
      this.sodium.base64_variants.URLSAFE_NO_PADDING,
    );
  }
  decode(text: string) {
    return this.sodium.from_base64(
      text,
      this.sodium.base64_variants.URLSAFE_NO_PADDING,
    );
  }
  hash(text: string) {
    return this.encode(sha256(encodeUtf8(text)));
  }
  verify(signature: string, text: string, publicKey: string) {
    try {
      return this.sodium.crypto_sign_verify_detached(
        this.decode(signature),
        encodeUtf8(text),
        this.decode(publicKey),
      );
    } catch {
      return false;
    }
  }
  sign(text: string, seed: Uint8Array) {
    const pair = this.sodium.crypto_sign_seed_keypair(seed);
    try {
      return this.encode(
        this.sodium.crypto_sign_detached(encodeUtf8(text), pair.privateKey),
      );
    } finally {
      this.erase(pair.privateKey);
    }
  }
  erase(bytes: Uint8Array) {
    bytes.fill(0);
  }
  uuid() {
    return uuidFromRandom(this.sodium.randombytes_buf(16));
  }
  nonce() {
    return this.encode(this.sodium.randombytes_buf(32));
  }
}
export interface ProvisionedProfile {
  formatVersion: 1;
  installationId: string;
  pin: TrustPin;
  deviceId: string;
  signingPublicKey: string;
  boxPublicKey: string;
  grants: DeviceGrant[];
  checkpoint?: RegistryCheckpoint;
  activeKeyVersion?: number;
  keyCheckpoints?: KeyCheckpoint[];
}
export interface RegistryResponse {
  pin: TrustPin;
  grants: DeviceGrant[];
  delivery: VaultKeyDelivery | null;
  keyCheckpoints?: KeyCheckpoint[];
}
/** Profile is public metadata only. Caller durably saves it after each successful operation. */
export class DeviceProvisioning {
  constructor(
    readonly profile: ProvisionedProfile,
    readonly secrets: SecretStore,
    readonly crypto: ProvisioningCrypto,
  ) {
    assertTrustPin(profile.pin);
  }
  scope(purpose: SecretScope['purpose'], keyVersion = this.profile.activeKeyVersion ?? 1): SecretScope {
    return {
      installationId: this.profile.installationId,
      deviceId: this.profile.deviceId,
      serverId: this.profile.pin.serverId,
      serverEpoch: this.profile.pin.serverEpoch,
      vaultId: this.profile.pin.vaultId,
      purpose,
      keyVersion: purpose === 'dataKey' ? keyVersion : 1,
    };
  }
  private async secret(purpose: SecretScope['purpose']) {
    const seed = await this.secrets.load(this.scope(purpose));
    if (!seed) throw new Error('secret_unavailable');
    return seed;
  }
  static async prepare(
    pin: TrustPin,
    secrets: SecretStore,
    crypto: ProvisioningCrypto,
    founder = false,
  ) {
    assertTrustPin(pin);
    const profile: ProvisionedProfile = {
      formatVersion: 1,
      installationId: crypto.uuid(),
      pin: { ...pin },
      deviceId: founder ? pin.founderDeviceId : crypto.uuid(),
      signingPublicKey: '',
      boxPublicKey: '',
      grants: [],
    };
    const client = new DeviceProvisioning(profile, secrets, crypto);
    const purposes: SecretScope['purpose'][] = founder
      ? ['signingSeed', 'boxSeed', 'authoritySeed', 'dataKey']
      : ['signingSeed', 'boxSeed'];
    // Scope IDs are new CSPRNG IDs. Probe the cofre before publishing anything remotely.
    for (const purpose of purposes) {
      if (await secrets.load(client.scope(purpose)))
        throw new Error('secret_already_exists');
      const seed = crypto.sodium.randombytes_buf(32);
      try {
        await secrets.store(client.scope(purpose), seed);
        if (purpose === 'signingSeed' || purpose === 'authoritySeed') {
          const pair = crypto.sodium.crypto_sign_seed_keypair(seed);
          if (purpose === 'signingSeed')
            profile.signingPublicKey = crypto.encode(pair.publicKey);
          else profile.pin.authorityPublicKey = crypto.encode(pair.publicKey);
          crypto.erase(pair.privateKey);
        }
        if (purpose === 'boxSeed') {
          const pair = crypto.sodium.crypto_box_seed_keypair(seed);
          profile.boxPublicKey = crypto.encode(pair.publicKey);
          crypto.erase(pair.privateKey);
        }
      } finally {
        crypto.erase(seed);
      }
    }
    return client;
  }
  private async sign(
    text: string,
    purpose: 'signingSeed' | 'authoritySeed' = 'signingSeed',
  ) {
    const seed = await this.secret(purpose);
    try {
      const pair = this.crypto.sodium.crypto_sign_seed_keypair(seed);
      const expected =
        purpose === 'authoritySeed'
          ? this.profile.pin.authorityPublicKey
          : this.profile.signingPublicKey;
      const actual = this.crypto.encode(pair.publicKey);
      this.crypto.erase(pair.privateKey);
      if (actual !== expected) throw new Error('key_mismatch');
      return this.crypto.sign(text, seed);
    } finally {
      this.crypto.erase(seed);
    }
  }
  async request(): Promise<PairingRequest> {
    const { serverId, serverEpoch, vaultId } = this.profile.pin;
    const fields = {
      formatVersion: 1 as const,
      serverId,
      serverEpoch,
      vaultId,
      deviceId: this.profile.deviceId,
      signingPublicKey: this.profile.signingPublicKey,
      boxPublicKey: this.profile.boxPublicKey,
      nonce: this.crypto.nonce(),
    };
    const unsigned = {
      ...fields,
      fingerprint: this.crypto.hash(pairingFingerprintInput(fields)),
    };
    return {
      ...unsigned,
      signature: await this.sign(pairingSigningInput(unsigned)),
    };
  }
  async grant(
    request: PairingRequest,
    confirmedFingerprint: string,
    status: 'approved' | 'revoked' = 'approved',
  ): Promise<DeviceGrant> {
    verifyPairing(request, this.crypto);
    sameScope(request, this.profile.pin);
    if (confirmedFingerprint !== request.fingerprint)
      throw new Error('fingerprint_mismatch');
    if(this.profile.deviceId!==this.profile.pin.founderDeviceId){const authority=await this.secrets.load(this.scope('authoritySeed'));if(!authority)throw new Error('founder_required');this.crypto.erase(authority);}
    // Possession of the independently stored authority seed authorizes administration.
    // Paired devices receive only data keys, never this seed.
    if(this.profile.grants.length)validateGrantChain(this.profile.grants,this.profile.pin,this.crypto,this.profile.checkpoint);
    const previous = this.profile.grants[this.profile.grants.length - 1];
    const unsigned = {
      formatVersion: 1 as const,
      serverId: request.serverId,
      serverEpoch: request.serverEpoch,
      vaultId: request.vaultId,
      registryVersion: nextRegistryVersion(previous?.registryVersion ?? '0'),
      previousRegistrySha256: previous
        ? this.crypto.hash(canonicalStringify(previous))
        : null,
      deviceId: request.deviceId,
      signingPublicKey: request.signingPublicKey,
      boxPublicKey: request.boxPublicKey,
      status,
    };
    const grant = {
      ...unsigned,
      signature: await this.sign(
        deviceGrantSigningInput(unsigned),
        'authoritySeed',
      ),
    };
    validateGrantChain(
      [...this.profile.grants, grant],
      this.profile.pin,
      this.crypto,
      this.profile.checkpoint,
    );
    return grant;
  }
  acceptRegistry(response: RegistryResponse): void {
    if (
      canonicalStringify(response.pin) !== canonicalStringify(this.profile.pin)
    )
      throw new Error('trust_pin_mismatch');
    const result = validateGrantChain(
      response.grants,
      this.profile.pin,
      this.crypto,
      this.profile.checkpoint,
    );
    const own = activeDevice(result.devices, this.profile.deviceId);
    if (
      own.signingPublicKey !== this.profile.signingPublicKey ||
      own.boxPublicKey !== this.profile.boxPublicKey
    )
      throw new Error('key_mismatch');
    this.profile.grants = response.grants;
    this.profile.checkpoint = result.checkpoint;
  }
  async delivery(recipientDeviceId: string): Promise<VaultKeyDelivery> {
    const registry = validateGrantChain(
      this.profile.grants,
      this.profile.pin,
      this.crypto,
      this.profile.checkpoint,
    );
    activeDevice(registry.devices, this.profile.deviceId);
    const recipient = activeDevice(registry.devices, recipientDeviceId);
    const key = await this.secrets.load(this.scope('dataKey',1));
    if (!key) throw new Error('secret_unavailable');
    try {
      const { serverId, serverEpoch, vaultId } = this.profile.pin;
      const bundle: KeyBundle = {
        formatVersion: 1,
        serverId,
        serverEpoch,
        vaultId,
        recipientDeviceId,
        registryVersion: registry.checkpoint.version,
        keyVersion: 1,
        vaultKey: this.crypto.encode(key),
      };
      const sealed = this.crypto.sodium.crypto_box_seal(
        encodeUtf8(canonicalStringify(bundle)),
        this.crypto.decode(recipient.boxPublicKey),
      );
      const unsigned = {
        formatVersion: 1 as const,
        serverId,
        serverEpoch,
        vaultId,
        recipientDeviceId,
        registryVersion: registry.checkpoint.version,
        keyVersion: 1,
        sealedBox: this.crypto.encode(sealed),
        authorDeviceId: this.profile.deviceId,
      };
      return {
        ...unsigned,
        signature: await this.sign(keyDeliverySigningInput(unsigned)),
      };
    } finally {
      this.crypto.erase(key);
    }
  }
  async receive(response: RegistryResponse): Promise<void> {
    // Validate before touching either public state or the secret cofre.
    if (
      canonicalStringify(response.pin) !== canonicalStringify(this.profile.pin)
    )
      throw new Error('trust_pin_mismatch');
    const registry = validateGrantChain(
      response.grants,
      this.profile.pin,
      this.crypto,
      this.profile.checkpoint,
    );
    const own = activeDevice(registry.devices, this.profile.deviceId);
    if (
      own.signingPublicKey !== this.profile.signingPublicKey ||
      own.boxPublicKey !== this.profile.boxPublicKey
    )
      throw new Error('key_mismatch');
    if (
      !response.delivery ||
      response.delivery.recipientDeviceId !== this.profile.deviceId
    )
      throw new Error('delivery_missing');
    const delivery = response.delivery;
    validateDelivery(delivery, response.grants, this.profile.pin, this.crypto);
    const seed = await this.secret('boxSeed');
    const pair = this.crypto.sodium.crypto_box_seed_keypair(seed);
    this.crypto.erase(seed);
    let bytes: Uint8Array | null = null;
    try {
      if (this.crypto.encode(pair.publicKey) !== own.boxPublicKey)
        throw new Error('key_mismatch');
      bytes = this.crypto.sodium.crypto_box_seal_open(
        this.crypto.decode(delivery.sealedBox),
        pair.publicKey,
        pair.privateKey,
      );
      if (!bytes) throw new Error('invalid_sealed_box');
      const bundle = decodeCanonical(bytes);
      assertKeyBundle(bundle);
      sameScope(bundle, delivery);
      if (
        bundle.recipientDeviceId !== delivery.recipientDeviceId ||
        bundle.registryVersion !== delivery.registryVersion ||
        bundle.keyVersion !== delivery.keyVersion
      )
        throw new Error('key_bundle_mismatch');
      const key = this.crypto.decode(bundle.vaultKey);
      const existing = await this.secrets.load(this.scope('dataKey',1));
      try {
        if (existing && this.crypto.encode(existing) !== bundle.vaultKey)
          throw new Error('key_mismatch');
        await this.secrets.store(this.scope('dataKey',1), key);
      } finally {
        this.crypto.erase(key);
        if (existing) this.crypto.erase(existing);
      }
      this.profile.grants = response.grants;
      this.profile.checkpoint = registry.checkpoint;
    } finally {
      this.crypto.erase(pair.privateKey);
      if (bytes) this.crypto.erase(bytes);
    }
  }
  async proof(
    method: string,
    target: string,
    origin: string,
    body: string,
    token: string,
  ): Promise<HttpProof> {
    const { serverId, serverEpoch, vaultId } = this.profile.pin;
    const unsigned = {
      formatVersion: 1 as const,
      serverId,
      serverEpoch,
      vaultId,
      deviceId: this.profile.deviceId,
      method,
      target,
      origin,
      bodySha256: this.crypto.hash(body),
      accessTokenSha256: this.crypto.hash(token),
      issuedAt: Date.now(),
      nonce: this.crypto.nonce(),
    };
    return {
      ...unsigned,
      signature: await this.sign(httpProofSigningInput(unsigned)),
    };
  }
}
