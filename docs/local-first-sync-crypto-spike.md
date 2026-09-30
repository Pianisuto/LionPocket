# Spike criptográfico delimitado — Etapa 0

30/09/2026. **PASS entre libsodium C, Node, Electron main real e Android/Hermes/JSI, debug e release**, no recorte abaixo. O complemento posterior ao commit `4fb76f2` resolveu a inconclusão nativa do primeiro ensaio. [Decisões e entrada na Etapa 1](local-first-sync-stage1-readiness.md). Não existe crypto de sync nos apps financeiros; nenhum binding foi adicionado aos manifests/lockfile do monorepo.

## Pergunta e recorte

A suite `lp-sodium-v1` reproduz bytes canônicos, AEAD+tag e assinatura; abre sealed boxes da outra plataforma; deriva a mesma chave de recovery; e recusa adulteração? Usamos exclusivamente segredos **públicos de teste**, uma revisão manual de 1234 centavos, realizado zero, NULL, Unicode e int64 textual acima de `Number.MAX_SAFE_INTEGER`. Nenhum dado financeiro pessoal foi lido.

O complemento usa Electron de desenvolvimento com `userData` temporário e app Android descartável `com.lionpocketmobile.cryptospike`, copiando o template RN atual. Hermes e funções globais JSI nativas são obrigatórios. JS embutido nos APKs, dev support desligado; execução offline, sem Metro. A AVD x86_64/API 36 foi iniciada read-only, sem snapshots. Há também testes de Keystore e migrations em **fixtures sintéticas próprias**, sem abrir o app financeiro. Fora do recorte: rede/login, pairing funcional, cofre persistente dos apps, recovery/rotação completos, dados reais e auditoria independente.

## Evidência observada

[Relatórios, integridades das dependências e hashes dos vetores/APKs](fixtures/local-first/native-results.json).

| Execução / artefato | Resultado |
| --- | --- |
| `serialization.json` | Canonical string, UTF-8/hex e SHA-256; zero/NULL, decimal textual, escapes, acento composto/decomposto e ordem UTF-16 de chaves fora do BMP. Node, Electron e Hermes concordam. |
| `crypto-input.json` / `crypto.json` | Plaintext/AAD/signing input fixos; AEAD combinado, assinatura Ed25519 detached, digest do envelope, X25519 e sealed box C fixa. Input tem placeholder vazio, não é envelope válido. |
| `control.json` | Grants approved/revoked, predecessor completo assinado, entrega com assinatura externa de dispositivo e recovery com seed administrativa/DEKs. C ABI gera/verifica bytes fixos; OpenSSL verifica assinaturas/autoria e alterações; Electron e JSI reproduzem assinatura/KDF/ciphertext exatos. |
| C ABI/Linux | libsodium 1.0.18: AEAD/Ed25519 byte a byte, recusas de adulteração, sealed box C fixa; abre sealed boxes aleatórias de Electron, Android debug e release. |
| Node do host | Node 24.21.0, wrappers-sumo 0.8.4/libsodium 1.0.22: primeiro ensaio aprovado. OpenSSL dos testes padrão aprova commit e controle sem adicionar sodium ao workspace. |
| Electron main | Electron 43.4.0, Node 24.18.1, wrappers-sumo 0.8.4/libsodium 1.0.22: 103 checks sem peer; 104 com sealed box Android debug/release. `safeStorage` disponível, backend `gnome_libsecret`; somente disponibilidade inspecionada, sem criar entrada persistente. |
| Android debug **e** release | RN 0.87.1/Hermes/JSI, binding 1.7.0, libsodium distribuída 1.0.21: 104 checks por build, abrindo sealed box gerada pelo Electron. Native binding não exporta version query; versão sodium reportada vem dos headers distribuídos. |
| Keystore em ambos os builds | 6 checks AES-256-GCM: tamanhos de nonce/tag, fresh nonce, round-trip, ciphertext adulterado e AAD errado. Chave efêmera apagada. `securityLevel=0`, software; não prova hardware. |
| SQLite Android em ambos os builds | Driver Nitro 10.0.0, SQLite 3.49.0; código real das migrations 1–4 → 5 e 136 checks de preservação/backup/rollback/integridade. Não é migration de sync. |
| SQLite Electron | 58 testes desktop passam no Node do binário Electron, com proteção de migration/WAL/rebuild. Não é ensaio de upgrade do produto instalado. |

