// Isolated app ID/storage. Actual mobile repository, native crypto and secret adapter.
import React, { useEffect, useState } from 'react';
import { AppRegistry, NativeModules, Text, View, Platform, Button } from 'react-native';
import { open } from 'react-native-nitro-sqlite';
import { androidCrypto, androidSyncUuidGenerator } from './src/sync/crypto';
import { androidDevelopmentOidc } from './src/sync/oidc';
import { AndroidSecretStore } from './src/sync/secretStore';
import { MobileRepository } from './src/db/repository';
import { migrate } from './src/db/migrations';
import { captureBackup, loadBackupData, restoreBackup, verifyDatabase } from './src/db/backupRepository';
import { runStorageChecks } from './storage-checks';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
const { runCryptoChecks } = require('./crypto-checks.cjs');
const { runProvisioningChecks } = require('./provisioning-checks.cjs');
const { runManualChecks } = require('./manual-checks.cjs');
const protocol = require('@lionpocket/sync-protocol');
const {secretContext} = require('@lionpocket/sync-local');
async function runSecrets(sodium, uuid) {
  const store = new AndroidSecretStore();
  const scope = { installationId:uuid(),deviceId:uuid(),serverId:uuid(),serverEpoch:uuid(),vaultId:uuid(),purpose:'dataKey',keyVersion:1 };
  const key = sodium.randombytes_buf(32);
  let checks = 0;
  const check = (condition) => { if (!condition) throw new Error('Android durable secret store'); checks++; };
  try {
    check(await store.load(scope) === null);
    await store.store(scope,key);
    check(sodium.to_hex(await new AndroidSecretStore().load(scope)) === sodium.to_hex(key));
    check(await store.load({...scope,deviceId:uuid()}) === null);
    // Rewriting a secret must still load under the same authenticated scope.
    const nonce = await NativeModules.SecretStoreProbe.probe(secretContext(scope),'','nonce');
    const second = sodium.randombytes_buf(32); await store.store(scope,second);
    check(nonce !== await NativeModules.SecretStoreProbe.probe(secretContext(scope),'','nonce'));
    check(sodium.to_hex(await store.load(scope)) === sodium.to_hex(second));
    const wrong = {...scope,deviceId:uuid()};
    await NativeModules.SecretStoreProbe.probe(secretContext(scope),secretContext(wrong),'copy');
    let refused=false;try{await store.load(wrong);}catch{refused=true;}check(refused);await store.remove(wrong);
    await NativeModules.SecretStoreProbe.probe(secretContext(scope),'','tamper');
    refused=false;try{await store.load(scope);}catch{refused=true;}check(refused);
    await store.store(scope,key);
    await NativeModules.SecretStoreProbe.probe(secretContext(scope),'','deleteKey');
    refused=false;try{await store.load(scope);}catch{refused=true;}check(refused);
    refused=false;try{await store.store(scope,key);}catch{refused=true;}check(refused);
    await store.remove(scope); check(await store.load(scope) === null);
    return { result:'PASS', checks, persistence:'Android Keystore + noBackupFilesDir' };
  } finally { await store.remove(scope); await NativeModules.SecretStoreProbe.probe(secretContext(scope),'','deleteKey'); key.fill(0); }
}
async function runIdentityChecks() {
  const fixture=require('./fixtures/oidc-public.json'), native=NativeModules.LionPocketIdentity;
  const jwks=JSON.stringify(fixture.jwks); let checks=0;
  const check=ok=>{if(!ok)throw new Error('Native RS256 identity check');checks++;};
  check(await native.verify(fixture.idToken,jwks,fixture.issuer,fixture.clientId,fixture.clientId,fixture.nonce,false)==='PUBLIC-SYNTHETIC-SUBJECT');
  check(await native.verify(fixture.accessToken,jwks,fixture.issuer,'lionpocket-sync-api',fixture.clientId,null,true)==='PUBLIC-SYNTHETIC-SUBJECT');
  for (const args of [
    [fixture.expiredToken,jwks,fixture.issuer,'lionpocket-sync-api',fixture.clientId,null,true],
    [fixture.wrongTypeToken,jwks,fixture.issuer,'lionpocket-sync-api',fixture.clientId,null,true],
    [fixture.idToken,jwks,fixture.issuer,fixture.clientId,fixture.clientId,'wrong',false],
    [fixture.accessToken,jwks,'http://wrong','lionpocket-sync-api',fixture.clientId,null,true],
    [fixture.accessToken,jwks,fixture.issuer,'wrong',fixture.clientId,null,true],
    [fixture.accessToken,jwks,fixture.issuer,'lionpocket-sync-api','wrong',null,true],
    [fixture.idToken,jwks,fixture.issuer,'lionpocket-sync-api',fixture.clientId,null,true],
    [fixture.accessToken.slice(0,-6)+'AAAAAA',jwks,fixture.issuer,'lionpocket-sync-api',fixture.clientId,null,true],
  ]) { let rejected=false;try{await native.verify(...args);}catch{rejected=true;}check(rejected); }
  return {result:'PASS',checks,implementation:'Android java.security RS256',tokens:'public test JWTs, not valid Keycloak sessions'};
}
async function runLocal(uuid) {
  const name = 'stage1-android-' + uuid() + '.sqlite';
  const db = open({name,connection:'independent'});
  let stage, restored, closed=false;
  try {
    await db.executeAsync('PRAGMA foreign_keys=ON'); await migrate(db);
    const repo = new MobileRepository(db,uuid);
    const result = await runManualChecks({read:async(sql,params)=>(await db.executeAsync(sql,params)).rows._array,
      save:(input)=>repo.save(input),settle:(id)=>repo.settleMany([id]),remove:(id)=>repo.remove(id),enable:()=>repo.enableSyntheticManualSyncPilot()});
    const backup = await captureBackup(db);
    stage = open({name:'stage1-staging-'+uuid()+'.sqlite',connection:'independent'});
    await stage.executeAsync('PRAGMA foreign_keys=ON');
    const hydrated = await loadBackupData(stage,backup.data,backup.schemaVersion);
    if (JSON.stringify(hydrated.data) !== JSON.stringify(backup.data)) throw new Error('Native staging data changed');
    restored = open({name:'stage1-restored-'+uuid()+'.sqlite',connection:'independent'});
    await restored.executeAsync('PRAGMA foreign_keys=ON'); await migrate(restored);
    await restoreBackup(restored,hydrated,async()=>{}); await verifyDatabase(restored,7);
    const after = await captureBackup(restored);
    if (JSON.stringify(after.data.sync_outbox)!==JSON.stringify(backup.data.sync_outbox) || after.data.sync_local_state[0].mode!=='disabled') throw new Error('Native restore lost pending history');
    db.close();closed=true;
    const reopened=open({name,connection:'independent'});
    try {
      const reloaded=await captureBackup(reopened);
      if(JSON.stringify(reloaded.data)!==JSON.stringify(backup.data)) throw new Error('Native reopen lost data');
    } finally { reopened.close(); }
    return {...result, schemaVersion:7, reopen:'PASS', staging:'PASS',restore:'PASS',bank:name};
  } finally { if(stage){stage.close();stage.delete();} if(restored){restored.close();restored.delete();} if(!closed)db.close();db.delete(); }
}
globalThis.lionPocketSyntheticSync=true;
function App() {
  const [state,setState] = useState('Offline Stage 1 app checks…');
  useEffect(()=>{(async()=>{
    const sodium=await androidCrypto(), uuid=await androidSyncUuidGenerator();
    const crypto=await runCryptoChecks(sodium,require('./fixtures/crypto.json'),require('./fixtures/serialization.json'),protocol,(bytes)=>bytesToHex(sha256(bytes)),require('./fixtures/control.json'),require('./fixtures/peer.json'));
    const local=await runLocal(uuid), secrets=await runSecrets(sodium,uuid), database=await runStorageChecks();
    const identity=await runIdentityChecks();
    const provisioning=await runProvisioningChecks(sodium,()=>new AndroidSecretStore(),require('./fixtures/provisioning.json'));
    NativeModules.CryptoSpikeReport.report(JSON.stringify({...crypto,local,secrets,database,provisioning,identity,runtime:'Android/Hermes/JSI app adapters',api:Platform.Version,reactNative:'0.87.1',binding:'1.7.0',libsodium:'1.0.21'}));
    setState('PASS Stage 1');
  })().catch((error)=>{NativeModules.CryptoSpikeReport.report(JSON.stringify({result:'FAIL',error:String(error),stack:error.stack}));setState(String(error));});},[]);
  return React.createElement(require('./App').default);
}
AppRegistry.registerComponent('LionPocketMobile',()=>App);
