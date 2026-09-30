# Contratos mínimos v1 — Etapa 0

Estado: contrato de desenvolvimento offline, 30/09/2026. Tipos e validação em [`packages/sync-protocol/src`](../packages/sync-protocol/src). Apps não importam o pacote e não iniciam transporte. Contratos amplos de planejamento/cadastros são preparatórios; o único validador executável de domínio é o futuro piloto manual. A criptografia continua candidata até [validação nativa](local-first-sync-crypto-spike.md).

## 1. Versões, escopo e limites de responsabilidade

`protocolVersion=1` governa o envelope; `domainSchema=1` governa plaintext. Versões SQLite desktop/mobile e formato do backup são independentes. `cryptoSuite="lp-sodium-v1"` escolhe parâmetros exatos; nenhuma negociação pode substituí-la por plaintext ou outra construção sob o mesmo nome.

Etapa 0 anuncia zero escopos, sync desativado. Na Etapa 1, anunciar exclusivamente `entityScopes: ["manualTransaction"]`: transação manual sem categoria/pagamento/cartão, ocorrência ou parcela, incluindo sua exclusão. DTOs de `Snapshots` cobrem domínio futuro, mas não são capabilities nem validação completa. Campos de outros escopos permanecem locais. Versão desconhecida conserva bytes em quarentena e não fecha o banco local.

Core: datas/invariantes/regras financeiras. Protocolo: DTO, formato e validação portável. Motor futuro: transações, causalidade, projeção e conflitos. Apps: drivers, UTF-8/CSPRNG/crypto/cofre e rede. Servidor futuro: autorização, idempotência, grafo público e log atômico; não executa regras financeiras ou lê o tipo dos objetos.

## 2. IDs e proveniência

| ID | Regra |
| --- | --- |
| `local_id` | PK SQLite atual, opaca; pode ser UUID, hex ou seed. Nunca enviada como referência global. |
| `local_scope_id` | UUIDv4 seguro da linhagem da base, independente de instalação/login. Conservado por backup futuro com proveniência. |
| `global_id` / `objectId` | UUIDv4 para objetos comuns; UUIDv5 apenas para slot comprovado. Sidecar `(entity_type, local_id) → global_id` único; associação sobrevive a DELETE local. |
| `vaultId`, `serverId`, `serverEpoch`, `deviceId` | UUIDv4 seguro. Vault é a base remota; scope é a base local; device é cadastro de instalação, nunca restaurado como sessão ativa. Server epoch muda em restore operacional. |
| `commitId`, `opId` / `revisionId`, `scheduleEpoch`, `slotId` | UUIDv4 seguro offline. Revisão = op. Não reutilizar IDs depois de mudar bytes, origem, chave ou epoch. `slotId` imutável; numeração de parcela é atributo corrigível. |

Wire: UUID em lowercase com hífens, variante RFC, versão 4 ou 5 conforme o campo. UUID não é autorização. `randomUUID` do Node serve para IDs novos seguros; a geração global Android exige CSPRNG do binding auditado. Não converter hex legado acrescentando hífens/version bits ou usar `Math.random`, relógio, nome/email. Na migration, atribuir novo UUIDv4 inclusive a UUIDs locais e seeds, sem reescrever PKs/FKs. Arquivo legado importado duas vezes não prova linhagem global compartilhada.

UUIDv5 segue [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html): namespace é o UUID global da série/compra; name usa bytes UTF-8 da chave ASCII exata, sem trim/locale. Slots mensais: `monthly:AAAA-MM`. Manual: `manual:<scheduleEpoch>:AAAA-MM`; fixa semanal/once/custom: `<scheduleEpoch>:<scheduledDateOriginal>`; ancorada: `<scheduleEpoch>:after:<predecessorGlobalId>`. Parcela: `installment:<slotId>`. Dia previsto/editado e mês da fatura nunca identificam o slot. Mudança estrutural gera epoch nova; edit de texto/valor ou dia mensal mantém a epoch. Aliases de slots resolvidos prevalecem sobre a derivação nova para conservar objetos antigos.

