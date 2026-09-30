// Isolated native harness only. Session comes from a transient loopback test broker, never a file.
import { NativeModules } from 'react-native';
import { open } from 'react-native-nitro-sqlite';
import { migrate } from './src/db/migrations';
import { MobileRepository } from './src/db/repository';
import { AndroidDevelopmentSync } from './src/sync/development';
import {
  captureBackup,
  loadBackupData,
  restoreBackup,
} from './src/db/backupRepository';
import { ManualSync } from '@lionpocket/sync-local';
const broker = 'http://127.0.0.1:18773';
// Imports run before the harness renders App; its own repository must also use
// the synthetic bank, including while the asynchronous broker login is pending.
globalThis.lionPocketSyntheticSync = true;
async function run() {
  const bootstrap = await (await fetch(broker + '/bootstrap')).json();
  const jwks = await (
    await fetch(bootstrap.session.issuer + '/protocol/openid-connect/certs')
  ).text();
  const subject = await NativeModules.LionPocketIdentity.verify(
    bootstrap.session.accessToken,
    jwks,
    bootstrap.session.issuer,
    'lionpocket-sync-api',
    'lionpocket-android-dev',
    null,
    true,
  );
  if (subject !== bootstrap.session.subject)
    throw new Error('Broker identity mismatch');
  let db = open({
    name: 'transport-native-synthetic.sqlite',
    connection: 'independent',
  });
  await db.executeAsync('PRAGMA foreign_keys=ON');
  await migrate(db);
  const controller = new AndroidDevelopmentSync(db, bootstrap.endpoint);
  const device = () => controller.load();
  let previous = 0;
  const status = async () => {
    const a = await controller.engine();
    return {
      ...(await controller.status()),
      transactions: (await db.executeAsync('SELECT * FROM transactions')).rows
        ._array,
      revisions: (
        await db.executeAsync(
          'SELECT revision_id,object_id,action,parents_json FROM sync_revisions',
        )
      ).rows._array,
      outbox: (
        await db.executeAsync(
          'SELECT commit_id,state,envelope_json,envelope_sha256,last_error FROM sync_outbox',
        )
      ).rows._array,
      inbox: (
        await db.executeAsync(
          'SELECT commit_id,log_position,state,last_error FROM sync_inbox',
        )
      ).rows._array,
      deviceId: a.engine.device.profile.deviceId,
    };
  };
  await fetch(broker + '/ready', {
    method: 'POST',
    body: JSON.stringify({ result: 'PASS', runtime: 'Android Hermes/JSI' }),
  });
  while (true) {
    const command = await (
      await fetch(broker + '/command?after=' + previous)
    ).json();
    previous = command.id;
    let result;
    try {
      if (command.action === 'pair')
        result = await controller.pair(bootstrap.pin, bootstrap.session);
      else if (command.action === 'receive')
        result = await controller.receive(bootstrap.session);
      else if (command.action === 'save') {
        const d = await device();
        result = await new MobileRepository(db, () => d.crypto.uuid()).save(
          command.input,
        );
      } else if (command.action === 'delete') {
        const d = await device();
        await new MobileRepository(db, () => d.crypto.uuid()).remove(
          command.localId,
        );
        result = { deleted: true };
      } else if (command.action === 'sync') {
        await controller.sync(bootstrap.session);
        result = await status();
      } else if (command.action === 'lost_response') {
        const actions = await controller.engine(),
          e = actions.engine;
        let dropped = false;
        const flaky = {
          request: async (target, body, proof, token) => {
            const value = await e.http.request(target, body, proof, token);
            if (target.endsWith('/commits') && !dropped) {
              dropped = true;
              throw new Error('lost_response');
            }
            return value;
          },
        };
        try {
          await new ManualSync(
            e.db,
            e.device,
            e.sodium,
            'android',
            e.endpoint,
            flaky,
          ).sync(bootstrap.session.accessToken);
        } catch (error) {
          if (error.message !== 'lost_response') throw error;
        }
        result = await status();
      } else if (command.action === 'resolve') {
        await controller.resolve(
          command.objectId,
          command.heads,
          command.revisionId,
          command.recover || false,
        );
        result = await status();
      } else if (command.action === 'status') result = await status();
      else if (command.action === 'backup') {
        const before = await captureBackup(db),
          name = 'transport-native-staging.sqlite',
          stage = open({ name, connection: 'independent' });
        try {
          await stage.executeAsync('PRAGMA foreign_keys=ON');
          const hydrated = await loadBackupData(
            stage,
            before.data,
            before.schemaVersion,
          );
          if (JSON.stringify(hydrated.data) !== JSON.stringify(before.data))
            throw new Error('Staging mismatch');
          await restoreBackup(stage, hydrated, async () => {});
          const after = await captureBackup(stage);
          if (
            after.data.sync_local_state[0].mode !== 'disabled' ||
            JSON.stringify(after.data.sync_inbox) !==
              JSON.stringify(before.data.sync_inbox)
          )
            throw new Error('Restore mismatch');
          result = {
            staging: 'PASS',
            restore: 'PASS',
            schemaVersion: before.schemaVersion,
          };
        } finally {
          stage.close();
          stage.delete();
        }
      } else throw new Error('Unknown native test action');
      await fetch(broker + '/result', {
        method: 'POST',
        body: JSON.stringify({ id: command.id, result }),
      });
    } catch (error) {
      await fetch(broker + '/result', {
        method: 'POST',
        body: JSON.stringify({
          id: command.id,
          error: String(error),
          stack: error.stack,
        }),
      });
    }
  }
}
run().catch((error) =>
  NativeModules.CryptoSpikeReport.report(
    JSON.stringify({
      result: 'FAIL',
      transportError: String(error),
      stack: error.stack,
    }),
  ),
);
