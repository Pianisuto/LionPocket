#!/usr/bin/env python3
"""Default verifies the fixed vector; regeneration is explicit. Public deterministic test secrets; libsodium C ABI."""
# This script deliberately regenerates only control.json, never the commit golden vector.
import runpy
import sys
from pathlib import Path
if sys.argv[1:] not in ([], ['--generate']):
    raise SystemExit('Usage: python3 tools/sync-stage0/create-control-vectors.py [--generate]')
generate = '--generate' in sys.argv
sys.argv = [sys.argv[0]]
g = runpy.run_path(str(Path(__file__).with_name('crypto-native.py')))
sodium, c, v = g['sodium'], g['c'], g['v']
canonical, b64, keypair, encrypt = (g[k] for k in ['canonical_ascii_keys', 'b64', 'keypair', 'encrypt'])
sodium.crypto_kdf_derive_from_key.argtypes = [c.c_void_p, c.c_size_t, c.c_ulonglong, c.c_void_p, c.c_void_p]
sodium.crypto_kdf_derive_from_key.restype = c.c_int
seed = bytes(range(128, 160)); authority_pk, authority_sk = keypair(seed)
_, device_sk = keypair(bytes.fromhex(v['signSeedHex']))
scope = {k: v['envelope'][k] for k in ['serverId', 'serverEpoch', 'vaultId']}
def sign(payload, context, name, sk):
    signing = canonical({ 'context': context, name: payload })
    out = c.create_string_buffer(64); length = c.c_ulonglong()
    assert sodium.crypto_sign_detached(out, c.byref(length), signing, len(signing), sk) == 0
    return { 'signingCanonical': signing.decode(), name: dict(payload, signature=b64(out.raw)) }
grant = dict(formatVersion=1, **scope, registryVersion='1', previousRegistrySha256=None,
    deviceId=v['envelope']['deviceId'], signingPublicKey=b64(bytes.fromhex(v['signPublicKeyHex'])),
    boxPublicKey=b64(bytes.fromhex(v['boxPublicKeyHex'])), status='approved')
approved = sign(grant, 'LionPocket/device-grant/v1', 'grant', authority_sk)
previous = b64(g['hashlib'].sha256(canonical(approved['grant'])).digest())
revoked = sign(dict(grant, registryVersion='2', previousRegistrySha256=previous, status='revoked'), 'LionPocket/device-grant/v1', 'grant', authority_sk)
delivery = sign(dict(formatVersion=1, **scope, recipientDeviceId=grant['deviceId'], registryVersion='1',
    keyVersion=1, sealedBox=v['sealedBox'], authorDeviceId=grant['deviceId']), 'LionPocket/key-delivery/v1', 'delivery', device_sk)
master = bytes(range(192, 224)); derived = c.create_string_buffer(32)
assert sodium.crypto_kdf_derive_from_key(derived, 32, 1, b'LPRECOV1', master) == 0
nonce = bytes(range(160, 184))
header = dict(formatVersion=1, cryptoSuite='lp-sodium-v1', **scope, recoveryVersion='1',
    kdf='sodium-kdf-blake2b-LPRECOV1-1', nonce=b64(nonce))
bundle = dict(formatVersion=1, **scope, recoveryVersion='1', registryVersion='1',
    authoritySignSeed=b64(seed), authorityPublicKey=b64(authority_pk), activeKeyVersion=1,
    dataKeys=[dict(keyVersion=1, vaultKey=b64(bytes.fromhex(v['keyHex'])))])
aad = canonical(dict(context='LionPocket/recovery/v1', header=header)); message = canonical(bundle)
recovery = dict(code='LP1.' + b64(master), masterHex=master.hex(), derivedKeyHex=derived.raw.hex(),
    aadCanonical=aad.decode(), bundleCanonical=message.decode(), envelope=dict(header, ciphertext=b64(encrypt(message, aad, nonce, derived.raw))))
result = dict(warning='PUBLIC TEST SECRETS / FIXED NONCES: NEVER USE IN AN APPLICATION',
    referenceLibsodium=sodium.sodium_version_string().decode(), authoritySeedHex=seed.hex(), authorityPublicKeyHex=authority_pk.hex(),
    approved=approved, revoked=revoked, delivery=delivery, recovery=recovery)
target = g['fixtures'] / 'control.json'
if generate:
    target.write_text(g['json'].dumps(result, ensure_ascii=False, indent=2) + '\n')
else:
    expected = g['json'].loads(target.read_text())
    result['referenceLibsodium'] = expected['referenceLibsodium']
    assert result == expected, 'Control golden vector mismatch; never regenerate to conceal a failure.'
print(g['json'].dumps({'result': 'PASS', 'runtime': 'libsodium C ABI', 'checks': 'approval/revocation/delivery signatures exact, recovery BLAKE2b KDF and AEAD exact'}))