Dados legados ambíguos: UUIDv4 aleatório, `identity_unresolved` e `originalDate=null`; não inferir prova de `purchase_date/due_date`, nem bloquear uso local. Uma série ambígua não pode ser publicada antes da revisão de seus slots. Um alias pertence ao agregado da série e é cifrado/assinado junto da definição. Nunca derivar duas identidades concorrentes e deduplicar depois por valor/descrição.

## 3. DTOs e invariantes financeiras

Os tipos de [`types.ts`](../packages/sync-protocol/src/types.ts) são snapshots completos, sem PK local, `deleted_at` de projeção ou campos de JOIN. Revisão carrega `domainSchema`, `entityType`, `action`, `authoredAt`, `provenance`, `dependencies`, `restoredFrom` e snapshot/tombstone.

| Objeto | Conteúdo persistido canônico |
| --- | --- |
| transaction | kind, descrição, IDs globais de referências ou NULL, centavos planejados/realizados, compra/vencimento/realização ou NULL, status, notas, `source`, metadados de parcela e `occurrenceDate` explícitos ou NULL |
| category/paymentMethod/card | Nome e campos próprios (kind/color ou dueDay/closingDay). Excluir não é remover a identidade global. |
| recurring | Programação, valor, referências, `scheduleEpoch`, identidade resolvida/ambígua e mapa de aliases |
| installmentPurchase | Valor/parâmetros da compra, slots imutáveis e identidade/proveniência; não incluir parcela “vista” na UI |
| goal | Nome/modelo/link, referências, target/saved em centavos, prioridade/status/data/notas; saved é saldo absoluto |
| recurringPriorityList | Array ordenado de `{seriesId,pinnedFromMonth}`; única lista global |
| monthlyPriorityList | Mês e IDs de transações em ordem, um objeto global por lista mensal; IDs de lista também via sidecar, não posição |

Valores monetários: inteiro seguro JS, não negativo, máximo `9007199254740991`, sem ponto flutuante, sem arredondamento ou `-0`. `actualAmountCents=null` é ausência; `0` é valor realizado explícito. O piloto aceita `null` inclusive em legado realizado, como o core atual; não inventa realizado ao ler protocolo. Escritas de baixa continuam definindo valor explicitamente/seguindo regra local. Parcelas positivas e demais limites devem passar pela regra financeira do core quando esse escopo for habilitado.

Datas financeiras: `AAAA-MM-DD` calendárico, anos 1000–9999; meses `AAAA-MM`; instantes novos: `AAAA-MM-DDTHH:mm:ss.sssZ` UTC. SQL legado `datetime('now')`/NULL permanece literal em `legacyCreatedAt/legacyUpdatedAt/legacyDeletedAt`, nunca recebe fuso inferido. `authoredAt` é autoria da **revisão**, não critério de desempate financeiro nem prova anterior à revogação.

Status válidos: planned/paid/received/cancelled; paid exige expense, received exige income; realizado exige settledDate válida; planned/cancelled exigem settledDate=NULL. Descrição não vazia e notas textuais, sem normalizar Unicode ou trim na serialização. Categoria compatível com kind e demais referências ativas/convergentes serão conferidas no cliente antes de projetar; falta/tombstone/conflicto fica preservado em revisão/quarentena, não ignorado para satisfazer FK.

`source` é união exclusiva: manual; recurring `{seriesId,slotKey}`; installment `{purchaseId,slotId}`; imported `{importKey,importAlgorithmVersion:1}`. Import key futura é digest SHA-256 versionado de digest do arquivo, aba, índice e linha canônica; a definição de bytes dessas entradas e posição zero/um-based precisa ser fechada antes da Etapa 2. Chave antiga fica como proveniência legada; nunca transformar `source_id` de importação em FK de série. Listas de prioridades proíbem repetição de ID e preservam ordem; posição SQL é projeção, não objeto independente.

