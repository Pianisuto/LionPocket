#!/usr/bin/env python3
"""Bounded spike: libsodium C ABI; public test keys ONLY, no app integration.
Run from root. --generate explicitly replaces the crypto vector; default verifies it.
"""
import base64
import ctypes as c
import ctypes.util
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
fixtures = root / 'packages/sync-protocol/fixtures'
sodium = c.CDLL(ctypes.util.find_library('sodium') or 'libsodium.so')
sodium.sodium_init.restype = c.c_int
assert sodium.sodium_init() >= 0
sodium.sodium_version_string.restype = c.c_char_p
# Explicit ABI signatures: lengths are unsigned long long, buffers are void*.
for name, args in {
    'crypto_aead_xchacha20poly1305_ietf_encrypt': [c.c_void_p, c.c_void_p, c.c_void_p, c.c_ulonglong, c.c_void_p, c.c_ulonglong, c.c_void_p, c.c_void_p, c.c_void_p],
    'crypto_aead_xchacha20poly1305_ietf_decrypt': [c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_ulonglong, c.c_void_p, c.c_ulonglong, c.c_void_p, c.c_void_p],
    'crypto_sign_seed_keypair': [c.c_void_p, c.c_void_p, c.c_void_p],
    'crypto_sign_detached': [c.c_void_p, c.c_void_p, c.c_void_p, c.c_ulonglong, c.c_void_p],
    'crypto_sign_verify_detached': [c.c_void_p, c.c_void_p, c.c_ulonglong, c.c_void_p],
    'crypto_box_seed_keypair': [c.c_void_p, c.c_void_p, c.c_void_p],
    'crypto_box_seal': [c.c_void_p, c.c_void_p, c.c_ulonglong, c.c_void_p],
    'crypto_box_seal_open': [c.c_void_p, c.c_void_p, c.c_ulonglong, c.c_void_p, c.c_void_p],
}.items():
    fn = getattr(sodium, name); fn.argtypes = args; fn.restype = c.c_int

def b64(data): return base64.urlsafe_b64encode(bytes(data)).rstrip(b'=').decode()
def unb64(text): return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))
def canonical_ascii_keys(value):
    # Crypto fixture keys are ASCII. Unicode key sorting is tested by the TS serializer.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
def encrypt(message, aad, nonce, key):
    out = c.create_string_buffer(len(message) + 16); length = c.c_ulonglong()
    assert sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(out, c.byref(length), message, len(message), aad, len(aad), None, nonce, key) == 0
    return out.raw[:length.value]
def decrypt(cipher, aad, nonce, key):
    out = c.create_string_buffer(max(len(cipher), 1)); length = c.c_ulonglong()
    status = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, c.byref(length), None, cipher, len(cipher), aad, len(aad), nonce, key)
    return status, out.raw[:length.value]
def keypair(seed, box=False):
    pk = c.create_string_buffer(32); sk = c.create_string_buffer(32 if box else 64)
    fn = sodium.crypto_box_seed_keypair if box else sodium.crypto_sign_seed_keypair
    assert fn(pk, sk, seed) == 0
    return pk.raw, sk.raw
def flip(data): return bytes([data[0] ^ 1]) + data[1:]

