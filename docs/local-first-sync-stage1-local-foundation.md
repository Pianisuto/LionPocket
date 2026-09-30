# Etapa 1 — fundação local do piloto manual

30/09/2026. Primeira parte implementada do [readiness](local-first-sync-stage1-readiness.md). **Sync permanece desativado por padrão e sem transporte.** O opt-in disponível somente aos testes exige banco vazio de lançamentos, recorrências, compras parceladas e objetivos; os catálogos padrão não representam dados pessoais. Nenhuma base pessoal, `lionpocket.sqlite` ou instalação financeira foi aberta nos ensaios.

## Decisões implementadas

- **Bindings exatos:** Android `react-native-libsodium@1.7.0`, RN 0.87.1/Hermes/JSI; desktop `libsodium-wrappers-sumo@0.8.4` no Electron main 43.4.0. Android recusa runtime sem Hermes/função JSI; desktop recusa renderer. Fixtures continuam públicas e separadas do código de produto. Não há nonce/seed de fixture nos adapters ou no gerador de IDs.
- **Cofre Android:** seeds/DEKs de 32 bytes são envolvidas com AES-256-GCM, chave não exportável de 256 bits por instalação, IV novo do provider de 12 bytes, tag de 128 bits. AAD canônico `LionPocket/local-wrap/v1` inclui instalação, dispositivo, servidor, epoch, vault, finalidade e versão da chave. Wrappers binários versionados usam `AtomicFile` em `noBackupFilesDir/sync-secrets/<installationId>`, com operações nativas serializadas. Leitura não cria chave; perda da chave com wrappers existentes também impede sobrescrita/regeneração silenciosa. Reinstalação exige provisionamento explícito; não há recovery automático. Remover um segredo remove seu wrapper, sem destruir a chave compartilhada de outros segredos da instalação.
- **Cofre desktop:** `DesktopSecretStore` usa `safeStorage` somente no main; recusa indisponibilidade e, no Linux, qualquer backend fora de `gnome_libsecret`/KWallet suportado, incluindo `basic_text`. Contexto e segredo são envolvidos pelo cofre e conferidos na leitura. Somente wrappers cifrados `.bin` são persistidos, com arquivo temporário exclusivo, permissões 0600, fsync e rename; diretório 0700 e fsync de diretório no Unix. Erros de unlock não apagam o wrapper nem oferecem fallback em claro. O adapter recebe um diretório privado do main, fora do banco/export. Não existe provisioning ou chamada de cofre necessária ao uso local padrão.
- **Migrations:** mobile **6**, desktop **12**. Mesmos sidecars compartilhados em `@lionpocket/sync-local`, sem ALTER/rebuild das tabelas financeiras nessa migration. Atualização desktop de schema financeiro v11 completo executa somente v12, sem repetir correções históricas. Bancos anteriores seguem os caminhos históricos protegidos. A proteção pré-migration inclui WAL e aborta se não conseguir salvar a cópia.
- **Identidade e contadores:** `local_id` continua intacto. No opt-in vazio, `local_scope_id` nasce por UUIDv4 seguro; cada manual elegível recebe outro UUIDv4 independente. Desktop usa CSPRNG do Node; Android usa `randombytes_buf` nativo e bits RFC. Não existe backfill/onboarding de bases preenchidas. `local_seq` é separado de `device_seq`: este último e cursores remotos continuam `"0"`, sem device ativo. Incremento decimal textual não perde precisão acima de `Number.MAX_SAFE_INTEGER` e recusa esgotamento int64.
- **Atomicidade:** criar/editar/realizar/excluir passam por transação financeira + rotina comum de sidecars no mesmo handle SQLite. A rotina é um gerador de comandos SQL executado de forma síncrona no desktop e assíncrona no Nitro; ela nunca abre conexão/transação própria. Inclui identidade, revisão imutável pelo caminho de escrita, pais, troca do head, tombstone quando necessário, outbox e contador. Baixa em lote também registra cada alteração e reverte o lote inteiro se falhar. NULL e zero permanecem distintos; prioridade removida na exclusão também participa do rollback.
- **Escopo:** somente `source_type=manual`, sem source ID, categoria, pagamento, cartão, parcela ou ocorrência. Os demais objetos continuam locais. Uma edição de objeto já rastreado que tente sair do escopo é recusada com rollback; múltiplos heads aguardam resolução explícita futura. Identidade/história não têm FK com a projeção financeira, permitindo conservar tombstones mesmo após DELETE físico.
- **Outbox deste recorte:** payload canônico local completo, uma revisão por commit pendente, sem compactação/TTL/GC. Ainda **não é envelope de rede**: header remoto, trust, cifra, assinatura e digest só serão preparados após binding explícito no próximo fluxo. Os payloads locais/SQLite/exports seguem em claro, como os dados financeiros existentes; nenhum segredo criptográfico é gravado ali. Payloads não são truncados para caber no limite futuro de rede. Sync desativado não gera identidades/revisões/outbox nem inventa uma fila sem adesão.

