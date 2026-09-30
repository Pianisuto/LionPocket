# Etapa 1 — fluxo vertical manual desktop ↔ Android

30/09/2026. Continuação do [provisioning](local-first-sync-stage1-provisioning.md). Implementa transporte de `manualTransaction` em ambiente local de desenvolvimento, com **vault sintético e bancos vazios separados**. Sync permanece desativado por padrão. O servidor só anuncia `manualTransaction` quando o aceite está registrado e ambos os opt-ins são `synthetic-only`; nenhuma outra entidade está habilitada.

## Comportamento implementado

- A primeira preparação cifra cada revisão com XChaCha20-Poly1305, nonce aleatório e AAD de escopo/operação, e assina o commit com Ed25519. Envelope canônico, SHA-256, proveniência e `deviceSeq` são persistidos juntos. Um trigger impede alterar o envelope preparado. Retry conserva os mesmos bytes, IDs e digest; a prova HTTP recebe nonce novo. Só um recibo válido com escopo, identidade, sequência e digest correspondentes confirma a outbox.
- PostgreSQL recebe o commit inteiro sob lock do vault, na mesma transação que operações, heads, recibo e incremento de `log_position`. Repetição idêntica retorna o recibo original; reutilização de commit/operação/seq com conteúdo diferente é recusada. Assinatura, registry histórico/atual, membership, dispositivo ativo, epoch, chave e pais são verificados antes do append. Falha SQL não consome posição do log.
- Pull vincula cursor a servidor/epoch/vault/binding/dispositivo, ordena por bigint e fixa um horizonte até acabar a paginação. Até 100 commits e 4 MiB por página; até 1 MiB, 100 operações e 32 pais por commit. Nenhuma página divide um commit. `received_cursor` avança somente com a inbox durável; `applied_cursor` só atravessa posições aplicadas contíguas.
- Recepção valida assinatura e grants, decifra e aplica revisões, identidade, heads, conflito, tombstone e projeção financeira em transação SQLite. Commit próprio não gera eco. Falhas de cofre, payload/versão incompatível, assinatura inválida e pais ausentes conservam envelope e erro em quarentena, com nova tentativa nas próximas sincronizações. O log sem GC permite buscar novamente a história pela paginação; este recorte não oferece endpoint separado de busca de pais.
- Edição concorrente conserva os ramos e contabiliza a última base comum válida. Sem base comum, o objeto fica fora dos totais. A resolução referencia exatamente os heads exibidos; se o servidor já tiver outro ramo, conserva o rascunho recusado em `sync_rejected`, recebe os novos heads e exige outra resolução. Exclusão versus edição mantém o original oculto. Recuperar a edição cria novas identidades local/global, com proveniência, sem ressuscitar o tombstone.
- Migrações aditivas desktop **13** e Android **7** acrescentam binding/checkpoint, proveniência remota, recibo, horizonte e conflitos. Backup, staging e restore preservam todo o histórico, envelopes, quarentena e rascunhos. Validadores conferem relações, digest e recibos; restore desativa sync. Seeds, DEK e tokens não fazem parte do backup financeiro.
- Configurações no desktop e Dados no Android expõem sincronização manual e revisão de conflitos somente no perfil de desenvolvimento. Login ocorre quando solicitado, sem timer ou credenciais persistidas. Dados financeiros e exports locais continuam em claro, conforme a decisão anterior; apenas o transporte/conteúdo remoto é E2EE.

## Subir e usar as telas de desenvolvimento

