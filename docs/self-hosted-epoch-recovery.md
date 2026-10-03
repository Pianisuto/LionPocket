# Recuperação após restore do mesmo servidor

## Estado desta implementação

**O aparelho âncora já pode preparar, ativar e voltar ao sync normal.**

O incremento de activation parte exatamente de `a42613567d2748db46b76c6aaef7e1d92cf7c5ba` (main após PR #12). A preparação abaixo continua isolada até uma confirmação explícita do usuário. Depois dessa confirmação, uma intenção assinada e durável seleciona a geração preparada em uma transação PostgreSQL; uma saga separada instala o DAG, binding e profile no anchor e só libera foreground depois do primeiro pull normal. Discovery anuncia `activationAvailable:true` como capacidade do protocolo, sem afirmar que um cofre específico está pronto.

O preparation bundle privado permanece disponível durante toda a finalização; suas materializações idempotentes e as proteções legacy continuam válidas. Archives antigos, plano/mapping, ciphertext preparado e journal permanecem imutáveis. Não há rollback automático após activation nem migração do segundo aparelho/C3. Veja [contrato, sequência de instalação e evidências de crash](self-hosted-anchor-activation-validation.md). As seções seguintes documentam os contratos da preparação; não autorizam reconectar outros aparelhos.

## Fronteira de segurança

Um restore pode perder commits aceitos, revogações, cursores, nonces e checkpoints. `serverEpoch` impede que clientes interpretem esse rollback como continuação do mesmo histórico. Trocar epoch em SQLite, pin, grants ou envelopes antigos destrói essa fronteira. Mesmo `serverId` não prova continuidade; um operador pode mudar valores de configuração, mas não possui a authority private key.

A continuidade futura precisa de uma autorização do proprietário e de uma prova final verificável que comprometa a geração nova inteira. A autorização de preparação implementada aqui **não é essa prova final** e jamais deve ser aceita por um segundo aparelho para reconectar.

## Autorização de preparação v1

`EpochRecoveryChallenge` tem exatamente estes campos:

| Campo | Formato e significado |
| --- | --- |
| `formatVersion` | Inteiro `1` |
| `serverId`, `vaultId` | UUID v4 canônico do escopo antigo |
| `fromEpoch`, `toEpoch` | UUID v4 canônicos distintos, origem e destino |
| `authorityPublicKey` | Chave Ed25519 antiga, base64url canônico, 32 bytes |
| `restoreId`, `challengeId` | UUID v4 canônicos do restore e desafio |
| `nonce` | 32 bytes aleatórios, base64url canônico |
| `restoredRegistry` | `{version, sha256}` do registry restaurado |
| `restoredStateSha256` | Compromisso SHA-256 do estado restaurado, base64url, 32 bytes |
| `expiresAt` | Inteiro seguro, deadline em milissegundos definido pelo servidor |

`EpochRecoveryAuthorization` acrescenta `intent: "prepare-recovery"`, `knownRegistry: {version, sha256}` e `signature`. Versões de registry são strings decimais positivas de 64 bits, nunca números JavaScript. Assinatura Ed25519 destacada tem 64 bytes base64url.

Os bytes assinados são UTF-8 do JSON canônico existente no protocolo:

```json
{"authorization":{...todos os campos exceto signature...},"context":"LionPocket/epoch-recovery-authorization/v1"}
```

Não há prehash Ed25519, campos opcionais, reutilização de domínio HTTP/grant/recovery nem mutação de assinaturas antigas. O vetor `packages/sync-protocol/fixtures/epoch-recovery.json` contém seed **pública somente de teste**, challenge, autorização, bytes hex e SHA-256. `tools/epoch-recovery/generate-vector.cjs` reproduz a assinatura com Node/OpenSSL; os testes verificam os bytes e a assinatura com essa implementação independente. Inclui versão maior que o inteiro seguro JavaScript.

### Compromisso do estado restaurado

`crypto.hash` é SHA-256 dos bytes UTF-8 canônicos, codificado base64url. O acumulador começa em `{context:"LionPocket/restored-log/v1",pin}`. Cada posição contígua, em ordem numérica, acrescenta `{context:"LionPocket/restored-log-entry/v1",previousSha256,position,envelopeSha256,receipt}`. `envelopeSha256` deve corresponder aos bytes imutáveis `envelope_text`; a última posição deve corresponder ao contador do cofre. A leitura usa páginas limitadas a 100 envelopes.

O digest final é hash de `{context:"LionPocket/restored-state/v1",pin,registry,keyCheckpoints,recovery,logPosition,logSha256}`. Registry e checkpoints antigos são verificados antes de emitir o desafio. Recovery permanece ciphertext assinado do epoch antigo. O hash identifica o estado que o servidor apresenta; **não prova sozinho que esse estado é completo ou honesto**. Esta versão não oferece download/validação financeira do arquivo antigo para reconstruir baseline. A futura ativação exige essa validação pelo cliente e um manifesto separado da nova geração.

### Rotas e identidade

`POST /v1/vaults/:vaultId/epoch-recovery-challenge`, corpo `{fromEpoch,authorityPublicKey}`, exige OIDC válido da conta proprietária exata (`issuer` e `subject`), conta habilitada, vault dessa conta e registro durável de restore para o epoch corrente. Retorna challenge, pin/grants/checkpoints antigos e recovery cifrado. Não retorna plaintext financeiro, DEKs, authority seed ou commits financeiros. Não requer HTTP proof antigo, que pertence ao epoch anterior.

`POST /v1/vaults/:vaultId/epoch-recovery-authorize`, corpo `{authorization,knownGrants}`, exige a mesma conta e assinatura da authority antiga. O servidor valida todo o registry conhecido pelo proprietário, incluindo a história restaurada como prefixo exato. Revogações assinadas posteriores ao backup permanecem em `known_grants`; não se tornam grants novos nem são descartadas.

Cada desafio tem nonce aleatório, prazo de cinco minutos decidido pelo relógio PostgreSQL, escopo exato e consumo transacional único. São permitidos no máximo cinco desafios por cofre/restauração na janela consultada (deadline posterior a cinco minutos atrás). Assinatura válida sem desafio correspondente, conta diferente, outros epochs/vault/authority/restauração e ausência de registro operacional falham. O cliente não decide validade pelo seu relógio.

A primeira autorização consome o desafio, grava a prova e muda apenas o estado público para `authorized_awaiting_baseline`, na mesma transação. Falha reverte também o consumo. Repetição **byte a byte canônica** da mesma autorização/registry retorna o resultado durável, inclusive depois de expirar, sem aceitar outra operação. Outra autorização não substitui a primeira. A resposta sempre informa `activationAvailable:false`.

### Authority existente e recovery

`authorizeEpochRecovery` exige confirmação explícita, TrustPin antigo e authority seed do armazenamento seguro. Aparelho apenas pareado não possui essa authority. A helper não grava perfil, secret, SQLite ou outbox.

`authorizeEpochRecoveryWithCode` usa o código antigo para abrir e validar o recovery envelope do epoch A contra a authority do convite/pin confiável anterior. Verifica assinatura, AEAD, escopo e derivação da authority; assina a preparação e apaga os buffers temporários. Não instala esses secrets, não cria um aparelho operacional em B e não gera recovery B. Login ou chave do aparelho não substituem o código/authority. O convite confiável precisa existir fora do servidor; não se adota authority apenas porque o servidor a informou.

Sem aparelhos antigos, esta versão permite provar a authority com código válido, mas **não reconstruir o cofre nem retomar sync**. Reconstrução a partir de ciphertext restaurado, nova identidade, registry, chave e recovery B continuam pendentes. Dados posteriores ao backup ausentes de todos os aparelhos/backups são fisicamente irrecuperáveis. A interface futura precisa informar essa perda possível antes de escolher o estado restaurado como referência.

## Modelo de gerações e schema do servidor

Decisão deste draft: **tabelas ativas v1 + tabelas de arquivo por geração**, usando `serverEpoch` como chave inequívoca junto de `vaultId`. Isso mantém o caminho normal de commits/changes sem uma segunda dimensão em cada consulta de operação.

`sync_generations(vault_id,server_epoch,state,archive_sealed)` possui PK composta e índice parcial que impede duas linhas `active` no mesmo cofre. A migration roda depois dos schemas v1 e é idempotente: reconhece o pin atual de cada cofre como geração selecionada, sem editar IDs, grants, recovery ou envelopes e sem produzir commits. Um trigger registra a geração de cofres novos. `requireActiveGeneration` também exige que geração selecionada, pin e ambiente corrente correspondam antes de `/commits` e `/changes`.

Durante restore, A continua sendo a geração selecionada (`state='active'`), porém **sem transporte**, porque seu epoch difere do ambiente B. Selo do arquivo não significa ativação ou troca de geração. Só uma futura transação de ativação poderá marcar A `archived` e B `active`; ela não existe neste draft.

Há oito tabelas `archive_*`, com colunas originais tipadas, `generation_epoch`, PKs e índices por cofre/geração:

- `archive_sync_vaults`: owner, pin, registry/log counters, checkpoints, recovery cifrado e flags;
- `archive_sync_grants`, `archive_sync_pairings`, `archive_sync_deliveries`;
- `archive_sync_commits`: bytes exatos de `envelope_text`, digest, receipt, device sequence, registry de aceite e log position;
- `archive_sync_operations`: identidade e parents;
- `archive_sync_remote_heads`;
- `archive_sync_remote_bindings`.

Após autorização PR #9 aceita, o servidor copia o estado restaurado A e sela o arquivo **na mesma transação da autorização**. O pin e o log originais não mudam. Falha durante a cópia reverte consumo do challenge, autorização, estado do restore e todas as linhas do arquivo. Retry exato lê o mesmo resultado e não recopia. Triggers recusam UPDATE/DELETE nas linhas e INSERT após selo. Não se pode retirar o selo, apagar geração selada ou reativar uma geração marcada `archived` por esse modelo. O usuário de banco privilegiado continua sendo o operador; o arquivo não é uma auditoria externa.

O arquivo remoto representa o snapshot que existe no servidor restaurado. C2 fisicamente perdido pelo restore é preservado no arquivo **local** do anchor, não inventado no servidor. Nonces HTTP expirados não são parte do arquivo lógico. O ledger PR #9, `known_grants` (incluindo revogações posteriores ao backup) e desafios/autorização continuam duráveis e separados.

## Backup e arquivo local do anchor

`prepareAnchorArchive` exige ação explicitamente confirmada, profile/binding financeiro A válido, assinatura de autorização PR #9 e authority seed disponível. Possuir apenas signing key de aparelho pareado ou login não basta. A helper não gera baseline com recovery code sem SQLite antigo.

Antes de criar qualquer tabela de preparação, o callback nativo cria backup SQLite consistente. O adapter desktop `createEpochAnchorBackup` usa `VACUUM INTO` em arquivo novo privado, abre o resultado read-only, verifica `integrity_check`, `foreign_key_check` e pin do binding, calcula SHA-256 dos bytes e sincroniza o arquivo. A segunda inspeção compara hash/pin antes da transação de arquivo. Falha aborta sem criar journal/arquivo. Android tem o contrato de inspeção compartilhado e testes de seu adapter SQLite real; a integração **nativa** de abertura/hash ainda precisa ser feita antes de expor o fluxo no Android.

A extensão local é criada somente depois desse backup validado. Ela não altera a versão normal do schema e não é chamada pelo controller/foreground. Os archives possuem uma linha tipada por linha original, PK por cofre/epoch/identidade, sem um blob único de cofre. Copiam todos os sidecars atuais: `sync_local_state`, bindings, identity, revisions, heads, tombstones, revision_origin, outbox (payload, envelope, digest e receipt), inbox, conflicts, rejected, control, dirty, series, slots, import_provenance, bootstrap, review e aliases. A cópia de `sync_dirty` preserva trabalho ainda não capturado, porém impede um plano incompleto.

A transação cria `recovery_generations`, `recovery_journal`, todas as linhas do arquivo e seu selo/digest. O digest começa com profile público A/autorização e incorpora cada linha canônica, por tabela ordenada e PK, em páginas de 100. Tabelas de arquivo ficam imutáveis; binding/grafo/outbox/financeiro A continuam intactos. Novas edições locais após o selo continuam em A: este draft não as marca como migradas e não pode ativar o plano congelado.

`recovery_journal` registra restore, vault, epochs, backup path/hash, profile público A, autorização e phase. Não contém seeds, DEKs ou recovery master/code. Hoje as fases são `archived`, `planned`, `review-required`, `cancelled`. Ainda não é a saga completa de SecretStore/staging/ativação. Retry usa o mesmo arquivo e mapping, não substitui silenciosamente o snapshot. Cancelamento local é idempotente e conserva backup, arquivo, mapping e A. Retomar após corrigir um review exige ainda definir uma nova tentativa/snapshot explícito; editar o arquivo selado não é uma opção.

Exports JSON de sync v1 não conhecem essa extensão. Desktop/mobile recusam export completo pelo caminho legado quando há journal, com `epoch_archive_requires_sqlite_backup`, em vez de omitir o arquivo silenciosamente. SQLite nativo contém a extensão completa. Versionamento e restore de um export JSON com gerações são trabalho pendente; isso é mais um motivo para não expor o fluxo nativo neste draft. Exports financeiros sem alegação de backup de sync continuam separados.

## Planejamento da baseline e mapping A→B

### Causal closure

Heads-only estava errado: transformar Z→X/Y em duas raízes XB/YB elimina a base comum Z e pode esconder a transação. O planner v2 começa **exclusivamente nos heads atuais do archive local** e visita iterativamente todos os parents e `dependencies[].revisionId`, incluindo parents/dependencies das revisões descobertas, até o fechamento. Não copia história desconectada por conveniência. O archive completo continua intacto.

Parents precisam existir no mesmo objeto; dependencies precisam existir com o object ID declarado. Revisões necessárias rejeitadas, inválidas ou com identidade não resolvida bloqueiam. Parents, dependencies e a união das duas relações são validados separadamente contra ciclos. Dependency não vira parent.

### Rebase e ordem

Kahn com min-heap produz ordem topológica sobre **ambas** as relações. UUID desempata apenas revisões já disponíveis; relógios não decidem ordem ou vencedor. O algoritmo é iterativo, O((V+E) log V), com consultas indexadas por revisão e leitura paginada de IDs reservados. Cada revisão incluída recebe novo op/revision ID e novo commit ID, mantendo object ID, snapshot/action, authoredAt e audit. `provenance.origin='restore'`; `restoredFrom` é a referência de audit explícita para A, não uma edge B.

Parents B são os mappings dos parents A, ordenados como conjunto; dependencies B mantêm o object ID e apontam **à revisão histórica mapeada exata**, nunca ao head mais recente. Nenhuma edge B aponta para A. Commit planning continua um commit por revisão, sem compactação. A preparação operacional abaixo agrupa esses commits em batches. Série, slot, alias e prioridade continuam identidades lógicas.

### Schema, compatibilidade e compromissos

`recovery_journal.plan_format=2` distingue o plano causal. `recovery_revision_mapping` agora persiste `parents_b_json` e `is_head`, além de revision A/B, object, commit B, ordinal e payload B. Só os mappings dos heads A têm `is_head=1`; ancestors/dependencies não ganham status de head. Páginas de até 100 operações retornam exatamente esses parents/classificação.

`migrateAnchorPlan()` adiciona as colunas idempotentemente a um archive PR #10, preservando seu plano como formato 1. O planner, o consumidor e os compromissos **recusam formato 1**. `discardLegacyAnchorPlan()` descarta apenas esse mapping antigo e seus reviews, em transação, retorna a `archived` v2 e permite replanejar a mesma evidência. Nunca apaga archive A, backup, autorização ou profile. A imutabilidade do mapping é reinstalada na mesma transação. Um v2 já durável não pode ser convertido em v1. Review v2 ainda exige uma tentativa/snapshot explícito futuro; não se edita archive selado.

`anchorPlanCommitments` usa domínio mapping v2 e compromete ordinal, revision A/B, object, commit, **parents B ordenados, head/non-head** e hash do payload, que inclui dependencies B. Alterar parent muda o digest. `headsSha256` compromete somente heads finais. O contrato `EpochBaselineManifest` já contém `mappingSha256`; manifesto/transition e vetor contratual não precisaram mudar. O planner por si só não persiste manifesto. A saga operacional abaixo o persiste sem ativação.

### Conflict preservation e restore provenance

A isomorfia das edges preserva ancestry. `causalCommonBase()` encontra o ancestor comum maximal único somente por parents, em tempo linear por head. Para cada objeto, o planner compara a base A com a base B: deve ser exatamente seu mapping, ou null em ambos. Z→X/Y vira ZB→XB/YB, e branches profundas mantêm o mapping da base histórica. Não se achata branch, inventa base ou escolhe head.

O automerge da projeção agora examina **os heads atuais**: se qualquer branch atual tem `origin='restore'`, mantém o conflito. Reemitir branches de devices distintos pelo mesmo anchor não dá permissão para resolvê-las. A resolução explícita continua funcionando. Novos heads locais normais voltam às regras existentes, mesmo com ancestors restore. O teste cobre ambas as situações.

### Replay semântico e reviews

Antes de `planned`, o planner cria schemas **TEMP descartáveis**, com as definições SQLite reais, e executa `applyCommit`/`projectObject` existentes sem criptografia. Tabelas financeiras principais, binding, profile e outbox A nunca são alvos de replay. Savepoints removem toda a simulação, também em falhas. Os adapters devolvem erros SQL ao workflow para permitir rollback da simulação e persistir um motivo de review.

A e B são reproduzidos com o mesmo contexto de identity/series/slots/aliases do archive. O contexto A mantém branches arquivadas sem conceder nova permissão local de automerge; B usa um único anchor e exercita a proteção restore. O oracle reproduz um commit por revisão, na mesma ordem do plano. Prioridades reconhecem identities de slots cujo cache financeiro ainda está vazio e materializam o mesmo slot pela projeção normal; não inserem uma FK para uma transação ausente. A projeção de objeto linear consulta apenas seu head; conflitos/tombstones continuam consultando o grafo necessário. As duas avaliações usam o mesmo clock de projeção fixo para timestamps auxiliares de cache; esse clock não ordena causalidade nem seleciona vencedor. Um teste adicional reproduz commits B individualmente pela projeção normal, inclusive o conflito que seria mergeável por grupos.

A representação normalizada compara todas as tabelas financeiras projetadas, identity/global IDs, heads, conflitos abertos/common base, tombstones, dependency/parent graph, séries, slots, import provenance e aliases. Somente IDs de transporte/contexto de replay e IDs auxiliares de conflito são excluídos ou normalizados A↔B. Conteúdo financeiro, deleted state, audit projetado e prioridades são comparados. O conjunto de heads resultante precisa coincidir exatamente com o conjunto arquivado mapeado. Mismatch ou falha de projeção produz `review-required`, sem mapping utilizável. Antes do primeiro planejamento, novos heads/payloads ou dirty/inbox/rejeições surgidos no anchor depois do archive também bloqueiam; não se apresenta um snapshot antigo como plano do anchor atualizado.

Continuam bloqueando dirty uncaptured, inbox não aplicada/quarantine, identity unresolved, reviews relevantes, edge ausente/estrangeira, snapshot inválido, revisão necessária rejeitada e ciclos. O adapter desktop não faz captura financeira implícita no COMMIT de workflows marcados de recovery; o comportamento de captura normal permanece igual: arquivar/planejar dirty A conserva esse bloqueio, sem mutar A incidentalmente.

Tombstones necessários participam do DAG, inclusive ancestors delete e conflitos delete/edit. Um tombstone desconectado que ainda afeta `sync_tombstones` exige review; não é descartado como história irrelevante. Put que descende diretamente de delete continua bloqueado pelo invariante normal de não ressurreição. Múltiplos deletes necessários com authoredAt distintos também exigem `ambiguous_tombstone_projection`: a seleção atual de delete da projeção não prova qual audit seria preservado. Não escolhemos por timestamp. Dados legados impossíveis continuam fora do recorte seguro.

Crash antes do commit reverte todas as linhas do mapping; retry após commit reutiliza exatamente os IDs. Com o mesmo archive/authorization/restore e UUID source determinístico, bytes e digests são iguais. Backup SQLite preserva a extensão; inspeção valida mappings v2 quando presentes, mas aceita archives v1 como evidência histórica **não utilizável como plano B**. Backup self-hosted não possui mapping local do cliente.

No teste PostgreSQL/Keycloak, C1 foi aceito antes do backup e C2 depois. Restore perde C2 remoto, mas o archive/fechamento local contém C1+C2 e o replay v2 passa. Android offline conserva C3, binding/outbox/SQLite A, sem chamadas novas nem recuperação no foreground.

**Ainda não existe geração B ativa.** Discovery continua `activationAvailable:false`. A preparação abaixo cria secrets/artifacts/staging B; binding B, ativação e sync B permanecem ausentes.

## Manifesto B e prova final separada

O protocolo acrescenta o contrato público `EpochBaselineManifest`, com format/scope/restore/anchor, digest da autorização, registry, key checkpoint, recovery, archive e mapping; contagens int64 textuais de commits/operations/batches; compromisso ordenado dos envelopes e dos heads. O digest usa JSON canônico UTF-8 com domínio `LionPocket/epoch-baseline-manifest/v1`. Não aceita snapshots, secrets ou campos extras.

`EpochTransition` tem domínio obrigatório **`LionPocket/epoch-transition/v1`** para Ed25519 detached. Vincula server/vault/from/to/restore/authority, digest da autorização PR #9, estado restaurado, manifesto, TrustPin B, registry/checkpoint/recovery B, archive/mapping e `previousTransitionSha256` (null na primeira). O hash de encadeamento usa `LionPocket/epoch-transition-chain/v1` sobre a transition completa assinada.

A helper de verificação confere assinatura, compromissos, pin A confiável, pin B distinto no mesmo vault/authority e tip anterior já verificado. A preparação não pode substituir a assinatura final. A→B→C em testes contratuais compromete A→B e recusa omissão/fork/salto. O caller deve validar a cadeia inteira confiável e a semântica dos artifacts/staging antes de considerar ativação: o verificador de compromissos **não valida ciphertext financeiro nem declara recovery/key/registry prontos**.

`fixtures/epoch-transition.json` e `tools/epoch-recovery/generate-transition-vector.cjs` congelam bytes, hashes e assinatura com Node/OpenSSL, independentemente dos adapters sodium. São seeds públicas e artifacts de compromisso **somente de teste**, não registry/key/recovery de produção. Contagens maiores que `MAX_SAFE_INTEGER` evitam coerção numérica acidental.

A rota `epoch-staging-prepare` persiste a transition assinada em `sync_epoch_transitions`, com estado exclusivamente `prepared`. Ela não seleciona uma geração ativa. O ledger continua auxiliar; não substitui a cadeia criptográfica final.

## Operational B preparation

`prepareOperationalB` exige journal `planned` / `plan_format=2`, archive selado, profile A exato e todos os sidecars A iguais ao archive. Revalida isso antes de fechar e publicar artifacts finais. Dirty, inbox, quarantine, reviews e mudança após o archive não são migrados nem tolerados.

Cria novo deviceId, signing seed/public key e box seed/public key. Preserva installationId do aplicativo físico: ele não é fronteira criptográfica; deviceId, profile, epoch e SecretScope são. O pin B preserva serverId/vaultId/authority, muda epoch para `authorization.toEpoch` e founder para o novo anchor. Registry B é uma cadeia nova com somente o grant approved do anchor, versão textual `1`, assinado pela authority A. Não copia grants/revogações A.

A ordem é: validar A/archive/plano; determinar scope estável; carregar ou gerar/persistir/reler/verificar o bundle; construir identidade pública B; inserir saga formato 2 com hash do bundle e digests dos secrets; materializar os secrets B individualmente; avançar a `secrets_prepared`. Falha ambígua de store exige load e comparação exata antes do INSERT. Um bundle ausente depois da reserva é erro duro, nunca regeneração.

SecretScopes preservam installation/server/vault e distinguem device B, epoch B, purpose e keyVersion. Seeds/authority/master usam purpose version 1; a data key usa sua versão operacional. A scope e profile continuam preservados. A DEK B é CSPRNG nova de 32 bytes; não deriva nem reutiliza DEK A. O material da authority é copiado para o scope B, sem trocar/remover a authority A.

### Key base across epochs

`TrustPin.keyVersion` já existe no wire v1 e agora tem semântica explícita de **base imutável da geração** (`baseKeyVersion(pin)`). Nenhum campo extra torna pins legacy permissivos. Cofres antigos permanecem com base 1. B começa em `activeKeyVersionA+1`; `activeKeyVersionB=base`. Checkpoints B começam vazios e rotações posteriores são base+1, base+2. Não são checkpoints A com epoch alterado.

PostgreSQL persiste `base_key_version` e `active_key_version` em sync_vaults. Migration idempotente usa NULL como sentinel para backfill uma vez: base do pin (1 para legacy), ativa do último checkpoint ou da base. Depois instala defaults/NOT NULL/CHECK. Rotação atualiza a versão ativa transacionalmente. `archive_sync_vaults` ganha as colunas; arquivos antigos mantêm seus valores anteriores, com NULL nas novas colunas históricas. Cópia usa nomes explícitos de colunas para não depender de sua posição.

`EpochKeyBase` é um artifact separado: formatVersion 1, serverId/serverEpoch/vaultId/restoreId/fromEpoch, baseKeyVersion, previousActiveKeyVersion, previousKeyCheckpointsSha256 e signature. Domínio Ed25519: `LionPocket/epoch-key-base/v1`. Assert estrito exige base=previousActive+1. O begin inclui a história A conhecida, verificada com grants A autorizados e prefixo exato da história restaurada. Assim, rotações A perdidas no restore são preservadas como evidência; não viram cadeia operacional B. O campo `keyCheckpointSha256` do manifesto compromete **o JSON canônico completo desse EpochKeyBase assinado**, sem ambiguidade com checkpoint de rotação.

Delivery cria a chave ativa e, quando necessário, KeyBundle formatVersion 2 com baseKeyVersion/dataKeys do intervalo deste epoch. KeyBundle v1 continua estrito e emitido para base/ativa 1. O envelope de delivery assinado permanece v1. Upload/recepção admitem delivery assinado histórico deste epoch seguido por checkpoints mais novos: pairing pode publicar delivery e então rotacionar. Checkpoints já recebidos integralmente pelo bundle não exigem um sealedBox histórico dirigido a um device que ainda não existia. Não há condicionais específicas de recovery nesses caminhos.

### Recovery B

O envelope recovery assinado e a KDF LP1 permanecem v1. Somente seu conteúdo cifrado evolui: RecoveryBundle v2 acrescenta baseKeyVersion. Parsing bifurca estritamente por versão e `exactObject`; v1 continua legível e emitido para gerações base 1, preservando recovery de clientes anteriores. `dataKeys` contém exatamente o intervalo base..active do epoch, até 1000 chaves, sem exigir 1..base-1. Versões de recovery são strings int64: B=versão conhecida A+1, inclusive acima de MAX_SAFE_INTEGER.

Se master A confirmado está no SecretStore, o recovery A assinado é aberto e seus secrets/authority/versões conferidos contra o contexto confiável. O mesmo master é copiado para B, preservando o código humano. Recovery B é novo ciphertext e aberto novamente antes de confirmação. O servidor recebe apenas o objeto assinado; não aprende que o código foi reutilizado.

Se master A não está disponível, gera master B novo e retorna código LP1 **somente ao caller**, sem persisti-lo em SQLite/logs. A fase fica `recovery_pending_confirmation`. `confirmOperationalBRecovery` exige redigitação, verifica assinatura/AEAD/scope/authority/registry/base/ativa e todas as DEKs B contra SecretStore, e persiste apenas a flag pública. Código novo nunca é auto-confirmado. O begin assinado pelo anchor inclui `recoveryConfirmed:true`, uma declaração do cliente; o servidor não consegue verificar a redigitação nem decryptar recovery.

### Preparation secret bundle e scope

`EpochPreparationSecretScope` é um tipo específico, localizado sem depender do deviceId B: formatVersion 1, purpose `epochPreparation`, installationId, anchorDeviceId A, serverId, vaultId, fromEpoch, toEpoch e restoreId. Wrapping usa domínio `LionPocket/epoch-preparation-wrap/v1`, distinto de `LionPocket/local-wrap/v1` dos secrets operacionais.

O bundle privado formatVersion 1 guarda deviceId B; signingSeed, boxSeed e dataKey B CSPRNG independentes; cópia da authority necessária; master confirmado A ou master B novo; nonce recovery B; public keys derivadas/baseKeyVersion; recovery A assinado quando aplicável; hashes do profile A/autorização e compromissos do plano. Guarda bytes do master, sem código textual LP1. O nonce durável também reproduz ciphertext/signature do recovery se ocorrer crash antes do INSERT desse artifact. Não cria uma KDF nova.

Parsing exige JSON canônico/exact object, UUIDs, comprimentos exatos, scope/plano/profile A confiáveis. Recalcula public keys signing/box/authority e valida recovery A/master/DEKs antes de aceitar. Toda reserva pública precisa coincidir exatamente com o bundle, sem reparo de um lado pelo outro. Mensagens de parsing são fixas e não citam conteúdo privado. O bundle tem limite de 128 KiB.

Desktop usa safeStorage seguro, tempfile fsynced e publicação create-if-absent por hard link; uma reserva existente diferente é recusada. Linux basic_text/unavailable continua recusado. Android usa AES-GCM AndroidKeyStore + AndroidX AtomicFile (.new em todas as APIs suportadas, incluindo primeira escrita, com fsync explícito antes de publicar; lê backups .bak operacionais legados) no noBackupFilesDir, alias/diretório exclusivos da preparação, wrapper versão 2; wrappers operacionais versão 1/32 bytes permanecem compatíveis. TestSecrets aplica a mesma imutabilidade. Os três adapters aceitam bytes variáveis somente nesse scope específico.

### Saga local e crash recovery

Extensão instalada explicitamente após o archive, sem bump da migration financeira normal:

- `recovery_b_saga`: identity_reserved → secrets_prepared → recovery_pending_confirmation → recovery_confirmed → staging → staged → prepared.
- `preparation_format=2` e `preparation_sha256` imutáveis vinculam o artifact privado. Migration aditiva atribui formato 1 a rows antigos, bloqueados explicitamente.
- `recovery_b_envelopes` e `recovery_b_batches`: bytes/digests/identidades imutáveis.

SQLite guarda somente artifacts públicos/ciphertext, compromissos e digests; bundle/seeds/DEK/master/LP1 não entram no SQLite, PostgreSQL, backup público, staging begin, manifest ou transition. Antes de existir bundle durável, não existe reserva pública e retry pode gerar material. Depois, retry somente carrega o bundle original: secret ausente é gravado com aqueles bytes; presente diferente falha duramente. Faults cobrem todas as fronteiras e releitura. `last_device_seq` preserva o contador baseline para futura ativação, sem mudar o contador ativo A.

Antes de `remote_started=1`, `cancelOperationalB` significa pausar: `phase='cancelled'` preserva a fase anterior em `resume_phase`, archive/plano/bundle/identidade/secrets/artifacts. `resumeOperationalB` é ação explícita, valida novamente a reserva e restaura a fase original; foreground não retoma. `cancelAnchorPlan` delega essa semântica quando há saga B formato 2, mantendo o plano `planned`. Atualizações de preparação/confirmation verificam a pausa na mesma transação e não a sobrescrevem por corrida. Depois que `remote_started=1` é marcado conservadoramente antes do begin, cancelamento continua recusado; retry continua a mesma B.

**Lifetime:** o bundle permanece durável durante preparação e staging, inclusive em `prepared` ou pausa. Este PR não implementa cleanup. Condição futura segura: ativação B e instalação local (binding/profile, secrets e dados selecionados) totalmente finalizadas e verificadas de forma durável, incluindo a recuperação de crashes nessa fronteira. Somente o próximo fluxo poderá definir e executar sua remoção; `prepared` não é essa condição.

## Staging remoto

Rotas POST `/v1/vaults/:vaultId/epoch-staging-{begin,batch,validate,prepare,status}` usam owner OIDC habilitado + autorização PR #9 persistida e owner do challenge. Request tem exatamente formatVersion/vaultId/restoreId/action/payload/signature; a signing key nova B assina domínio `LionPocket/epoch-staging-request/v1`. Não exige proof HTTP normal do epoch ativo. Login sozinho, signing key A ou outro owner não bastam.

B existe exclusivamente em `sync_epoch_staging`, `sync_epoch_staging_batches`, `sync_epoch_staging_commits`, `sync_epoch_staging_operations`, `sync_epoch_staging_heads`, `sync_epoch_transitions`. Nenhuma linha de geração B é inserida em sync_generations; `requireActiveGeneration(B)` falha. Estados uploading → validated → prepared não incluem active. Locks PostgreSQL do vault serializam begin/batch/prepare; PKs/FKs/uniqueness complementam os locks. Triggers proíbem update/delete de bytes aceitos e substituição de artifacts finais.

Begin verifica pin B no mesmo server/vault/authority, founder e public keys novos, registry B inicial, key-base monotônica, history A assinada, recoveries A/B assinados e versão monotônica, autorização exata e plan commitments. Uma autorização aceita somente uma reserva; alteração de artifacts válidos é `idempotency_mismatch`.

Batch tem batchOrdinal/firstOrdinal/lastOrdinal int64 textuais e envelopes canônicos exatos como strings. Limites: 100 commits/batch, 1000 operações/batch, envelope financeiro até 1 MiB (limite v1 existente), request até 4 MiB, máximo 100000 batches. O cliente divide também por bytes e persiste antes do upload. Device sequence começa em 1 e segue o ordinal causal, um commit por revisão; IDs/objectId/parents são exatamente os mappings v2. Payloads usam primitives normais wire-v1 para nonce, AD, AEAD e assinatura.

Servidor verifica canonical bytes, assinatura B, scope/IDs/sequence/key/registry, limites, duplicatas, parents já disponíveis no mesmo attempt/objeto e ordem causal. Não aceita parents A ou outro attempt. Deriva heads ao inserir operações e rederiva do grafo ao validar, conferindo também o índice de heads. Counts e digest chain são recalculados dos bytes armazenados em páginas limitadas; contadores int64 nunca viram Number.

### Compromissos exatos

Todos os hashes são SHA-256 UTF-8 base64url sobre canonicalStringify:

- authorizationSha256: autorização PR #9 completa assinada.
- registrySha256: array completo dos grants B assinados, o mesmo objeto no begin.
- keyCheckpointSha256: EpochKeyBase completo assinado.
- recoverySha256: SignedRecovery B completo (envelope e signature).
- archiveSha256/mappingSha256: exatamente os compromissos locais do planner/archive v2.
- envelopesSha256: começa em `{context:"LionPocket/epoch-staging-envelopes/v1",restoreId,vaultId,fromEpoch,toEpoch}`; cada entrada hash de `{context:"LionPocket/epoch-staging-envelope-entry/v1",previousSha256,ordinal,batchOrdinal,commitId,envelopeText}`. Compromete ordem, batch e bytes exatos, incluindo nonce/signature.
- headsSha256: domínios `epoch-baseline-heads/v1` e `epoch-baseline-head-entry/v1` já usados no plano, mesma scope, ordenação objectId/revisionId e conjunto derivado.

`fixtures/epoch-staging.json` congela genesis, assinatura, digest chains e RecoveryBundle v2/AEAD com seeds públicas de teste. Ed25519 é conferida independentemente com Node/OpenSSL; recovery com sodium.

Depois de todos os batches, `epochBaselineManifestInput` fecha o manifesto real. Validate reconta envelopes/ops/batches, verifica signatures e metadata contra linhas públicas, parents, contiguidade, heads e todos os hashes observáveis. Archive/mapping são commitments do anchor, **não validação semântica financeira pelo servidor**. A equivalência local anterior e decrypt/replay de testes são a fronteira semântica.

Somente após validate, a helper assina EpochTransition pela mesma authority, verifica localmente contra artifacts/pins/authorization/chain tip confiável e envia prepare. Transition imutável em estado prepared; retry byte-idêntico não duplica nada. Nenhum logPosition/receipt ativo é inventado. Resposta preparada é conferida antes do save local. Tip anterior do cliente é explicitamente confiável; servidor procura transition previamente persistida terminando no pin A, não aceita tip arbitrária de request.

Backup/restauração de uma tentativa preserva seus epochs/identity/bytes. Uma tentativa já aceita pode continuar no target original após um restore operacional registrado desse target para o ambiente novo; não pode criar outra identidade nem retargetear A→C. Um target preparado diferente do ambiente retorna `readyForActivation:false`. Definir a futura ativação e resolver a continuidade operacional permanece fora deste PR.

**B ainda não está ativa.** Não há cópia para sync_commits, substituição de pin/grants/heads/binding A, sync normal B, eliminação de A, supersede/transmissão da outbox A ou recuperação C3. A activation transaction continua trabalho futuro.

## Operação self-hosted e backups

O ledger PR #9 continua com `sync_restores`, `sync_restore_vaults`, `sync_epoch_challenges`, `sync_epoch_authorizations`. `lpctl restore` preserva esse ledger num journal externo durável antes de substituir bancos, mescla estados monotônicos e gera novo epoch. Um cofre A ainda pendente não pula para C; autorização anterior não é apagada por restore antigo. Não existe comando administrativo de ativação.

Backup operacional produz manifesto **v4**, conservando generationArchiveSha256/restoreLedgerSha256/checksums dos dumps e acrescentando `stagingSha256`. `pg_dump` preserva attempts, batches, commits/ops/heads, manifestos e transitions prepared. Domínio do digest operacional novo: `LionPocket/operational-staging-backup/v1\n`, tabelas/PKs e linhas canônicas paginadas em ordem, incluindo ciphertext/bytes exatos e fases incompletas.

`verify-backup` continua sem mutações na instalação ativa: restaura dumps em bancos temporários, confere o digest e executa o verificador Node em `BEGIN READ ONLY` nesse banco. Verifica schema/triggers, autorização/owner/referências, signatures de registry/key/recovery/envelopes/transition, contiguidade dos batches, grafo/heads/counters/hashes e cadeia final prepared. Incomplete permanece incomplete; prepared permanece prepared, nunca active. Não há DEK nem decrypt.

Manifestos v1/v2/v3 continuam aceitos com seus contratos/digests anteriores. A nova verificação de staging é exclusiva do v4. Schema parcial não é backup v4 válido. Migração de cofres legacy não exige onboarding novo. Checksums não substituem autenticação externa do backup. O verifier não é oracle de plaintext financeiro.

## Validação e limites da evidência

Veja [evidência da preparação operacional B](self-hosted-operational-b-validation.md), [evidência do planner PR #11](self-hosted-anchor-generation-validation.md) e [evidência PR #9](self-hosted-epoch-recovery-validation.md), que permanecem históricas.

O recorte inclui preparação real até prepared após persistência dos secrets, encrypted replay C1+C2, conflitos/tombstones, pairing/rotation base N, retry de bytes, autenticação/tampering, PostgreSQL/Keycloak, backup v4 e ensaios isolados. O bloqueio pré-secrets foi removido pelo bundle durável; faults de todas as escritas convergem sem regenerar B. Não há ativação, instalação de binding B, segundo aparelho recuperado, integração nativa de UX/backup Android ou E1→E2 operacional completo.

`protocolVersion=1`, `domainSchema=1` e wire financeiro permanecem. Discovery é `epochRecovery:{formatVersion:1,authorizationAvailable:true,stagingAvailable:true,activationAvailable:false}`. As decisões do Vault/Visão e Decisões não foram alteradas.