`action=put` inclui snapshot completo. `action=delete` inclui snapshot=NULL, `reason="user"`, `deletedAt`, `slotKey`/`importKey` ou NULL. Tipo/motivo/data ficam cifrados. O contrato amplo admite `reason="legacy_unknown"` e `deletedAt=NULL` para história sem prova, conservando a string original em `provenance.legacyDeletedAt`; esse caso fica fora do validador/capability do piloto e exige revisão antes do baseline. Não fabricar horário ou atribuir exclusão humana a uma invalidação legada ambígua. Invalidação de cache **não** gera esse tombstone. Recuperação cria novo `objectId` com `restoredFrom` apontando o excluído, preservando tombstone anterior.

No piloto, todas as referências, `installmentNumber/Total`, `occurrenceDate` e `restoredFrom` normalmente são NULL, `source={type:"manual"}` e `dependencies=[]`. `assertManualTransactionSnapshot` e `assertManualTransactionRevision` rejeitam campos de UI/escopos extras. São verificadores de shape/domínio, não autorizações para publicar ou mecanismos de deserialização de JSON arbitrário.

## 4. Commit, ancestralidade e transações

Um commit contém uma ou mais revisões completas e indivisíveis. `opId` é único e imutável; pais pertencem ao mesmo objeto/vault e devem existir ou vir antes no mesmo commit. Conjunto de pais é ordenado lexicograficamente, sem repetidos/autopai. Array `operations` é **ordenado por dependência** e não deve ser reordenado na assinatura/retry. Commit não precisa ordenar IDs lexicograficamente.

Edição comum usa apenas os pais efetivamente incorporados. Edição local consecutiva pode ter pai ainda pendente. Para reconciliação, `expectedHeads` é obrigatório, não vazio e exatamente igual ao conjunto `parents` revisado. Aceite remoto compara os heads dentro da transação; um terceiro head produz `heads_changed`. Edição comum de pai antigo cria ramo; não exige expectedHeads nem elimina outro ramo. Duas baixas/valores concorrentes nunca se somam. Conflito delete/edit oculta objeto e conserva ramo editado recuperável.

Unidade de trabalho futura: validar → gravar domínio → sidecar/revisão/heads/tombstone → outbox → COMMIT. Falha em qualquer passo reverte todos. Sem vínculo remoto, não criar fila infinita; baseline consistente ao aderir. Recebimento usa inbox + revisão + projeção na mesma transação, sem eco para outbox. Crash em in_flight gera retry dos **mesmos bytes**. Nenhuma fila foi implementada aqui.

Outbox: pending → prepared → in_flight → acknowledged; erro recuperável volta a retry, permanente preserva payload e erro. Preparado é imutável: edição posterior cria outro commit. Nenhuma compactação de pendentes ou GC/TTL de tombstones na v1. Ausência em backup não é exclusão.

## 5. Envelope e serialização exata

Formato exemplificado integralmente em [`fixtures/crypto.json`](../packages/sync-protocol/fixtures/crypto.json):

- Cabeçalho: `protocolVersion`, `serverId`, `serverEpoch`, `vaultId`, `deviceId`, `deviceSeq`, `commitId`, `keyVersion`, `deviceRegistryVersion`, `cryptoSuite`.
- Operação: `opId`, `objectId`, `parents`, `nonce`, `ciphertext`; `expectedHeads` somente na reconciliação.
- Commit: cabeçalho + `operations` + `signature`. Tipo, snapshot, dependências financeiras, autoria e tombstone permanecem no ciphertext.

`deviceSeq`, cursor, logPosition, registryVersion são strings decimais de int64 não negativo: `0` ou `[1-9][0-9]*`, máximo `9223372036854775807`. Sequência e registry iniciam em 1; cursor inicial em 0. Nunca converter sequência/cursor para Number. Versão de chave é inteiro positivo seguro. Bytes são **base64url RFC 4648 sem padding**, com bits finais canônicos; não aceitar base64 convencional, padding, whitespace ou representação alternativa.

Perfil `canonicalStringify`: subconjunto inteiro de [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html). Objetos JSON simples, chaves em ordem UTF-16 (`sort` sem locale), arrays em ordem explícita, sem whitespace/BOM, strings escapadas por JSON, Unicode escalar válido e **sem normalização**. `undefined`, bigint, float, NaN/Infinity, -0, Date/protótipos especiais, sparse arrays, símbolos, getters, propriedades ocultas e ciclos são erros. Inteiros seguros serializam em decimal. UTF-8 dos caracteres dessa string são os bytes do protocolo; binding deve usar encoder conforme Unicode e passar o vetor hexadecimal. Native não deve usar um serializador que ordene chaves por locale/codepoints ou escape todo Unicode.

