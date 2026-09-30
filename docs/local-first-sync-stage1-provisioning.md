# Etapa 1 — provisioning, trust e pareamento sintético

30/09/2026. Continuação da [fundação local](local-first-sync-stage1-local-foundation.md) e do [readiness](local-first-sync-stage1-readiness.md). Este documento registra o recorte de provisioning, quando envio de lançamentos estava desativado. A continuação em [transporte manual](local-first-sync-stage1-transport.md) implementa commits, changes e conflitos, habilitáveis apenas no opt-in de desenvolvimento sintético. Sem esse opt-in, `financialSyncEnabled=false`, `entityScopes=[]` e os endpoints financeiros continuam indisponíveis. Nenhum binding automático do SQLite pessoal.

## Implementação

- `apps/sync-server`: API HTTP em loopback, PostgreSQL, autorização por `(issuer, subject)` e JWT RS256 do Keycloak com issuer, audience `lionpocket-sync-api`, expiração, subject, tipo Bearer e client autorizado. Conta autenticada permite bootstrap/membership; não substitui as assinaturas E2EE. Um único proprietário por vault.
- Realm dedicado `lionpocket-dev`, dois clients públicos, Authorization Code/PKCE S256 obrigatório, implicit/direct grants desligados, redirects explícitos sem wildcard. Desktop usa browser do sistema e callback em loopback; state, code e issuer do callback são conferidos; ID token e access token têm assinatura/claims validados, incluindo nonce e subject comum. Android usa `react-native-app-auth@8.4.1`, AppAuth Android 0.11.1/Custom Tabs, state/PKCE/nonce e verificação adicional RS256/issuer/audience/azp/nonce/subject em `java.security`. Login Android só é acessível no harness sintético. Tokens e verifier ficam em memória; nenhuma sessão persistida ou refresh automático.
- Fundador gera seeds independentes de autoridade Ed25519, escrita Ed25519, X25519 e DEK de 32 bytes por CSPRNG. Cofres existentes: `DesktopSecretStore` e `AndroidSecretStore`. O perfil de desenvolvimento persiste somente IDs, pubkeys, pin, grants, checkpoint e identidade OIDC. Metadata é escrita com arquivo exclusivo, fsync, rename e fsync de diretório. Nenhuma seed, DEK ou token entra em JSON/SQLite/export/renderer/AsyncStorage. Falha do cofre interrompe provisioning/assinatura/recepção; sem regeneração silenciosa ou fallback em claro.
- Primeiro grant é versão `"1"`, predecessor NULL, dispositivo fundador aprovado. Cada append vincula SHA-256 do grant completo anterior, inclusive assinatura. Validadores conferem cadeia completa, escopo, autoridade pinada, ordenação decimal int64, predecessor, assinatura, transições, chaves únicas e limite de dez aparelhos ativos. O checkpoint local detecta rollback/fork conhecido. Grants ficam retidos; fundador é a única autoridade administrativa neste piloto. Revogação do próprio fundador e rotação ainda não são oferecidas.
- Pareamento usa request assinado pela chave de escrita do candidato, contendo server/epoch/vault, ID, ambas as pubkeys e nonce CSPRNG de 32 bytes. Fingerprint SHA-256 autentica os campos canônicos. **A confirmação implementada é comparação de fingerprint**: primeiro confirmar o fingerprint da invitation/pin da autoridade por canal confiável; depois confirmar o fingerprint exibido pelo novo dispositivo antes de o fundador assinar. QR não é necessário para este caminho e não há scanner/gerador QR nesta implementação. O servidor não pode escolher uma autoridade substituta.
- Entrega usa sealed box X25519/libsodium e assinatura externa de dispositivo ativo. Bundle cifrado repete scope, destinatário, registryVersion, keyVersion e DEK; não contém autoridade ou chave privada de aparelho. Receptor valida trust histórico e atual, assinatura, chaves, destinatário e bundle antes de envolver a DEK no cofre. DEK existente diferente é recusada, nunca sobrescrita. keyVersion diferente de 1 é incompatível neste recorte.
- Decoder portável verifica limite de bytes, UTF-8 estrito/BOM, profundidade 32, contagem de nós, nomes duplicados (inclusive aliases escapados) e bytes canônicos antes de materializar o objeto completo. Controle: 64 KiB/request; resposta/registro: no máximo 4 MiB. Decoder de commit preparatório: 1 MiB, cem operações, 32 pais/operação. Ele não habilita envio. UTF-8/SHA-256 são portáveis (`@noble/hashes@1.8.0`); operações com chaves continuam nos bindings sodium pinados. O Android nativo não exporta todos os helpers declarados pelo binding: o adapter usa encoder próprio e limpeza dos buffers JS por `fill(0)`.
- Prova HTTP detached Ed25519 é independente do grant/entrega durável e inclui método, caminho exato sem query, origin da API, server/epoch/vault/device, SHA-256 dos bytes do corpo e do token, issuedAt em milissegundos e nonce CSPRNG de 32 bytes. Janela de 60 segundos. Nonces têm unicidade durável `(serverEpoch, deviceId, nonce)`, inclusive após restart. A transação mantém o lock do vault; savepoint conserva o nonce de uma prova autenticada mesmo se a mutação de controle for recusada. Provas inválidas não são consumidas. Limite de dez pedidos pendentes; sem GC de grants/nonces neste piloto.

