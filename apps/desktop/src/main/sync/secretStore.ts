import { safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  secretContext,
  type SecretScope,
  type SecretStore,
} from '@lionpocket/sync-local';
/** Only encrypted binary wrappers live here, outside the SQLite/JSON backup paths. */
export class DesktopSecretStore implements SecretStore {
  constructor(private readonly directory: string) {}
  private requireVault(): void {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' &&
        !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
          safeStorage.getSelectedStorageBackend(),
        ))
    )
      throw new Error('System secret vault unavailable.');
  }
  private path(context: string): string {
    return join(
      this.directory,
      createHash('sha256').update(context).digest('hex') + '.bin',
    );
  }
  async store(scope: SecretScope, secret: Uint8Array): Promise<void> {
    this.requireVault();
    const context = secretContext(scope);
    if (secret.length !== 32)
      throw new Error('Expected a 32-byte seed or data key.');
    const encrypted = safeStorage.encryptString(
      JSON.stringify({
        context,
        secret: Buffer.from(secret).toString('base64url'),
      }),
    );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(context),
      temporary = target + '.' + randomUUID();
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(encrypted);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await unlink(temporary).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  }
  async load(scope: SecretScope): Promise<Uint8Array | null> {
    this.requireVault();
    const context = secretContext(scope);
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path(context));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const value = JSON.parse(safeStorage.decryptString(bytes));
    if (value.context !== context || typeof value.secret !== 'string')
      throw new Error('Secret wrapping scope mismatch.');
    const secret = Buffer.from(value.secret, 'base64url');
    if (secret.length !== 32 || secret.toString('base64url') !== value.secret)
      throw new Error('Invalid wrapped secret.');
    return new Uint8Array(secret);
  }
  async remove(scope: SecretScope): Promise<void> {
    const context = secretContext(scope);
    await unlink(this.path(context)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}