## Schema e backups

| Tabela | Conteúdo |
| --- | --- |
| `sync_local_state` | modo desativado/sintético, linhagem, slots de binding e contadores locais/remotos textuais |
| `sync_identity` | associação única `(manualTransaction, local_id) → object_id` |
| `sync_revisions` | revision/op ID, objeto, commit, sequência local, ação, autoria, pais e plaintext canônicos |
| `sync_heads` | heads referenciando revisão e objeto por FK composta |
| `sync_tombstones` | revisão de exclusão, objeto e instante; sem coleta |
| `sync_outbox` | payload pendente; slots para envelope/digest/erro e estados futuros |
| `sync_inbox` | envelope recebido, posição textual, estado e erro; sem receptor implementado |

Backup/staging mobile reconhecem todas as colunas v6, preservam versões anteriores e validam a coerência de identidade, cadeia local, heads, tombstones, counter e outbox. Pais inexistentes, metadata divergente ou payload não canônico são recusados antes de substituir a base. O validador deste recorte aceita outbox local `pending`; a implementação dos demais estados exigirá atualizar esse validador antes de publicar o próximo schema/fluxo.

Staging mantém os dados exatamente como recebidos, incluindo linhagem e payloads pendentes. Restore atômico conserva esses dados e força modo `disabled`, sem restaurar instalação, sessão, chave ou binding. Ausência no backup não é tombstone de rede. O app ainda não tem fluxo para voltar a ativar uma linhagem restaurada; isso depende de onboarding/recovery futuros.

SQLite desktop contém os sidecars; exportação JSON pelo IPC inclui `schemaVersion:12` e sidecars validados. `exportData()` mantém o contrato financeiro de intercâmbio para seus consumidores existentes; `exportData(true)` é a captura completa usada pelo exportador de backup. Core reconhece esse JSON e o staging converte os nomes financeiros para mobile v6 conservando sidecars. A importação aditiva desktop→mobile continua funcionando para exportações sem linhagem; uma linhagem/filas recebidas são recusadas para impedir descarte ou mescla implícita. Restauração de backup mobile continua disponível. Nenhum wrapper, token, seed ou DEK acompanha JSON/SQLite.

## Verificações e evidência

Relatórios completos, integridades, hashes de fontes/vetores/APKs: [`fixtures/local-first/stage1-results.json`](fixtures/local-first/stage1-results.json). São fixtures públicas e IDs sintéticos; as sealed boxes têm randomness e diferem em outra execução.

| Verificação | Resultado |
| --- | --- |
| `npm test` | 246 testes: core 61, desktop 67, mobile 81, protocolo 35, sync-local 2 |
| `npm run typecheck`, `npm run lint`, `git diff --check` | Aprovados; lint sem warnings |
| Vitest desktop no Node do binário Electron | 67 testes, incluindo proteção/WAL, v11→12 aditiva, falha no último DDL real e lote atômico |
| Electron **main**, adapters dos apps | 104 checks crypto com peer Android; 44 checks do fluxo manual, **12 falhas SQL reais**, quatro revisões/outbox; reabertura aprovada; sete checks do cofre `gnome_libsecret` |
| Android **debug e release**, Hermes/JSI | 104 checks crypto por build, abrindo sealed box Electron; mesmos 44 checks/12 falhas SQL reais, staging/restore/reabertura aprovados |
| Migrations no Nitro SQLite Android | 198 checks por build, versões 1–5→6; colunas históricas preservadas, proteção de backup, WAL, falha tardia na migration real v6 e rollback do DDL |
| Cofre Android real | dez checks por build do adapter persistente: arquivo ausente, reabertura, isolamento, nonce novo, escrita seguinte, AAD errado, tag adulterada, chave perdida, sobrescrita bloqueada e remoção; seis checks AES independentes adicionais |
| Troca Android↔Electron e ABI C | Sealed boxes de ambos os builds abertas no main Electron e em libsodium C; vetores golden de commit/controle/recovery preservados |