O append usa `SELECT ... FOR UPDATE`, valida o próximo grant dentro da transação e grava cadeia/versão/status do pedido conjuntamente. Duas aprovações sobre o mesmo predecessor não podem ganhar. Pedido idêntico pode ser retomado com uma **nova prova HTTP**; alteração do pedido usa outro dispositivo, sem substituir o cadastro. Entrega já armazenada é imutável. Se a resposta de bootstrap se perder, `create` retoma as mesmas seeds/perfil e verifica o registry existente; se aprovação se concluir e entrega falhar, usar `deliver`. Isso não implementa idempotência de commits financeiros.

## Subir o ambiente

Pré-requisitos: Node 24, Docker/Compose e, para o cliente Electron, sessão gráfica com cofre do SO aberto (`gnome_libsecret`/KWallet suportado no Linux). As credenciais abaixo são **fixtures públicas**, exclusivamente desse ambiente sintético.

```bash
npm ci
npm run sync:dev:up
LIONPOCKET_SYNC_DEV=synthetic-only npm run sync:dev:server
```

Em outro terminal:

```bash
npm run sync:dev:client:build
npm run sync:dev:test
```

Serviços: API `http://127.0.0.1:8787`; Keycloak `http://127.0.0.1:18080`; PostgreSQL `127.0.0.1:55432`. Imagens e digests em [`tools/sync-dev/compose.yml`](../tools/sync-dev/compose.yml): Keycloak 26.7.4 e PostgreSQL 17.6 Alpine. PostgreSQL tem bancos separados `lion_sync` e `keycloak_dev`. API só inicia com opt-in `synthetic-only`. `SYNC_DATABASE_URL` permite outra instância sintética explicitamente configurada.

Realm importa no primeiro boot. Conta proprietária: `alice` / `synthetic-only-alice`. Conta para isolamento: `mallory` / `synthetic-only-mallory`. Admin local: `admin-dev` / `admin-dev-only`. Banco local: `liondev` / `liondev`. Não usar credenciais/contas pessoais. A suite integrada cria um banco `lion_sync_test_<UUID>` próprio e o remove ao terminar; não limpa bases financeiras nem o banco de controle principal.

`npm run sync:dev:down` encerra somente o projeto Compose, conservando seu volume. Mudança posterior no realm requer atualizar/recriar apenas este ambiente sintético: o import de startup não sobrescreve um realm existente. Restore operacional com epoch novo, atualização automática do realm e deployment são trabalho posterior.

## Parear dois dispositivos de desenvolvimento

O runner usa Electron main e recusa perfis fora de `/tmp/lion-sync-dev-NAME`. Cada diretório é uma instalação/dispositivo separado. Estes comandos nunca abrem `lionpocket.sqlite`. Login abre o browser do sistema; entrar como **alice nas duas sessões**. O segundo perfil usa o client público Android com callback loopback de teste; **continua sendo Electron**, sem claim de runtime Android nessa receita.

1. Criar o vault no fundador A:

```bash
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron \
  .vite/sync-dev/client.cjs create --profile /tmp/lion-sync-dev-a
```

Guardar o caminho de `invitation.json` e o **Trust fingerprint** exibido. Conferir o fingerprint no canal confiável com B; a invitation transporta a autoridade pinada, server/epoch/vault e ID do fundador.

2. B registra o pedido. Substituir `TRUST_FINGERPRINT` pelo valor integral conferido com A:

```bash
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron \
  .vite/sync-dev/client.cjs pair --profile /tmp/lion-sync-dev-b \
  --client lionpocket-android-dev \
  --invitation /tmp/lion-sync-dev-a/invitation.json \
  --fingerprint TRUST_FINGERPRINT
```

B exibe o **Pairing fingerprint** e grava somente o pedido público em `pairing-request.json`. Ainda não tem DEK nem autorização de registry.

3. A compara o Pairing fingerprint com o que B exibiu, e aprova. Substituir `PAIRING_FINGERPRINT` pelo valor conferido:

```bash
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron \
  .vite/sync-dev/client.cjs approve --profile /tmp/lion-sync-dev-a \
  --request /tmp/lion-sync-dev-b/pairing-request.json \
  --fingerprint PAIRING_FINGERPRINT
```

O fundador assina o próximo grant e entrega a DEK cifrada. Se a entrega falhar depois de o grant ser aceito, repetir somente `deliver --profile /tmp/lion-sync-dev-a --request /tmp/lion-sync-dev-b/pairing-request.json`.

4. B recebe, verifica a cadeia, abre o bundle e grava a DEK exclusivamente no cofre:

```bash
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron \
  .vite/sync-dev/client.cjs receive --profile /tmp/lion-sync-dev-b \
  --client lionpocket-android-dev
```

`registry --profile ...` verifica novamente o registro. `revoke` no fundador usa os mesmos argumentos de `approve`, acrescenta o grant de revogação e bloqueia imediatamente as chamadas de B. Após revogar, parear novamente exige nova identidade/dispositivo. Não há rotation/recovery completo neste recorte; revogar não apaga conhecimento da DEK já entregue.

Nenhum comando altera a outbox financeira, anuncia escopos de domínio ou permite envio de lançamentos. Usar novo diretório sintético se quiser outro vault. Não copiar wrappers nem perfis para a instalação pessoal.

## Android isolado e reprodução nativa