Objetos devem ser validados antes de assinar. O pacote recebe valores JS e **não detecta chaves duplicadas já descartadas por JSON.parse**: o futuro decoder de transporte deve recusar nomes duplicados, UTF-8 inválido e bytes não canônicos antes de aceitar envelope. Quotas de bytes/profundidade/contagem ainda pertencem ao decoder/motor da Etapa 1; não expor esses helpers diretamente a rede sem limites.

AAD de operação (UTF-8) é exatamente:

```text
canonical({ context: "LionPocket/operation/v1", header,
  operation: {opId, objectId, parents, nonce, expectedHeads?},
  operationIndex: índice zero-based, operationCount: quantidade })
```

`header` contém **todos os dez campos acima**, inclusive suite/registryVersion; `operation` exclui somente ciphertext. O índice/quantidade impede retirar/reordenar operação sem invalidar autenticação. `nonce` está no envelope e no AAD. Não inserir campo default `expectedHeads` em uma edição comum. Helpers exigem commit **sem signature**; isso evita assinatura/AAD autorreferente.

Entrada Ed25519 detached, sem prehash externo, é UTF-8 de:

```text
canonical({ context: "LionPocket/commit/v1", commit: unsignedCommit })
```

Inclui todos os nonces/ciphertexts/IDs/pais/operações. A assinatura não inclui a própria `signature`. Digest idempotente: SHA-256 de UTF-8 de `canonical(envelopeCompletoComSignature)`, retornado base64url no recibo. Retry conserva envelope/hash; assinatura HTTP futura varia por nonce de transporte e é independente da assinatura durável. Alteração de header, posição, pais, ciphertext ou assinatura altera hash/verification. Lookup dos pais/registro e verificação crypto são externos ao `assertCommitEnvelope`.

## 6. Suite, chaves e trust

`lp-sodium-v1`: XChaCha20-Poly1305 IETF combinado (`crypto_aead_xchacha20poly1305_ietf_*`), chave de 32 bytes, nonce aleatório CSPRNG de 24, tag final de 16 incluída no ciphertext; Ed25519 detached de 64 bytes, pubkey de 32, seed de 32 para fixtures; produção guarda secret key conforme API escolhida. Cada preparação nova usa nonce novo. Nonce fixo/chaves dos vetores são **públicos e proibidos no app**.

Entrega de chave: `crypto_box_seal/open` de libsodium (X25519 **+ XSalsa20-Poly1305**, pubkey efêmera, overhead de 48 bytes). Não é uma sealed box “XChaCha” nem uma assinatura de remetente. Por isso `VaultKeyDelivery` também precisa de assinatura de aparelho autorizado sobre `canonical({context:"LionPocket/key-delivery/v1",delivery: unsignedDelivery})`, incluindo destinatário, origem/epoch/vault, registry/keyVersion e ciphertext. Plaintext do bundle repete destino/escopo/versões e chave do vault; receptor confere contra envelope e registro aprovado. Keys Ed25519/X25519 são pares independentes, sem conversão implícita.

