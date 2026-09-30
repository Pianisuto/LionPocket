// Disposable app only. Synthetic SQLite fixtures; no financial app storage or transport.
import React, { useEffect, useState } from 'react';
import { AppRegistry, NativeModules, Text, View, Platform } from 'react-native';
import sodium from 'react-native-libsodium';
import { runStorageChecks } from './storage-checks';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
const { runCryptoChecks } = require('./crypto-checks.cjs');
const protocol = { ...require('./protocol/canonical'), ...require('./protocol/envelope'), ...require('./protocol/control') };
const vector = require('./fixtures/crypto.json');
const serialization = require('./fixtures/serialization.json');
function App() {
  const [state, setState] = useState('Running offline vectors…');
  useEffect(() => {
    (async () => {
      if (!global.HermesInternal || typeof global.jsi_crypto_sign_detached !== 'function')
        throw new Error('Hermes/JSI native binding missing (no WASM fallback accepted).');
      const result = await runCryptoChecks(sodium, vector, serialization, protocol, (bytes) => bytesToHex(sha256(bytes)), require('./fixtures/control.json'), require('./fixtures/peer.json'));
      const database = await runStorageChecks();
      const report = { ...result, database, runtime: 'Android/Hermes/JSI', api: Platform.Version, reactNative: '0.87.1', binding: 'react-native-libsodium 1.7.0', libsodium: '1.0.21' };
      NativeModules.CryptoSpikeReport.report(JSON.stringify(report));
      setState('PASS: ' + result.checks + ' checks');
    })().catch((error) => {
      const report = { result: 'FAIL', error: String(error), stack: error.stack };
      NativeModules.CryptoSpikeReport.report(JSON.stringify(report));
      setState(JSON.stringify(report));
    });
  }, []);
  return React.createElement(View, { style: { padding: 30 } }, React.createElement(Text, {}, state));
}
AppRegistry.registerComponent('LionPocketMobile', () => App);