O cenário manual compartilhado usa triggers SQLite temporários com `RAISE(ABORT)` **após** escrita em domínio, identidade, revisão, heads, tombstone, outbox, contador ou remoção de prioridade. Compara todas as linhas financeiras e todos os sidecars antes/depois: qualquer falha deixa o snapshot anterior intacto. Não substitui o writer por mock. Os testes de indisponibilidade/unlock desktop usam mocks do SO e estão identificados separadamente; os sete checks do main usam o cofre real.

Android: API 36/x86_64, SQLite 3.49.0, libsodium distribuída 1.0.21; Electron: Node 24.18.1/libsodium 1.0.22. Keystore do emulador reporta software (`securityLevel=0`), sem claim de hardware. Release é o buildType release do template, com assinatura debug pública, JS embutido e dev support desligado; não é artefato de distribuição. O APK de ensaio tem applicationId separado `com.lionpocketmobile.cryptospike`; o banco desktop fica em `/tmp`, cada banco Android tem nome aleatório na área privada desse pacote. A AVD foi iniciada read-only, sem snapshots.

## Arquivos alterados

- `packages/sync-local/{package.json,tsconfig.json,.eslintrc.json,src/*}`: schema, rotina SQL do piloto, validação de backup, scope de wrapping, UUIDv4 e aritmética textual; testes puros.
- `apps/desktop/src/main/{database.ts,migrationProtection.ts,ipc.ts}`: v12, transações das ações manuais/lotes, preservação de v11 e export/backup completo. `main/sync/{crypto.ts,secretStore.ts,manualSync.test.ts,secretStore.test.ts}`: bindings/cofre e testes; `migrationProtection.test.ts`: migrations reais/proteção.
- `apps/mobile/src/db/{migrations.ts,repository.ts,backupRepository.ts,importRepository.ts}` e `src/files/localData.ts`: v6, rotina no tx Nitro, staging/restore/merge. `src/sync/{crypto.ts,secretStore.ts}` e Android `MainApplication.kt`/`SyncSecretsModule.kt`: JSI e Keystore. `db/{manualSync.test.ts,migrationProtection.test.ts,functionalParity.test.ts}`: cenários e atualização dos writers de fixtures históricas, que não tinham hook de sync.
- `packages/core/src/local-files.ts`: identificação/conversão do JSON desktop novo sem perder ocorrência explícita.
- Manifests dos apps, `package.json`, `package-lock.json`, `.gitignore`: dependências exatas, workspace e build/checagem do pacote compartilhado. Os builds do core usados pelos apps também compilam protocolo/sync-local.
- `tools/sync-stage1/*`: cenário comum, main Electron, preparador Android, app de teste e probe de falhas do cofre **somente no harness**. `tools/sync-stage0/{prepare-native-harness.cjs,native-harness/storage-checks.js}`: reutilização com workspace novo e fixtures 1–5→schema corrente; goldens originais não foram regenerados.
- Este documento, readiness e `stage1-results.json`: decisões, reprodução, evidências e fronteira do próximo PR.

## Reprodução