`DeviceGrant` representa evento na cadeia de aprovações/revogações: owner/admin do vault assina `canonical({context:"LionPocket/device-grant/v1",grant: unsignedGrant})`. `previousRegistrySha256` vincula hash do grant anterior completo; primeira versão tem NULL, versões posteriores exigem predecessor. Pubkeys/status/destino/versão são autenticados; clients fixam pubkey de autoridade e identidade do vault durante pareamento confiável. Bootstrap do piloto, pinning e restrição de autoridade ao dispositivo fundador estão decididos no [complemento técnico](local-first-sync-stage1-readiness.md#trust-mínimo-decidido-para-o-piloto); a implementação de estado/pareamento ainda pertence à Etapa 1. Horário do aparelho não prova revogação; servidor conserva registryVersion vigente no aceite e cliente valida autoria histórica. Retenção de grant/cadeia acompanha a vida do vault.

Recovery v1 de desenvolvimento: master independente por vault de 32 bytes CSPRNG; código `LP1.` + base64url canônico desses bytes. Chave AEAD: `crypto_kdf_derive_from_key(32, 1, "LPRECOV1", master32)` (BLAKE2b, oito bytes ASCII), perfil `sodium-kdf-blake2b-LPRECOV1-1`. Não aceita senha humana/login. `RecoveryEnvelope` contém `formatVersion=1`, suite, serverId/serverEpoch/vaultId, recoveryVersion decimal positivo, perfil KDF, nonce 24 bytes e ciphertext combinado. AAD: `canonical({context:"LionPocket/recovery/v1",header: envelopeSemCiphertext})`. `RecoveryBundle` repete escopo/versão, registryVersion, authoritySignSeed/pubkey, activeKeyVersion e dataKeys históricas `{keyVersion,vaultKey}` ordenadas sem duplicatas. Seeds/master/DEKs têm 32 bytes; pubkey derivada da seed deve coincidir. Não incluir chave privada de dispositivo/token/sessão. `control.json` congela bytes/KDF/cifra, testados em C/Electron/JSI; lifecycle e validação de estado não estão implementados. Troca de código/rotação e limites: [decisões técnicas](local-first-sync-stage1-readiness.md).

Helpers `deviceGrantSigningInput`, `keyDeliverySigningInput` e `recoveryAssociatedData` definem exclusivamente serialização/context; recusam assinatura/ciphertext na entrada que deveria excluí-los. Não fazem parsing limitado, validação de DTO/trust/chain ou criptografia. Os adapters da Etapa 1 precisam validar antes de usar esses bytes. Reset de conta não recupera E2EE. Revogação bloqueia transporte e exige rotação futura; não apaga conhecimento já entregue. Prova HTTP e pedido de pareamento terão contexts/vetores distintos antes de sua implementação.

Android: Keystore envolve segredos de software; não presumir Ed/X25519 em hardware. Desktop: main + cofre do SO; recusar persistência em `safeStorage basic_text`. Credenciais nunca SQLite/JSON/AsyncStorage/renderer. Banco e export em claro continuam independentes de E2EE. Nenhum mecanismo de cofre/recovery foi implementado nesta etapa.

## 7. Recibos, paginação e erros — sem endpoints implementados

Tipos `CommitReceipt`, `ChangesPage`, `CursorScope` formalizam mínimos. ACK válido identifica server/epoch/vault, commit, device/seq, digest **igual ao enviado**, logPosition e heads. `2xx` isolado não confirma envio. Repetição idêntica retorna recibo original/alreadyAccepted; `(vault,commitId)`, `(vault,opId)`, `(vault,deviceId,deviceSeq)` com bytes divergentes dá idempotency_mismatch sem sobrescrever. Pais ausentes recusam commit inteiro com IDs necessários; falha de expectedHeads também não aceita metade.

Log remoto precisa de contador serializado por vault até commit visível, não só BIGSERIAL reservado antes de commit. Página não divide commits; upperBound fixa horizonte do ciclo, nextCursor avança após armazenamento durável. Cursor é scoped também por endpoint/binding local; nunca transplantar cursor entre servidores/vault/epochs. Separar received de applied, e applied só avança se projeção/conflito recuperável estiver durável. Desconhecidos ficam em quarentena, não sumidos silenciosamente. Baixar o próprio commit via pull é válido; ACK nunca avança o cursor de recepção.

Códigos: unauthenticated, forbidden/device_revoked, epoch_changed, idempotency_mismatch, heads_changed, missing_parents, unsupported_version, payload_too_large, rate_limited, invalid_envelope, temporary_failure. Erros mantêm outbox e uso local. Quotas candidatas 100 commits/página e 1 MiB/commit serão negociadas; não fracionar uma ação financeira indivisível para caber no limite. V1: um binding ativo, proprietário único, sync manual, sem GC, sem modo plaintext.