A receita da [fundação](local-first-sync-stage1-local-foundation.md#reprodução) continua aplicável: preparador agora copia também AppAuth, módulo RS256 e os cenários novos. JDK 21 completo, SDK/NDK, applicationId `com.lionpocketmobile.cryptospike`, JS embutido e AVD read-only. Os checks automáticos incluem dez verificações RS256 com JWTs públicos de fixture e dezesseis checks de provisioning/trust/cofre. Não abrem sessão OIDC real no Android.

Para o botão **Login OIDC sintético (Keycloak)** do harness, encaminhar a porta antes de abrir o login:

```bash
adb -s emulator-5580 reverse tcp:18080 tcp:18080
adb -s emulator-5580 reverse tcp:8787 tcp:8787
```

Entrar no Custom Tab como alice. Redirect explícito: `com.lionpocketmobile.syncdev:/callback`. O módulo nativo verifica ambas as assinaturas RS256 e as claims; nenhum token vai ao relatório. Este botão foi compilado em debug/release; a interação completa do Custom Tab **não faz parte da evidência automática desta execução**. O guia de pareamento acima e o smoke usam duas sessões reais com os clients públicos no Electron. Integração da UI de pareamento Android, aparelhos arm64 físicos, Windows e empacotamento/upgrade continuam gates de produto.

## Verificações

Evidência resumida e hashes: [`fixtures/local-first/stage1-provisioning-results.json`](fixtures/local-first/stage1-provisioning-results.json). Vetores novos: [`provisioning.json`](../packages/sync-protocol/fixtures/provisioning.json), produzidos por SHA-256/Ed25519 do Node/OpenSSL e conferidos pelos adapters; [`oidc-public.json`](../packages/sync-protocol/fixtures/oidc-public.json), chave RSA pública sintética que o Keycloak jamais aceita.

- `npm test`: 278 aprovados; catorze testes de integração/OIDC dependentes de serviços ficam explicitamente skipped sem opt-in.
- `npm run sync:dev:test`: 43 testes aprovados, incluindo catorze testes com Keycloak/PostgreSQL reais. Bootstrap, isolamento de subject, PKCE incorreto, state/issuer/code duplicado, nonce OIDC substituído, claims/sig inválidas, pareamento pendente, grant fora de ordem, assinatura de autoridade inválida, append concorrente, entrega, replay concorrente/restart, scope/epoch incompatível, decoder HTTP, revogação e ausência de endpoints/tabelas financeiras.
- Checks puros adicionais: cofre indisponível/seed ausente ou alterada; fingerprint e pubkey adulterados; substituição da autoridade; fork/rollback; revogação/reaprovação/chaves repetidas; autoridade não delegável; limite de dez ativos; DEK existente incompatível; sealed box/bundle/vault/keyVersion incompatíveis; UTF-8 inválido/duplicatas/limites; versões acima da precisão numérica JS.
- Smoke Electron main 43.4.0/Node 24.18.1: dezessete checks, duas sessões Keycloak reais por Authorization Code/PKCE, PostgreSQL real, cofre real `gnome_libsecret`, reabertura de wrappers e revogação. Login do smoke usa formulário HTTP sintético do IdP; não simula password grant nem automatiza a UI do browser do sistema.
- Android debug e release, Hermes/JSI, API 36/x86_64: dezesseis checks novos de provisioning e dez checks RS256 por build, além dos checks anteriores de crypto/migrations/cofre/sidecars. Keystore do emulador é software, sem claim de hardware. Relatórios nativos não demonstram pareamento Android↔API ou login Custom Tab ponta a ponta.
- `npm run lint`, `npm run typecheck`, `git diff --check`: aprovados.

Smoke reproduzível, com API/IdP já ativos e cofre aberto:

```bash
node tools/sync-dev/build-client.cjs --smoke
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron \
  .vite/sync-dev/smoke.cjs /tmp/lion-sync-dev-smoke-results.json
```

Os relatórios só conservam dados públicos/ciphertexts sintéticos. Nenhuma base pessoal foi aberta. Os testes de indisponibilidade do cofre são doubles/fault injection identificados; os round-trips Electron/Android usam os cofres reais. A execução automática não substitui revisão independente de trust/recovery/restore/epoch.

## Próximo PR no momento deste recorte

Implementar binding remoto explícito da linhagem sintética e preparação **imutável** da outbox: cifrar/assinar commits com a DEK e o deviceSeq correto, conservando os mesmos bytes em retries. Acrescentar envio idempotente, recibos completos com digest, commit atômico em PostgreSQL e contador/logPosition serializado por vault.

Depois: cursores scoped por server/epoch/vault/binding, paginação com horizonte fixo, inbox/outbox remota durável, retomada após crash/perda de resposta, pais faltantes, quarentena de versões desconhecidas, recepção/projeção sem eco e resolução explícita de conflitos por heads revistos. Validadores de backup/staging precisam acompanhar qualquer novo estado persistido antes de habilitá-lo. Ainda são necessários os critérios verticais de ramo concorrente, exclusão offline, zero/NULL e conflitos da proposta.

Rotação após revogação, lifecycle de recovery, rollback operacional/epoch com checkpoint externo, onboarding de base preenchida, UI de produto e gates de publicação permanecem fora deste recorte. Manter capabilities financeiras vazias até o próximo fluxo ser implementado e verificado.

O [fluxo vertical manual](local-first-sync-stage1-transport.md) agora implementa esse transporte, com aceite e evidências próprios. As verificações e as restrições descritas acima registram a versão de provisioning; a configuração padrão continua sem envio financeiro.

Referências de implementação: [endpoints OIDC oficiais do Keycloak](https://www.keycloak.org/securing-apps/oidc-layers), [containers Keycloak](https://www.keycloak.org/server/containers), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252), [AppAuth Android](https://github.com/openid/AppAuth-Android) e [react-native-app-auth](https://github.com/FormidableLabs/react-native-app-auth).