Da raiz, Node 24 e dependências do lockfile:

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run sync:stage1:electron:build
stage1_reports=$(mktemp -d /tmp/lion-stage1-reports.XXXXXX)
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron .vite/stage1/electron.cjs "$stage1_reports/electron-initial.json"
```

O desktop runner exige um cofre suportado e aberto para aprovar o cenário de persistência real; recusa/falha não gera fallback. Para testar SQLite no Node do Electron, a partir de `apps/desktop`:

```bash
ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron ../../node_modules/vitest/vitest.mjs run
```

Android usa o [SDK/NDK/JDK 21 completo da receita anterior](local-first-sync-crypto-spike.md#reprodução-android-isolada). Ajustar as variáveis às instalações locais; não configurar Java global:

```bash
stage1_sdk=/absolute/path/to/Android/Sdk
stage1_jdk=/absolute/path/to/full-jdk-21
stage1_native=$(mktemp -d /tmp/lion-stage1-native.XXXXXX)
node tools/sync-stage1/prepare-android.cjs "$stage1_native" "$stage1_sdk" "$stage1_reports/electron-initial.json"
npm install --prefix "$stage1_native" --ignore-scripts --no-audit --no-fund
# Necessário quando a política de install scripts não executou o postinstall do binding.
tar --warning=no-unknown-keyword -xzf "$stage1_native/node_modules/react-native-libsodium/libsodium/build.tgz" --directory "$stage1_native/node_modules/react-native-libsodium/libsodium"
JAVA_HOME="$stage1_jdk" "$stage1_native/apps/mobile/android/gradlew" -p "$stage1_native/apps/mobile/android" :app:assembleDebug :app:assembleRelease -PreactNativeArchitectures=x86_64 -Dorg.gradle.vfs.watch=false --no-daemon --max-workers=2
```

Iniciar AVD de teste em outra shell, numa porta livre:

```bash
"$stage1_sdk/emulator/emulator" -avd LionPocket_API_36 -no-window -no-audio -no-snapshot-load -no-snapshot-save -read-only -gpu swiftshader -port 5580
```

Após `sys.boot_completed=1`, instalar/executar debug; repetir com `release/app-release.apk` e nome de relatório release:

```bash
"$stage1_sdk/platform-tools/adb" -s emulator-5580 shell am force-stop com.lionpocketmobile.cryptospike
"$stage1_sdk/platform-tools/adb" -s emulator-5580 install -r "$stage1_native/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
"$stage1_sdk/platform-tools/adb" -s emulator-5580 shell am start -n com.lionpocketmobile.cryptospike/com.lionpocketmobile.MainActivity
python3 tools/sync-stage0/collect-native-report.py "$stage1_sdk/platform-tools/adb" emulator-5580 "$stage1_reports/android-debug.json"
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron .vite/stage1/electron.cjs "$stage1_reports/electron-debug-peer.json" "$stage1_reports/android-debug.json"
python3 tools/sync-stage0/crypto-native.py --sealed-input "$stage1_reports/android-debug.json"
# Ao terminar os dois builds, encerrar somente a AVD criada para este ensaio:
"$stage1_sdk/platform-tools/adb" -s emulator-5580 emu kill
```

O preparador copia o código real dos apps/pacotes para o harness, sem patches de vendor, e adiciona o probe somente ao pacote descartável. Não usar o app financeiro instalado como runner. O collector filtra o PID atual e recusa ausência de PASS, evitando reutilizar resultado antigo.

## Preparado para o próximo PR

A fundação deixa prontos os bindings/cofres, schema aditivo comum, transação manual→história/outbox, preservação/validação de backup e ensaios nativos reproduzíveis. O próximo fluxo deverá implementar provisioning/trust e registry, pedido de pareamento, prova HTTP/replay e decoder limitado; depois binding remoto, preparação cifrada imutável da outbox, recibos/retry/inbox/projeção/conflictos, e API/Keycloak/PKCE conforme o readiness. Essas partes precisam de verificações próprias antes de habilitar capabilities.

Este PR não implementa API, login, transporte, onboarding, registro de aparelhos, rotação/recovery, projeção remota nem UI de conflitos. Zero capabilities remotas e nenhum botão de adesão. Os critérios completos de fluxo vertical da Etapa 1 ainda não estão aceitos. Permanecem os gates anteriores para dados reais/publicação: arm64 físico, Windows/cofres reais, upgrade do produto distribuído, falhas de storage/interrupção e revisão independente de trust/recovery/restore/epoch.
