import { sha256 } from '@noble/hashes/sha256';
import { encodeUtf8 } from '@lionpocket/sync-protocol';
/** Portable public digest for validating immutable backup bytes without opening any secret cofre. */
export function envelopeDigest(text: string): string {
  const bytes = sha256(encodeUtf8(text)),
    alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63];
    if (i + 1 < bytes.length) result += alphabet[(n >>> 6) & 63];
    if (i + 2 < bytes.length) result += alphabet[n & 63];
  }
  return result;
}
