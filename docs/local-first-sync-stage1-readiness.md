# Entrada técnica na Etapa 1

30/09/2026. Complemento da [Etapa 0](local-first-sync-stage0.md), após o commit `4fb76f2`. **Pronto para começar a implementação do piloto com bases sintéticas separadas.** Este complemento não implementa a Etapa 1: sync continua desativado, com zero capabilities, sem API, login, transporte ou migration de identidade nos apps.

## Bloqueios técnicos resolvidos

| Bloqueio | Decisão / evidência |
| --- | --- |
| Android↔Electron não comprovado | Mesmos arquivos fixos no Electron main 43.4.0/Node 24.18.1/libsodium 1.0.22 e Android API 36/x86_64/RN 0.87.1/Hermes/JSI/libsodium 1.0.21, debug **e** release. 104 checks por execução com troca de sealed boxes; 103 quando não há peer. [Relatórios e hashes](fixtures/local-first/native-results.json). |
| Binding Android sem ensaio na arquitetura atual | Selecionado para desenvolvimento `react-native-libsodium@1.7.0`, sem patches de vendor; integridade npm registrada na evidência. A execução exige Hermes e função JSI nativa, recusando fallback WASM. Não adicionado ao app financeiro. Desktop: `libsodium-wrappers-sumo@0.8.4` no main. |
| Ambiente Android sem compilador | JRE 21 instalado não tem `javac`. Builds feitos com JDK 21 completo do Adoptium em diretório temporário, checksum verificado. Usar `JAVA_HOME` apontando para **JDK**, também nos próximos builds; recipe no [spike](local-first-sync-crypto-spike.md). Nenhuma configuração global da máquina foi alterada. |
| Bytes de registry, entrega e recovery abertos | Helpers puros e fixture `control.json`: aprovação/revogação assinadas por autoridade distinta, hash do predecessor completo, assinatura externa da sealed box e recovery cifrado com parâmetros fixos. OpenSSL verifica autoria errada e alteração de cada campo; C/JS/JSI reproduzem bytes. Helpers não validam trust nem são decoders de rede. |
| Driver Android só coberto por SQLite do Node | Código real de `migrations.ts`, fixtures históricas sintéticas 1–4 → 5 e driver Nitro SQLite 10.0.0/SQLite 3.49.0, em debug e release: 136 verificações cada. Preservação de todas as colunas antigas, excluídos/NULL/zero/Unicode/prioridades; WAL+VACUUM INTO; backup bloqueado; falha tardia da v5; rollback conjunto de DDL aditivo e escrita financeira; integridade/FKs. |
| Driver desktop só coberto pelo Node do host | 58 testes desktop aprovados no runtime Node do binário Electron de desenvolvimento, incluindo o caminho real de inicialização, backup pré-migration, WAL, rollback e rebuild. Crypto também roda no main real, sem `RunAsNode`. Não é instalação/upgrade do produto empacotado. |
| Viabilidade do wrapping Android | Seis checks de AES-256-GCM no Android Keystore por build: round-trip, nonce/tag/tamanho, nonce novo, adulteração e AAD incorreto. Chave efêmera do ensaio removida em `finally`. Emulador reporta `securityLevel=0` (software); nenhum claim de hardware. |
| IdP indefinido para o piloto | **Keycloak auto-hospedável**, imagem de desenvolvimento 26.7.4, indicada no [guia oficial consultado](https://www.keycloak.org/getting-started/getting-started-docker). Implementar realm dedicado, dois clients públicos OIDC, Authorization Code + PKCE S256, browser do sistema, redirects explícitos, identidade `(issuer, subject)` e audience da API. Não usar password grant, segredo de client embutido nem wildcard de redirect. Fixar digest da imagem quando criar o ambiente na Etapa 1. Não foi iniciado container/realm/conta. |

O harness fica em `/tmp`, usa `com.lionpocketmobile.cryptospike`, APKs com JS embutido e dev support desativado. AVD iniciada em modo read-only, sem carregar/salvar snapshots. Nunca abre `lionpocket.sqlite` nem chama importação/restore do app. Fixtures SQL são confiáveis e copiadas para bancos de nomes aleatórios; o lexer de preparação não é parser de arquivos do usuário. A cópia de `catalogDefaults.ts` apenas resolve o import puro de categorias do core, sem mudar o algoritmo da migration. APK release é o buildType release do template, assinado pela chave debug pública; não é um artefato de distribuição.

## Trust mínimo decidido para o piloto

O dispositivo fundador gera três segredos independentes por CSPRNG: seed Ed25519 da autoridade do vault, seed Ed25519 de escrita do dispositivo e seed X25519 do dispositivo, além da DEK de 32 bytes. A autoridade não é a chave de escrita. Gera `vaultId` e pina localmente `serverId`/`serverEpoch` do ambiente confirmado e a pubkey da autoridade; grant inicial versão `"1"` tem predecessor NULL e assinatura da autoridade. Conta autenticada e membership permitem criar o vault; não substituem esse trust criptográfico.

A cada aprovação/revogação, incrementar `registryVersion` decimal int64 e vincular SHA-256/base64url do **grant completo anterior, incluindo assinatura**. O registro conserva a cadeia inteira. O receptor valida assinatura, versão/predecessor, escopo e chaves/status, reconstruindo o mapa de aparelhos. Rollback de uma versão já pinada é recusado. A API futura serializa o append; assinatura correta sozinha não autoriza pular versões ou reusar um predecessor. Esses checks de estado serão implementados na Etapa 1.

O pedido de pareamento deve conter origem/epoch/vault, ID e ambas as pubkeys do novo aparelho, nonce de 32 bytes e fingerprint SHA-256 dos bytes canônicos desses campos. Confirmar por QR/comparação em canal confiável antes de assinar o grant. O QR de aprovação também transmite a pubkey da autoridade pinada; não confiar em uma pubkey substituída pelo servidor. O decoder, prova de posse, formato visual e vetores do pedido são trabalho da Etapa 1, antes de habilitar pareamento.

Para manter a autoridade simples no piloto, **somente o fundador possui a seed de autoridade**, também presente no recovery cifrado. O segundo aparelho recebe a DEK e escreve com sua chave de dispositivo; não assina grants usando essa chave. Novo pareamento/revogação exige o fundador ou reinstalação por recovery. Qualquer dispositivo ativo pode assinar uma entrega de DEK para um destinatário já aprovado, com o escopo/versões repetidos no bundle. Não replicar a seed administrativa implicitamente no bundle de entrega existente. Delegação administrativa e múltiplos proprietários precisam de novo contrato, fora do piloto. Essa restrição concretiza o registro assinado pelo proprietário recomendado pela proposta.

Revogação bloqueia transporte imediatamente; proteção do conteúdo **futuro** exige DEK nova e distribuição somente aos ativos. Escritas antigas pendentes ficam preservadas para reemissão com novos IDs/proveniência, sem trocar keyVersion de ciphertext existente. Implementação completa de rotação/checkpoint/recovery e revisão independente são gates de publicação da Etapa 4, não autorização para usar dados reais no piloto.

## Recovery mínimo decidido e vetorizado

Gerar um master independente por vault. Código: `LP1.` seguido de base64url canônico sem padding de **32 bytes aleatórios** (43 caracteres depois do prefixo). O prefixo não é entropia; não usar senha de login, UUID, palavras escolhidas ou seed fixa. Código é segredo fora do servidor e dos logs. O usuário precisa guardar cópia externa, com confirmação de posse antes de considerar recovery disponível.

Chave: `crypto_kdf_derive_from_key(32, 1, "LPRECOV1", master32)`, BLAKE2b com contexto de oito bytes ASCII, conforme a [API de derivação de chave de alta entropia](https://libsodium.gitbook.io/doc/key_derivation). Não é password KDF e não aceita senha humana. Perfil literal `sodium-kdf-blake2b-LPRECOV1-1`; subkey ID cabe exatamente no Number e não depende de conversão int64 do JS.

`RecoveryEnvelope` tem formato/suite, origem/epoch/vault, recoveryVersion, perfil KDF, nonce aleatório de 24 bytes e ciphertext+tag. AAD é `canonical({context:"LionPocket/recovery/v1",header: envelopeSemCiphertext})`. Cifrar bundle inteiro com XChaCha20-Poly1305 combinado. `RecoveryBundle` repete escopo/versão, registryVersion, seed/pubkey da autoridade, versão de DEK ativa e **todas** as DEKs históricas necessárias, ordenadas por keyVersion, sem duplicatas. Não inclui sessões, tokens nem chaves privadas de dispositivos. O receptor confere escopo/versões e pubkey derivada da seed, valida a cadeia do registry e cria chaves/dispositivo novos, usando a autoridade recuperada para aprovar o novo cadastro.

Trocar código exige master novo, recoveryVersion seguinte e recifrar o bundle com nonce novo, sem alterar registros financeiros. A API futura conserva apenas o envelope vigente e impede rollback operacional conhecido; retirar cópia antiga no servidor não apaga cópias obtidas anteriormente. Perda do último dispositivo **e** do código torna E2EE remoto irrecuperável, preservando backups financeiros locais. Restore de servidor/epoch e detecção de rollback sem checkpoint externo continuam exigindo o runbook da Etapa 4. Vetores comprovam construção/bytes, não o fluxo completo de recuperação.

## Armazenamento e limites do piloto

Android envolve seeds/DEKs com AES-256-GCM usando chave não exportável de Android Keystore, nonce gerado pelo provider, tag 128 bits e AAD versionado que vincula instalação/dispositivo e escopo. Persistência somente no armazenamento privado; backups financeiros excluem wrapper/credenciais. Hardware/StrongBox e autenticação biométrica não são requisitos do piloto; não anunciar proteção por hardware quando o provider é software.

Desktop mantém segredos no main e usa o cofre do SO. No ambiente testado `safeStorage` informou `gnome_libsecret`, disponível; só a disponibilidade/backend foram inspecionados, sem criar entrada no cofre. Recusar persistência se indisponível ou `basic_text`; manter o app local funcional e pareamento indisponível até configurar cofre suportado. Não persistir segredo em SQLite/renderer/JSON e não oferecer plaintext como fallback. Adapters duráveis, falhas de unlock e reinstalação são trabalho da Etapa 1.

Decisões de limite para o piloto: 1 MiB de UTF-8 por commit completo; até 100 operações/commit, 32 pais/operação, profundidade JSON 32, 100 commits/página e 4 MiB por página, incluindo metadados; 10 dispositivos ativos/vault; zero GC/TTL de revisão ou tombstone. Decoder deve validar bytes UTF-8, nomes duplicados, forma canônica e tamanho **antes** de materializar/validar objetos; commit inteiro é recusado, sem parcial. Esses limites ainda não estão aplicados em API/motor inexistentes. Exceder limite de sync preserva escrita local e payload para revisão; não truncar registro financeiro.

Conflitos seguem a proposta: contabilizar última base comum válida; rascunhos preservados separados; sem base comum, fora dos totais até resolução. Delete/edit oculta o objeto, conservando recuperação da edição como objeto novo. Resolução usa exatamente os heads revisados. UI e validação integrada precisam ser implementadas/testadas na Etapa 1.

## Trabalho necessário na Etapa 1

1. Integrar os bindings **pinados** e os adapters de cofre, rodando de novo os vetores em cada plataforma. Implementar validadores de controle/registry, pedido de pareamento e prova HTTP com nonce/replay protection; assinatura HTTP independente do envelope durável.
2. Criar migrations aditivas mínimas de sidecars, revisão/heads, tombstones, outbox/inbox e contadores; edição manual + outbox na mesma transação. Atualizar validators/backup/staging para reconhecer sidecars antes de publicar qualquer nova versão. Nenhuma migration 6/12 está reservada/aplicada agora.
3. Montar API/PostgreSQL/Keycloak de desenvolvimento, duas sessões reais, PKCE, membership, aprovação e entrega de chave. Fixar versões/digests quando montar os serviços, sem dependência da Cloud. Implementar recibos idempotentes, commit atômico, cursor serializado, mudanças paginadas e busca de pais.
4. Implementar criar/editar/realizar/excluir somente `manualTransaction` sem referências, em **bases vazias de teste separadas**, opt-in. Continuar deixando as demais entidades locais.
5. Executar os oito critérios da [Etapa 1 da proposta](local-first-sync-proposal.md#etapa-1--fluxo-vertical-mínimo-ambiente-de-desenvolvimento): retry após perda de resposta, crash/reabertura, ramo concorrente, exclusão offline, zero/NULL, isolamento/revogação e uso local sem conta.

Não há bloqueio técnico conhecido para **começar esse trabalho**. Ainda não há fluxo vertical aceito. Antes de dados reais/release: aparelho arm64 físico, Windows e cofres reais, APK distribuível/upgrade sem apagar dados, fixtures desktop adicionais, storage cheio/interrupção, revisão independente de trust/recovery/rotação e ensaio completo de restore/epoch. SQLite/exports locais em claro e SQLCipher continuam decisão separada. Onboarding de bases preenchidas, importações/planejamento e retenção finita pertencem às etapas posteriores.

## Primeira parte implementada

A [fundação local do piloto manual](local-first-sync-stage1-local-foundation.md) implementa os bindings/cofres, migrations aditivas mobile 6/desktop 12, backup/staging e escrita manual + sidecars/outbox atômica, verificados em bancos sintéticos separados. As afirmações anteriores sobre ausência de migrations/adapters descrevem o estado de entrada, antes dessa implementação. Sync continua desativado por padrão, sem capabilities remotas, API, login, transporte ou onboarding. Validadores de trust/registry, pareamento e prova HTTP continuam pendentes; não confundir esta primeira parte com a aceitação do fluxo vertical completo.


## Continuação: provisioning implementado

O [fluxo de provisioning/trust/pareamento sintético](local-first-sync-stage1-provisioning.md) agora implementa API de controle com PostgreSQL/Keycloak, PKCE, grants encadeados, comparação de fingerprint, entrega de DEK cifrada, decoder limitado e prova HTTP com nonces duráveis. As afirmações acima sobre API/login/trust pendentes registram o estado de entrada ou o recorte anterior. Envio financeiro, cursores, inbox/outbox remota, projeção e conflitos permanecem pendentes; capabilities financeiras seguem vazias.

## Continuação: transporte manual

O [fluxo vertical desktop ↔ Android](local-first-sync-stage1-transport.md) implementa commits cifrados idempotentes, cursores scoped, inbox/quarentena/projeção, conflitos e migrações desktop 13/Android 7. Seu guia contém o aceite e os limites atuais. Os estados anteriores neste documento são históricos; capabilities financeiras continuam vazias por padrão, com `manualTransaction` disponível somente no opt-in sintético após o aceite.