if '--generate' in sys.argv:
    source = json.loads((fixtures / 'crypto-input.json').read_text())
    message = source['plaintextCanonical'].encode(); aad = source['aadCanonical'].encode()
    key = bytes(range(32)); nonce = unb64(source['commit']['operations'][0]['nonce'])
    cipher = encrypt(message, aad, nonce, key)
    commit = source['commit']; commit['operations'][0]['ciphertext'] = b64(cipher)
    signing = canonical_ascii_keys({'context': 'LionPocket/commit/v1', 'commit': commit})
    seed = bytes(range(64, 96)); pk, sk = keypair(seed)
    sig = c.create_string_buffer(64); length = c.c_ulonglong()
    assert sodium.crypto_sign_detached(sig, c.byref(length), signing, len(signing), sk) == 0
    box_seed = bytes(range(96, 128)); box_pk, box_sk = keypair(box_seed, True)
    bundle = canonical_ascii_keys({'formatVersion': 1, 'serverId': commit['serverId'], 'serverEpoch': commit['serverEpoch'], 'vaultId': commit['vaultId'], 'recipientDeviceId': commit['deviceId'], 'registryVersion': '1', 'keyVersion': 1, 'vaultKey': b64(key)})
    sealed = c.create_string_buffer(len(bundle) + 48)
    assert sodium.crypto_box_seal(sealed, bundle, len(bundle), box_pk) == 0
    envelope = dict(commit, signature=b64(sig.raw))
    vector = {'warning': 'PUBLIC TEST KEYS / FIXED NONCE: NEVER USE IN AN APPLICATION', 'suite': 'lp-sodium-v1', 'referenceLibsodium': sodium.sodium_version_string().decode(), 'keyHex': key.hex(), 'signSeedHex': seed.hex(), 'signPublicKeyHex': pk.hex(), 'boxSeedHex': box_seed.hex(), 'boxPublicKeyHex': box_pk.hex(), 'boxSecretKeyHex': box_sk.hex(), 'plaintextCanonical': message.decode(), 'aadCanonical': aad.decode(), 'signingCanonical': signing.decode(), 'envelope': envelope, 'envelopeSha256Hex': hashlib.sha256(canonical_ascii_keys(envelope)).hexdigest(), 'keyBundleCanonical': bundle.decode(), 'sealedBox': b64(sealed.raw)}
    (fixtures / 'crypto.json').write_text(json.dumps(vector, ensure_ascii=False, indent=2) + '\n')

v = json.loads((fixtures / 'crypto.json').read_text())
e = v['envelope']; op = e['operations'][0]
key = bytes.fromhex(v['keyHex']); nonce = unb64(op['nonce']); cipher = unb64(op['ciphertext'])
message = v['plaintextCanonical'].encode(); aad = v['aadCanonical'].encode()
assert encrypt(message, aad, nonce, key) == cipher
assert decrypt(cipher, aad, nonce, key) == (0, message)
for modified in [(flip(cipher), aad, nonce, key), (cipher, aad+b'!', nonce, key), (cipher, aad, flip(nonce), key), (cipher, aad, nonce, flip(key))]:
    assert decrypt(*modified)[0] == -1
pk, sk = keypair(bytes.fromhex(v['signSeedHex']))
assert pk.hex() == v['signPublicKeyHex']
signing = v['signingCanonical'].encode(); sig = unb64(e['signature'])
out = c.create_string_buffer(64); length = c.c_ulonglong()
assert sodium.crypto_sign_detached(out, c.byref(length), signing, len(signing), sk) == 0
assert out.raw == sig
assert sodium.crypto_sign_verify_detached(sig, signing, len(signing), pk) == 0
assert sodium.crypto_sign_verify_detached(flip(sig), signing, len(signing), pk) == -1
assert sodium.crypto_sign_verify_detached(sig, signing+b'!', len(signing)+1, pk) == -1
box_pk, box_sk = keypair(bytes.fromhex(v['boxSeedHex']), True)
assert box_pk.hex() == v['boxPublicKeyHex'] and box_sk.hex() == v['boxSecretKeyHex']
sealed = unb64(v['sealedBox']); out = c.create_string_buffer(len(sealed) - 48)
assert sodium.crypto_box_seal_open(out, sealed, len(sealed), box_pk, box_sk) == 0
assert out.raw == v['keyBundleCanonical'].encode()
assert sodium.crypto_box_seal_open(out, flip(sealed), len(sealed), box_pk, box_sk) == -1
_, other_sk = keypair(bytes(range(128, 160)), True)
assert sodium.crypto_box_seal_open(out, sealed, len(sealed), box_pk, other_sk) == -1
if '--sealed-input' in sys.argv:
    exchange = json.loads(Path(sys.argv[sys.argv.index('--sealed-input') + 1]).read_text())
    sealed = unb64(exchange['sealedBox'])
    out = c.create_string_buffer(len(sealed) - 48)
    assert sodium.crypto_box_seal_open(out, sealed, len(sealed), box_pk, box_sk) == 0
    assert out.raw == v['keyBundleCanonical'].encode()
assert hashlib.sha256(canonical_ascii_keys(e)).hexdigest() == v['envelopeSha256Hex']
print(json.dumps({'runtime': 'Linux libsodium C ABI via ctypes', 'libsodium': sodium.sodium_version_string().decode(), 'result': 'PASS', 'checks': 'AEAD exact bytes + tamper, Ed25519 exact bytes + tamper, sealed box open + tamper/wrong key, envelope SHA-256'}))