O runner comum cobre todos os campos de controle e AAD, posição/quantidade da operação, pais/IDs/nonce, keyVersion/registryVersion, ciphertext/assinatura truncados ou adulterados, destinatário errado, Uint8Array com byteOffset, UTF-8 nativo, pares/formatos de chave e fresh randombytes. Recovery testa master/contexto/subkey ID errados. Amostras distintas de randomness não são uma auditoria do CSPRNG. Sealed boxes têm randomness: **abertura do bundle completo**, não igualdade entre duas cifragens, comprova a troca.

A primeira tentativa histórica com o executável financeiro instalado tinha `RunAsNode=false`, abriu a UI e foi encerrada sem ações; não contou como teste. Todas as evidências deste complemento usam binário de desenvolvimento e pacote Android separado.

## Construções e escolha para desenvolvimento

[XChaCha20-Poly1305 de libsodium](https://libsodium.gitbook.io/doc/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction): chave 32, nonce 24 e tag 16 bytes anexada. [Sealed boxes](https://libsodium.gitbook.io/doc/public-key_cryptography/sealed_boxes): X25519 + XSalsa20-Poly1305, overhead 48; autoria depende da assinatura externa. Ed25519 detached direto, sem prehash, e pares Ed/X independentes. Recovery usa a [KDF de alta entropia](https://libsodium.gitbook.io/doc/key_derivation), não password KDF. Contexts e bytes estão nos [contratos](local-first-sync-contracts.md).

Desktop: [libsodium.js oficial](https://github.com/jedisct1/libsodium.js), wrappers-sumo **0.8.4** no main. Android: [react-native-libsodium](https://github.com/serenity-kit/react-native-libsodium/tree/052cb17825b2b24e7d616a0264ef339b0e3667f3), **1.7.0**, selecionado para o piloto após builds/executações sem patches. O pacote anuncia ambiente RN 0.83.1 em desenvolvimento, mas o ensaio comprovou este recorte em RN 0.87.1/Nitro 0.37.1. Não inferir compatibilidade de outra ABI ou versão futura a partir disso; repetir vetores ao atualizar qualquer binding/runtime.

## Reprodução C, Node e Electron

Da raiz, depois de `npm ci`, com Node 24, libsodium C do sistema e Electron de desenvolvimento disponível:

```bash
npm run build:contracts
npm run test --workspace @lionpocket/sync-protocol
python3 tools/sync-stage0/crypto-native.py
python3 tools/sync-stage0/create-control-vectors.py
sync_crypto_dir=$(mktemp -d /tmp/lionpocket-sync-crypto.XXXXXX)
npm install --prefix "$sync_crypto_dir" --ignore-scripts --no-audit --no-fund libsodium-wrappers-sumo@0.8.4
node tools/sync-stage0/crypto-desktop.cjs "$sync_crypto_dir" "$sync_crypto_dir/node-report.json"
python3 tools/sync-stage0/crypto-native.py --sealed-input "$sync_crypto_dir/node-report.json"
# Se dist/electron estiver ausente, baixar o binário de desenvolvimento declarado no lock:
node node_modules/electron/install.js
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron tools/sync-stage0/crypto-electron.cjs "$sync_crypto_dir" "$sync_crypto_dir/electron-report.json"
```

SQLite desktop no runtime Electron, **a partir de `apps/desktop`** (fixtures usam esse cwd):

```bash
ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron ../../node_modules/vitest/vitest.mjs run
```

Crypto main requer `ELECTRON_RUN_AS_NODE` removido; testes SQLite usam esse modo deliberadamente. Não substituir pelo executável do LionPocket instalado.

## Reprodução Android isolada

Pré-requisitos: SDK/NDK do template, AVD de teste e **JDK 21 completo com javac**. O host tinha só JRE; usamos [Temurin 21.0.12.1+1](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1), arquivo Linux x64 com SHA-256 `ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94`, extraído em `/tmp`. Não instalar/alterar Java global para reproduzir. Na mesma shell dos comandos anteriores:

```bash
# Ajustar SDK/AVD/JDK às instalações locais; usar uma porta de emulator livre.
sync_sdk=/absolute/path/to/Android/Sdk
sync_jdk=/absolute/path/to/full-jdk-21
sync_native_dir=$(mktemp -d /tmp/lionpocket-sync-native.XXXXXX)
node tools/sync-stage0/prepare-native-harness.cjs "$sync_native_dir" "$sync_sdk" "$sync_crypto_dir/electron-report.json"
npm install --prefix "$sync_native_dir" --ignore-scripts --no-audit --no-fund
# Postinstall desativado: extrair explicitamente o arquivo nativo distribuído pelo binding.
tar --warning=no-unknown-keyword -xzf "$sync_native_dir/node_modules/react-native-libsodium/libsodium/build.tgz" --directory "$sync_native_dir/node_modules/react-native-libsodium/libsodium"
JAVA_HOME="$sync_jdk" "$sync_native_dir/apps/mobile/android/gradlew" -p "$sync_native_dir/apps/mobile/android" :app:assembleDebug :app:assembleRelease -PreactNativeArchitectures=x86_64 -Dorg.gradle.vfs.watch=false --no-daemon --max-workers=2
```

Iniciar a AVD em terminal separado (trocar `LionPocket_API_36` pelo nome disponível):

```bash
"$sync_sdk/emulator/emulator" -avd LionPocket_API_36 -no-window -no-audio -no-snapshot-load -no-snapshot-save -read-only -gpu swiftshader -port 5580
```

Esperar `adb -s emulator-5580 shell getprop sys.boot_completed` retornar `1`. Instalar/executar **debug**, depois repetir a instalação/execução com **release**, substituindo nomes do APK e do relatório:

```bash
"$sync_sdk/platform-tools/adb" -s emulator-5580 shell am force-stop com.lionpocketmobile.cryptospike
"$sync_sdk/platform-tools/adb" -s emulator-5580 install -r "$sync_native_dir/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
"$sync_sdk/platform-tools/adb" -s emulator-5580 shell am start -n com.lionpocketmobile.cryptospike/com.lionpocketmobile.MainActivity
python3 tools/sync-stage0/collect-native-report.py "$sync_sdk/platform-tools/adb" emulator-5580 "$sync_native_dir/android-debug-report.json"
# Abre a sealed box gerada por Android no Electron e no C (repetir com o report release):
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron tools/sync-stage0/crypto-electron.cjs "$sync_crypto_dir" "$sync_crypto_dir/peer-debug-report.json" "$sync_native_dir/android-debug-report.json"
python3 tools/sync-stage0/crypto-native.py --sealed-input "$sync_native_dir/android-debug-report.json"
# Encerrar somente o emulator iniciado para este ensaio:
"$sync_sdk/platform-tools/adb" -s emulator-5580 emu kill
```

Collector filtra PID atual e falha em 30 s se não houver report; não aceitar PASS de um build anterior. Package release não é debuggable e não depende de `run-as`. APKs/relatórios não entram no produto. Preserve reports para revisão; as sealed boxes geradas diferem a cada execução.

## Regeneração e gates restantes

Verificação usa golden files fixos; regeneração é explícita: `npx tsx tools/sync-stage0/create-protocol-vectors.ts`, `python3 tools/sync-stage0/crypto-native.py --generate`, depois `python3 tools/sync-stage0/create-control-vectors.py --generate`. Revisar diffs de plaintext/AAD/ciphertext/assinatura/hash, nunca regenerar para esconder falha. Regerar control após alterar a sealed box fixa do commit, pois entrega a inclui. Em produção não usar seed/nonce/chave de fixture, Python/ctypes ou os runners.

Antes de publicação/dados reais: executar em arm64 físico e Electron Windows/Linux com cofres reais; adapters duráveis e lifecycle de recovery/rotação/revogação; revisão independente; assinatura HTTP/pairing com vetores próprios; decoder de bytes/quotas; upgrade de instalações preenchidas e restore/epoch. O recorte nativo aprovado permite começar a Etapa 1 em desenvolvimento, não declarar E2EE ou sync pronto.