Pré-requisitos e credenciais sintéticas: [guia de provisioning](local-first-sync-stage1-provisioning.md#subir-o-ambiente). Na raiz:

```bash
npm ci
npm run sync:dev:up
LIONPOCKET_SYNC_DEV=synthetic-only LIONPOCKET_SYNC_MANUAL=synthetic-only npm run sync:dev:server
```

Criar o fundador em `/tmp/lion-sync-dev-a` com a [receita de provisioning](local-first-sync-stage1-provisioning.md#parear-dois-dispositivos-de-desenvolvimento). O CLI prepara só identidade/cofre. Para abrir o banco sintético do desktop:

```bash
LIONPOCKET_SYNC_DEV=synthetic-only LIONPOCKET_SYNC_MANUAL=synthetic-only \
  LIONPOCKET_SYNC_PROFILE=/tmp/lion-sync-dev-a npm start
```

O app usa `/tmp/lion-sync-dev-a/manual.sqlite` e `electron-app`, recusando execução empacotada. Em Configurações, usar **Entrar e sincronizar agora**, com a mesma conta alice do fundador. Criar apenas lançamentos manuais sem categoria, pagamento, cartão, recorrência ou parcela. Os apps mantêm suas funções locais offline; ações fora do escopo não são aceitas no banco opt-in do piloto.

No Android usar exclusivamente o APK descartável `com.lionpocketmobile.cryptospike`. Seu entry point precisa definir `globalThis.lionPocketSyntheticSync=true` **antes** de carregar o app/abrir o banco; a aplicação instalada não tem esse opt-in nem o módulo de harness. Encaminhar portas `18080` e `8787` por adb. Na tela Dados, colar o trust pin público de `invitation.json`, conferir a autoridade/fingerprint no canal confiável e registrar o pedido com login alice. Copiar o pedido público mostrado pela tela para um arquivo e aprová-lo no CLI fundador, comparando o fingerprint. Depois escolher **Entrar e receber chave aprovada** e **Entrar e sincronizar agora**. Os botões de resolução mostram todos os ramos e os heads revisados.

O ensaio automático abaixo executa os controllers/repositórios reais e o protocolo entre runtimes nativos. Ele recebe sessões OIDC transitórias pelo broker loopback de teste; não automatiza o Custom Tab nem os cliques das telas.

## Reprodução automática

Com PostgreSQL/Keycloak ativos:

```bash
npm test
npm run sync:dev:test
npm run lint
npm run typecheck
git diff --check
node tools/sync-dev/build-client.cjs --transport
node tools/sync-dev/build-client.cjs --reopen
```

Preparar o Android em diretório descartável, reutilizando SDK/NDK e JDK 21 completo da [receita nativa](local-first-sync-crypto-spike.md#reprodução-android-isolada):

```bash
transport_sdk=/absolute/path/to/Android/Sdk
transport_jdk=/absolute/path/to/full-jdk-21
transport_native=$(mktemp -d /tmp/lion-sync-transport-native.XXXXXX)
node tools/sync-dev/prepare-transport-android.cjs "$transport_native" "$transport_sdk"
npm install --prefix "$transport_native" --ignore-scripts --no-audit --no-fund
tar --warning=no-unknown-keyword -xzf "$transport_native/node_modules/react-native-libsodium/libsodium/build.tgz" \
  --directory "$transport_native/node_modules/react-native-libsodium/libsodium"
JAVA_HOME="$transport_jdk" "$transport_native/apps/mobile/android/gradlew" -p "$transport_native/apps/mobile/android" \
  :app:assembleDebug :app:assembleRelease -PreactNativeArchitectures=x86_64 \
  -Dorg.gradle.vfs.watch=false --no-daemon --max-workers=2
```

O preparador copia fontes reais, adiciona o broker somente no harness e libera HTTP apenas para `127.0.0.1` no APK sintético. Iniciar AVD read-only, sem snapshots, na porta 5580. Com boot concluído, executar debug e depois release:

Ao reutilizar um diretório de harness após alterar os pacotes compartilhados, forçar `:app:createBundleDebugJsAndAssets :app:createBundleReleaseJsAndAssets --rerun-tasks` antes de `assembleDebug/assembleRelease`: o cache incremental do Gradle pode não detectar mudanças nos arquivos `dist` fora da pasta do app.

```bash
"$transport_sdk/platform-tools/adb" -s emulator-5580 install -r \
  "$transport_native/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
env -u ELECTRON_RUN_AS_NODE ANDROID_ADB="$transport_sdk/platform-tools/adb" ANDROID_SERIAL=emulator-5580 \
  node_modules/electron/dist/electron .vite/sync-dev/transport.cjs /tmp/lion-sync-transport-debug-results.json
"$transport_sdk/platform-tools/adb" -s emulator-5580 install -r \
  "$transport_native/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
env -u ELECTRON_RUN_AS_NODE ANDROID_ADB="$transport_sdk/platform-tools/adb" ANDROID_SERIAL=emulator-5580 \
  LIONPOCKET_SYNC_CRASH_POSTGRES=synthetic-only \
  node_modules/electron/dist/electron .vite/sync-dev/transport.cjs /tmp/lion-sync-transport-release-results.json
```

O runner limpa **somente** o pacote descartável, cria banco PostgreSQL aleatório e banco Electron em `/tmp`, pareia, troca commits e remove seu banco remoto ao terminar. A flag de crash PostgreSQL encerra abruptamente **o serviço postgres deste Compose sintético** e o reinicia; não executar durante outro teste que use esses serviços. Sem essa flag, reabre a API/pool mantendo PostgreSQL em execução. O crash Electron ocorre num processo filho após persistir a outbox; o Android é encerrado com `am force-stop`. Encerrar somente a AVD iniciada para o ensaio ao terminar.

## Evidências e limites

Resultados e hashes dos artefatos finais: [`fixtures/local-first/stage1-transport-results.json`](fixtures/local-first/stage1-transport-results.json). A revisão de código e as suítes cobrem retry idêntico/perda de resposta, recibo incorreto, rollback SQLite/PostgreSQL, horizonte fixo, binding incorreto, pais ausentes, versões desconhecidas, crash/reabertura, zero/NULL, concorrência, heads obsoletos, delete/edit, recuperação como novo objeto, backup/staging, isolamento e revogação.

| Verificação final | Resultado |
| --- | --- |
| `LIONPOCKET_SYNC_INTEGRATION=1 npm test` | **307 aprovados**, zero skipped; inclui 51 testes do servidor, com 22 cenários de serviços reais |
| `npm test`, sem opt-in de serviços | 285 aprovados; 22 testes de serviços explicitamente skipped |
| Suíte desktop no Node do binário Electron | 74 aprovados |
| Android ↔ Electron debug | 20 cenários aprovados, incluindo payload Unicode acima de 64 KiB |
| Android ↔ Electron release | 21 cenários aprovados; inclui SIGKILL do PostgreSQL e recuperação do WAL |
| `npm run typecheck` e build dos APKs debug/release | Aprovados |
| `npm run lint` | Zero erros; 16 avisos de non-null assertions, registrados como limitação de lint |
| Capability no entry point real | Sem opt-in manual: `[]`, endpoint 404; com opt-in: somente `manualTransaction`, requisição sem autenticação 401 |
| `git diff --check` | Aprovado |

A revisão independente de código encontrou dois problemas corrigidos com regressões que falharam antes da correção: uso indevido da quota de controle de 64 KiB para pending/plaintext financeiro (incluindo Unicode e commit seguinte), e rejeição de resolução obsoleta em duas transações (trigger SQLite após inserir `sync_rejected`, comprovando rollback conjunto e retry). A revisão não substitui auditoria criptográfica nem validação de publicação.

Ambiente: Electron main 43.4.0/Node 24.18.1/libsodium 1.0.22, cofre `gnome_libsecret`; Android API 36/x86_64, Hermes/JSI, Nitro SQLite e libsodium 1.0.21, Keystore software. O buildType release usa a chave debug pública do template e não é distribuição do produto. Nenhuma base pessoal foi aberta.

O piloto não autoriza dados reais/publicação. Permanecem pendentes arm64 físico, Windows/cofres reais, upgrade distribuível, storage cheio, automação das telas/Custom Tab, rotação após revogação, recovery completo, restore/epoch com checkpoint externo, onboarding de bases preenchidas, outras entidades e revisão criptográfica independente. Revogação bloqueia chamadas, mas não apaga a DEK já conhecida. Quarentena exige corrigir a causa/repetir sync; não há descarte automático nem retenção finita.
