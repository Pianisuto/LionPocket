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
- SQLite desktop tem marcadores até 14, proteção pré-migration/WAL, integridade e FKs na transação, e rejeição de marcador futuro. A abertura habilita WAL antes dessa rejeição: será endurecida para recusar antes de modificar o journal.
- Cofre Linux recusa `basic_text`; Windows usa safeStorage/DPAPI. Perfil beta tenta fsync de diretório também no Windows, diferentemente do secretStore; será corrigido.

### Pipeline

O workflow de entrada cria e **publica** GitHub Release após tag/commit Release, com APK debug-signed. Não será usado para este PR. Será substituído por verificações/candidatos sem permissão de publicação e sem upload de binários públicos.

## Decisão de assinatura ainda pendente

Não gerar/adotar chave permanente neste PR. Antes da distribuição pública, escolher externamente custódia, backup/recuperação e certificado definitivo. O certificado de desenvolvimento já público não é opção segura de produção.

Opções seguras: novo package ID permanente com export/restore suportado e validado antes de retirar instalação antiga; ou planejar/testar uma linhagem de rotação suportada pelos Android alvo e canal de distribuição. Rotação/Play App Signing não serão presumidos como solução universal, nem como migração já implementada. Manter as instalações antigas disponíveis até verificar a migração financeira. Nunca desinstalar para fazer um teste de atualização passar.

Referências: [assinatura e atualização Android](https://developer.android.com/studio/publish/app-signing), [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [autoUpdater/Squirrel](https://www.electronjs.org/docs/latest/api/auto-updater).

## Canais e identidade preparados neste PR

| Canal | Android | Desktop | Sync / atualização |
| --- | --- | --- | --- |
| Desenvolvimento | debug do pacote normal; release de ensaio exige `-PdevelopmentSigning=true` | Forge dev / candidatos normal sem assinatura Windows definitiva | local por padrão; piloto sintético só com opt-in e perfil separado |
| Beta privada | `-PprivateBeta=true`, `.beta`, certificado de desenvolvimento | `LIONPOCKET_BUILD_CHANNEL=private-beta`, LionPocket Beta, `lionpocket-beta`, Squirrel `lionpocket_beta` | beta opt-in; sem feed público de auto-update |
| Futura normal release | `com.lionpocketmobile`, assinatura externa obrigatória; identidade permanente ainda pendente | LionPocket / `lionpocket`, Squirrel normal existente | local sem conta; sync beta bloqueado; Windows Squirrel conserva feed existente |

Versão do candidato: **0.3.10**, Android **versionCode 3**, centralizada em `tools/release/version.json`; desktop/lockfile devem coincidir. O package ID normal é conservado como base técnica, sem resolver por conta própria a escolha de produção. Normal e beta conservam SQLite privado separado. DEBs agora também têm nomes, launchers, diretórios `/opt` e IDs distintos; o preinst da beta não remove a instalação normal.

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

Cliente atual valida versões/capabilities conhecidas antes de login/provas/POST/preparação de envelope. Versão diferente de 1 ou capability desconhecida exige atualização, conserva todas as tabelas/pendências e não envia conteúdo. Mudança de serverEpoch interrompe o transporte e exige revisão; não adapta finanças entre epochs. Schema futuro mobile já era recusado; desktop passa a recusar antes de habilitar WAL. Testes comparam manifests completos, inclusive filas e binding. Vectores e integração do protocolo anterior continuam aplicáveis; os novos campos de discovery são aditivos para o cliente anterior.

## Pendências antes de beta pública

Identidade permanente Android/custódia e migração das instalações debug; assinatura Authenticode/certificado Windows e confiança do feed de atualização; auditoria criptográfica independente; storage cheio/interrupções; operação pública, cadastro, retenção/GC/purge e demais gates do planejamento. Sync Android em background continua fora do recorte. SHA-256 verifica conteúdo e não substitui certificado de autoria. Build reproduzível aqui significa receita/versões/verificações reproduzíveis, não promessa de ZIP/APK byte-idêntico (timestamps, assinatura e ferramentas influem).

A matriz final de execução e seus limites serão registrados nas evidências deste PR; nenhuma alegação de execução Windows será feita antes do resultado do workflow nativo.
