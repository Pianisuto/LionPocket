# Release readiness — Etapa 4, preparação sem publicação

Base auditada antes de modificar código: `8de0087cdbcdcc670ec2073ba3f4ea51932072b4` (main após PR #6), em 01/10/2026. Este recorte não habilita serviço público nem publica releases. As evidências dos PRs anteriores permanecem históricas. Nenhuma decisão do vault `Visão e Decisões.md` é alterada.

## Auditoria de entrada

### Android

- `applicationId` normal: `com.lionpocketmobile`; beta: `com.lionpocketmobile.beta`, selecionada por `-PprivateBeta=true`. Namespace Kotlin comum `com.lionpocketmobile`, nomes LionPocket / LionPocket Beta, redirects distintos. Sem flavors; flag nativa `PRIVATE_BETA` controla a UI/controller. Cada pacote tem seu próprio armazenamento privado, SQLite e Keystore.
- Gradle na base: `versionCode=2`, `versionName=0.3.9`. O package.json mobile `0.1.0` é versão do workspace, não versão distribuída.
- Debug **e release** usam `app/debug.keystore` versionado, senha pública do template, alias `androiddebugkey`. Certificado SHA-256: `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`. Não é identidade de produção.
- Auditoria somente de metadados/APKs do Galaxy S23 conectado: normal `1 / 1.0`, beta `2 / 0.3.9`; ambos têm exatamente o certificado de desenvolvimento acima (`apksigner verify --print-certs`). Nenhum banco pessoal foi lido ou extraído; nenhum desses pacotes foi atualizado, limpo ou removido.
- `adb install -r` é viável com mesmo package ID/certificado e versionCode aceitável. Trocar simplesmente para outra chave falha com assinatura incompatível; o teste de schema com chave atual não resolve a identidade permanente.
- SQLite `lionpocket.sqlite` privado, `connection.ts` → `migrate()`. Mobile tem migrations 1–8 por `PRAGMA user_version`, cópia `VACUUM INTO` antes de atualizar base existente, transação por versão e `foreign_key_check`. Versão futura já é recusada. Backups passam por staging/validação; restore preserva sidecars e desabilita transporte.
- Beta usa o mesmo schema/repositórios, mas pacote, nome e callback diferentes; normal não inicializa o controller beta. Endpoint privado é default no módulo beta compartilhado, sem adesão automática no app normal.

### Desktop

- Versão distribuída `apps/desktop/package.json=0.3.9`. Electron Forge gera ZIP Linux x64 e Windows x64, Squirrel Windows (`lionpocket`, `LionPocket-Instalador.exe`, nupkg + RELEASES). Script adicional gera DEB Linux em `/opt/LionPocket`; banco em userData, fora dos artefatos.
- Normal usa userData do app; `--private-beta` muda para `appData/LionPocket Beta` antes do single-instance lock/abertura SQLite. Até esta base a beta é um launcher sobre o mesmo binário, sem instalador Windows separado.
- Windows instalado via Squirrel busca `update.electronjs.org/Pianisuto/LionPocket/win32-<arch>/<versão>` após 15 s e a cada hora. Primeiro boot Squirrel, ZIP portátil e beta não ativam auto-update. Aplicação é explícita pela UI. Linux não tem auto-update embutido.
- SQLite desktop tem marcadores até 14, proteção pré-migration, integridade e FKs na transação, e rejeição de marcador futuro. A abertura habilita WAL antes dessa rejeição: será endurecida para recusar antes de modificar o journal.
- Cofre Linux recusa `basic_text`; Windows usa safeStorage/DPAPI. Perfil beta tenta fsync de diretório também no Windows, diferentemente do secretStore; será corrigido.

### Pipeline

O workflow de entrada cria e **publica** GitHub Release após tag/commit Release, com APK debug-signed. Não será usado para este PR. Será substituído por verificações/candidatos sem permissão de publicação e sem upload de binários públicos.

## Decisão de assinatura ainda pendente

Não gerar/adotar chave permanente neste PR. Antes da distribuição pública, escolher externamente custódia, backup/recuperação e certificado definitivo. O certificado de desenvolvimento já público não é opção segura de produção.

Opções seguras: novo package ID permanente com export/restore suportado e validado antes de retirar instalação antiga; ou planejar/testar uma linhagem de rotação suportada pelos Android alvo e canal de distribuição. A chave debug é pública: rotação não deve ser tratada como reparo da confiança anterior e requer avaliação própria. Rotação/Play App Signing não serão presumidos como solução universal, nem como migração já implementada. Manter as instalações antigas disponíveis até verificar a migração financeira. Nunca desinstalar para fazer um teste de atualização passar.

Referências: [assinatura e atualização Android](https://developer.android.com/studio/publish/app-signing), [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [autoUpdater/Squirrel](https://www.electronjs.org/docs/latest/api/auto-updater).

## Canais e identidade preparados neste PR

| Canal | Android | Desktop | Sync / atualização |
| --- | --- | --- | --- |
| Desenvolvimento | debug do pacote normal; release de ensaio exige `-PdevelopmentSigning=true` | Forge dev / candidatos normal sem assinatura Windows definitiva | local por padrão; piloto sintético só com opt-in e perfil separado |
| Beta privada | `-PprivateBeta=true`, `.beta`, certificado de desenvolvimento | `LIONPOCKET_BUILD_CHANNEL=private-beta`, LionPocket Beta, `lionpocket-beta`, Squirrel `lionpocket_beta` | beta opt-in; sem feed público de auto-update |
| Futura normal release | `com.lionpocketmobile`, assinatura externa obrigatória; identidade permanente ainda pendente | LionPocket / `lionpocket`, Squirrel normal existente | local sem conta; sync beta bloqueado; Windows Squirrel conserva feed existente |

Versão do candidato: **0.3.10**, Android **versionCode 3**, centralizada em `tools/release/version.json`; desktop/lockfile devem coincidir. O package ID normal é conservado como base técnica, sem resolver por conta própria a escolha de produção. Normal e beta conservam SQLite privado separado. DEBs agora também têm nomes, launchers, diretórios `/opt` e IDs distintos; o preinst da beta não remove a instalação normal. A pasta do binário/DEB beta é `LionPocket-Beta` (`/opt/LionPocket-Beta`), sem espaço: o teste SUID do Chromium no Ubuntu detectou que espaços quebravam o lançamento do zygote. O nome exibido e perfil permanecem `LionPocket Beta`. O CI configura o helper root/4755 em seu runner descartável; não desabilita o sandbox. Em Linux que restringe user namespaces, preferir DEB com helper corretamente instalado.

Normal não incorpora endpoint operacional default da beta: Android o recebe de BuildConfig somente na beta; Electron o incorpora somente na build beta. O launcher legado `--private-beta` continua selecionando perfil separado em binário normal, mas exige configurar endpoint explicitamente se não houver perfil salvo. Nenhum realm/conta/token é persistido no artefato. Opt-ins do piloto de desenvolvimento não se tornam adesão silenciosa. Schemas com sidecars continuam disponíveis localmente mesmo com transporte desabilitado.

## Assinatura externa Android

`assembleRelease`/`bundleRelease` normais exigem a assinatura. Sem configuração, falham com `Production signing required` antes de empacotar; debug não exige segredo. Beta e release de desenvolvimento não consultam credenciais de produção. Não combinar `privateBeta` com `developmentSigning`.

A pessoa responsável escolhe e guarda externamente a chave; este PR não gera chave permanente. Configurar `LIONPOCKET_ANDROID_SIGNING_FILE` como caminho absoluto de arquivo privado fora do checkout, por exemplo:

```properties
storeFile=/caminho/externo/lionpocket-production.p12
storePassword=<fornecida pelo responsável>
keyAlias=<alias escolhido>
keyPassword=<fornecida pelo responsável>
certificateSha256=<SHA-256 público do certificado definitivo>
```

Alternativa: variáveis externas `LIONPOCKET_ANDROID_STORE_FILE`, `LIONPOCKET_ANDROID_STORE_PASSWORD`, `LIONPOCKET_ANDROID_KEY_ALIAS`, `LIONPOCKET_ANDROID_KEY_PASSWORD`, `LIONPOCKET_ANDROID_CERTIFICATE_SHA256`. Arquivo tem precedência por campo. Não passar senhas em `-P`/linha de comando nem ativar dumps de ambiente/debug de Gradle em release. Usar permissões restritas, secret manager/CI protegido e backup da chave fora do Git. Keystore dentro do checkout, certificado debug conhecido, DN Android Debug ou fingerprint divergente são recusados. `.gitignore` bloqueia material de assinatura; o único keystore versionado continua a fixture pública debug histórica.

O teste `android-signing-fixture.cjs` gera chave **efêmera de teste**, fora do checkout, com validade de dois dias, e a apaga ao terminar. Verifica configuração externa, pin inválido e opcionalmente empacotamento. O APK resultante nunca entra em distribuição pública. Isso testa o mecanismo; **não escolhe identidade de produção**.

## Builds e pipeline reproduzíveis

Node 24, JDK **21 completo (com javac)**, SDK platform android-37.0/build-tools 37.0.0, NDK 27.1.12297006. Dependências do lockfile via `npm ci` e Gradle wrapper do repo.

```sh
npm ci
npm run release:validate
npm test
npm run typecheck
npm run lint
npm run sync:dev:up
npm run sync:dev:test
npm run make:linux
# Em Windows nativo:
npm run make -- --platform=win32 --arch=x64
# Beta desktop (PowerShell: $env:LIONPOCKET_BUILD_CHANNEL='private-beta'):
LIONPOCKET_BUILD_CHANNEL=private-beta npm run make:linux
npm run mobile:build:android
# Release de desenvolvimento descartável:
apps/mobile/android/gradlew -p apps/mobile/android assembleRelease -PdevelopmentSigning=true
# Beta privada:
apps/mobile/android/gradlew -p apps/mobile/android assembleRelease -PprivateBeta=true
# Futura produção: configurar assinatura externamente antes de executar:
npm run mobile:build:android:release
# Metadados/tag devem coincidir:
node tools/release/validate.cjs v0.3.10
# Em diretório limpo contendo somente candidatos desta versão:
node tools/release/checksums.cjs /caminho/candidatos .apk
```

`.github/workflows/release.yml` verifica PR/main/tag ou dispatch: suíte, typecheck, lint, PostgreSQL/Keycloak, Linux/Windows em ambos os canais, Android debug e releases de teste, assinatura ausente/externa, APK replacement em emulador descartável. Tag ou tag solicitada divergente falha. Gera SHA256SUMS e manifest de fonte/versão/canal. Não tem permissão contents:write, etapa publish, upload-artifact nem criação de GitHub Release. Binários ficam no runner e são descartados. Publicação futura será uma decisão externa; este pipeline não transforma merge/tag em autorização.

O smoke do binário desktop seleciona **exclusivamente** diretório aleatório `lion-release-smoke-*` sob tmp; compara cada registro legado, verifica integridade/FKs, abre renderer e usa o cofre real (DPAPI Windows ou recusa basic_text Linux). Testes unitários do cofre são identificados como mocks, sem substituir o smoke real. O teste Windows da beta também exercita persistência do perfil, agora sem fsync de diretório incompatível.

## Compatibilidade e preservação

Protocolo wire **1** e domainSchema **1** permanecem. Servidor anuncia campos adicionais `protocolVersion=1`, `domainSchema=1` no discovery; servidor anterior sem esses campos mantém o baseline controlVersion 1. Não muda envelope, E2EE, pais, conflicts, outbox/inbox, pareamento, recovery ou debounce.

Cliente atual valida versões/capabilities conhecidas antes de login/provas/POST/preparação de envelope. Versão diferente de 1 ou capability desconhecida exige atualização, conserva todas as tabelas/pendências e não envia conteúdo. Mudança de serverEpoch interrompe o transporte e exige revisão; não adapta finanças entre epochs. Schema futuro mobile já era recusado; desktop passa a recusar antes de habilitar WAL. Testes comparam manifests completos, inclusive filas e binding. Vetores e integração do protocolo anterior continuam aplicáveis; o runner `version-skew.cjs` recompila motor/controller completos do commit-base e executa pareamento e troca bidirecional contra PostgreSQL/Keycloak atuais, com protocolo/dependências compartilhados inalterados; os novos campos de discovery são aditivos para o cliente anterior.

## Pendências antes de beta pública

Identidade permanente Android/custódia e migração das instalações debug; assinatura Authenticode/certificado Windows e confiança do feed de atualização; auditoria criptográfica independente; storage cheio/interrupções; operação pública, cadastro, retenção/GC/purge e demais gates do planejamento. Sync Android em background continua fora do recorte. SHA-256 verifica conteúdo e não substitui certificado de autoria. Build reproduzível aqui significa receita/versões/verificações reproduzíveis, não promessa de ZIP/APK byte-idêntico (timestamps, assinatura e ferramentas influem).

## Matriz executada e evidências deste PR

Resultados estruturados em [release-readiness-results.json](fixtures/local-first/release-readiness-results.json), com SHA da fonte, matriz de comparação, certificados públicos e checksums dos candidatos locais. Os binários não foram publicados. A evidência de código usa `8e79e39fb8862c72d5020e74c40f0306a9c31bfa`; commits posteriores desta entrega apenas fecham a documentação.

| Plataforma/canal | Build/instalação | Abertura e preservação | Resultado |
| --- | --- | --- | --- |
| Android normal | debug e release explícita de desenvolvimento, x86_64 + arm64-v8a | `adb install -r` em AVD novo, SQLite v1/v4/v5/v8 → v8 | aprovado local e CI |
| Android beta | release `.beta`, x86_64 + arm64-v8a | beta anterior → nova, v8; perfil normal separado | aprovado local e CI |
| Android assinatura externa | APK x86_64 com chave efêmera externa | configuração/pin; assinatura ausente, pin incorreto e certificado debug recusados | aprovado; identidade definitiva pendente |
| Linux normal/beta | ZIP + DEB x64 | binário real, renderer, fixture v10 → v14, perfil público persistido | aprovado local e CI; `basic_text` recusado |
| Windows normal/beta | ZIP + Squirrel EXE/nupkg/RELEASES x64 em runner Windows | portátil e instalado de verdade, renderer, fixture v10 → v14, DPAPI e persistência de perfil | aprovado CI nativo |

O [workflow nativo](https://github.com/Pianisuto/LionPocket/actions/runs/36882728579) passou **todos os seis jobs**: validação, quatro combinações desktop e Android. O [job Android](https://github.com/Pianisuto/LionPocket/actions/runs/36882728579/job/110439555224) recompilou os APKs normal/beta do commit-base e repetiu a matriz de cinco substituições, recusa de assinatura e schema futuro em AVD novo, sem limpar storage. Os jobs [Windows normal](https://github.com/Pianisuto/LionPocket/actions/runs/36882728579/job/110439555175) e [Windows beta](https://github.com/Pianisuto/LionPocket/actions/runs/36882728579/job/110439555226) instalaram Squirrel em hosts descartáveis: identidades `lionpocket` e `lionpocket_beta`, nove tabelas financeiras legadas preservadas, `integrity_check=ok`, nenhum erro de FK, janela carregada e roundtrip real DPAPI. Normal instalado conserva o feed existente; portátil/beta retornam feed nulo. O smoke não baixa nem aplica atualização do feed público. Assinatura Authenticode e atualização completa entre duas versões públicas continuam pendentes.

### SQLite/atualizações Android

O AVD local exclusivo `LionPocket_ReleaseReadiness` não continha pacotes LionPocket. Foram instalados os APKs anteriores auditados (normal `1/1.0`, beta `2/0.3.9`), com bancos **inteiramente sintéticos**, e substituídos pelo candidato `3/0.3.10`. Nenhum banco do telefone foi acessado. Cada troca executa `adb install -r`, sem desinstalar, limpar storage ou permitir downgrade. Após o primeiro caso normal, fixtures v4/v5/v8 são preparadas offline na instalação descartável existente antes de novas substituições; isso separa cobertura de schema da cobertura da versão do APK.

| Origem | Destino | Tabelas/registros legados comparados | Integridade/FKs |
| --- | --- | --- | --- |
| Normal sem sync, mobile v1 | normal v8 | 1 / 2 | ok / 0 |
| Normal v4 | normal v8 | 10 / 13 | ok / 0 |
| Normal v5 anterior ao sync | normal v8 | 11 / 14 | ok / 0 |
| Normal v8 com sidecars | normal v8 | 30 / 47 | ok / 0 |
| Beta anterior v8 | beta nova v8 | 30 / 47 | ok / 0 |

A comparação usa **cada registro e cada coluna existente**: IDs, centavos, zero/null, datas, tombstones, prioridades, preferências, metadados, sidecars, três itens de outbox (incluindo envelope preparado imutável), inbox e binding. Fixtures recorrentes v4/v5 têm `active=0` para não gerar materializações dependentes da data; fixtures históricas do repo não foram alteradas. APKs finais recompilados foram novamente substituídos sobre as instalações sintéticas v8 normal/beta e preservaram todas as 30 tabelas. Uma chave efêmera diferente causou `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; o teste manteve o banco e não desinstalou. Injetar `user_version=99` e abrir o app real preservou a versão e todos os registros. O ensaio nativo foi x86_64; arm64 foi compilado, sem atualizar instalações pessoais. Hashes dos dois APKs físicos permaneceram iguais aos da auditoria.

### Suíte e version skew

Suíte completa com PostgreSQL/Keycloak: **376 testes aprovados**, um cenário do cliente anterior reservado ao runner específico. Esse runner executou **três testes aprovados**, incluindo o cenário adicional de pareamento/troca bidirecional com motor/controller da base e servidor atual. Os **110 testes desktop** passaram também no Node do Electron. Typecheck, lint (warnings existentes, sem erros), validação de versões/checksums e `git diff --check` passaram.

Casos cobertos: discovery atual e legado sem campos aditivos; cliente anterior compatível; protocolo/domainSchema/controlVersion futuros; capability desconhecida; mudança de serverEpoch; schema futuro mobile e desktop. Incompatibilidade interrompe antes de enviar envelopes e conserva banco/outbox/binding. Desktop futuro também conserva journal DELETE, sem habilitar WAL. Nenhuma decisão do vault foi alterada; o recorte não implementa serviço público nem novas funcionalidades financeiras.
