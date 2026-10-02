# Recuperação após restore do mesmo servidor

## Estado desta implementação

**Rebase causal verificável do aparelho âncora; ainda não existe geração B ativa.**

Este incremento parte de `eb215897286845f0b632def359b4a4b9f848a2dd` (main após PR #10). PR #9 entregou autorização de preparação; PR #10 entregou generations, archives, backup/journal/mapping e contratos de manifesto/`EpochTransition`. O planner v2 substitui o baseline de heads como raízes pelo fechamento causal completo necessário, com replay financeiro antes de `planned`.

O critério de transformação **do grafo local sincronizável** é validado para o recorte descrito abaixo. O critério de retomada operacional ainda não está atendido: não existem staging, nova identidade/key/recovery/registry B, ativação, binding B ou sync B. Discovery mantém `activationAvailable:false`. Foreground não chama os helpers. A continua bloqueada diante do epoch novo. Todas as evidências usam bancos sintéticos descartáveis.

Segundo aparelho e recovery sem SQLite antigo continuam pendentes; este PR não reconecta nenhum aparelho. O bloqueio heads-only demonstrado no PR #10 agora possui regressão positiva: ZB e os parents XB/YB conservam a base comum, o registro e o conflito. Dependencies históricas são reemitidas com seus ancestors, sem substituir seu alvo por um head mais recente. Dados sem interpretação segura continuam em review.

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

Parents B são os mappings dos parents A, ordenados como conjunto; dependencies B mantêm o object ID e apontam **à revisão histórica mapeada exata**, nunca ao head mais recente. Nenhuma edge B aponta para A. Commit planning continua um commit por revisão, sem compactação ou batching remoto. Série, slot, alias e prioridade continuam identidades lógicas.

### Schema, compatibilidade e compromissos

`recovery_journal.plan_format=2` distingue o plano causal. `recovery_revision_mapping` agora persiste `parents_b_json` e `is_head`, além de revision A/B, object, commit B, ordinal e payload B. Só os mappings dos heads A têm `is_head=1`; ancestors/dependencies não ganham status de head. Páginas de até 100 operações retornam exatamente esses parents/classificação.

`migrateAnchorPlan()` adiciona as colunas idempotentemente a um archive PR #10, preservando seu plano como formato 1. O planner, o consumidor e os compromissos **recusam formato 1**. `discardLegacyAnchorPlan()` descarta apenas esse mapping antigo e seus reviews, em transação, retorna a `archived` v2 e permite replanejar a mesma evidência. Nunca apaga archive A, backup, autorização ou profile. A imutabilidade do mapping é reinstalada na mesma transação. Um v2 já durável não pode ser convertido em v1. Review v2 ainda exige uma tentativa/snapshot explícito futuro; não se edita archive selado.

`anchorPlanCommitments` usa domínio mapping v2 e compromete ordinal, revision A/B, object, commit, **parents B ordenados, head/non-head** e hash do payload, que inclui dependencies B. Alterar parent muda o digest. `headsSha256` compromete somente heads finais. O contrato `EpochBaselineManifest` já contém `mappingSha256`; manifesto/transition e vetor contratual não precisaram mudar. Nenhum manifesto é persistido ou ativado.

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

**Ainda não existe geração B ativa.** Discovery continua `activationAvailable:false`. Nenhum seed signing/box, data key, recovery, registry operacional, binding B, staging/upload/manifesto remoto, ativação ou sync B foi criado.

## Manifesto B e prova final separada

O protocolo acrescenta o contrato público `EpochBaselineManifest`, com format/scope/restore/anchor, digest da autorização, registry, key checkpoint, recovery, archive e mapping; contagens int64 textuais de commits/operations/batches; compromisso ordenado dos envelopes e dos heads. O digest usa JSON canônico UTF-8 com domínio `LionPocket/epoch-baseline-manifest/v1`. Não aceita snapshots, secrets ou campos extras.

`EpochTransition` tem domínio obrigatório **`LionPocket/epoch-transition/v1`** para Ed25519 detached. Vincula server/vault/from/to/restore/authority, digest da autorização PR #9, estado restaurado, manifesto, TrustPin B, registry/checkpoint/recovery B, archive/mapping e `previousTransitionSha256` (null na primeira). O hash de encadeamento usa `LionPocket/epoch-transition-chain/v1` sobre a transition completa assinada.

A helper de verificação confere assinatura, compromissos, pin A confiável, pin B distinto no mesmo vault/authority e tip anterior já verificado. A preparação não pode substituir a assinatura final. A→B→C em testes contratuais compromete A→B e recusa omissão/fork/salto. O caller deve validar a cadeia inteira confiável e a semântica dos artifacts/staging antes de considerar ativação: o verificador de compromissos **não valida ciphertext financeiro nem declara recovery/key/registry prontos**.

`fixtures/epoch-transition.json` e `tools/epoch-recovery/generate-transition-vector.cjs` congelam bytes, hashes e assinatura com Node/OpenSSL, independentemente dos adapters sodium. São seeds públicas e artifacts de compromisso **somente de teste**, não registry/key/recovery de produção. Contagens maiores que `MAX_SAFE_INTEGER` evitam coerção numérica acidental.

Não há rota para publicar ou ativar uma transition, nem tabela de transitions finalizadas neste draft. Esses contratos são revisáveis em draft antes de qualquer produção. O ledger continua auxiliar; não é a cadeia criptográfica final.

## Staging, identidade, chave, recovery e saga: pendentes

Não há staging remoto nesta implementação. O próximo passo precisa de begin/batches imutáveis idempotentes/validate/manifest/prepare, vinculados a restore/vault/owner/autorização/anchor B, com uma tentativa concorrente por autorização. Assinaturas, escopo, keyVersion, grafo público B, contagens, hashes e completude precisam ser validados sem plaintext. Não usar bootstrap nem `/commits` normal para essa preparação.

A identidade operacional B deve ser nova (device/signing/box), mantendo serverId/vaultId/authority. Registry inicial só anchor, grants novos pela authority, chaves A preservadas. A chave ativa B deve ser nova e monotônica (`activeKeyVersionA+1`), com checkpoint/delivery exclusivo ao anchor e scopes próprios. A inicialização dessa cadeia ainda precisa resolver as assumptions atuais de `TrustPin.keyVersion=1` e checkpoints que começam em 2; não transportar uma cadeia/checkpoint A como se fosse B.

Recovery B deve existir confirmado antes de ativar: reembrulhar com master previamente confirmado, mantendo o mesmo código, ou apresentar código novo e exigir redigitação. Deve conter scope/authority/registry e keys corretos, com versão monotônica. Nenhum código é alterado por este draft; recovery B/abertura em instalação limpa **não foram implementados nem testados**.

A saga completa deve persistir profile B público, estado dos scopes/segredos (sem material privado), tentativa/staging, manifesto/transition e activation state. Depois de ativação PostgreSQL atômica, deve verificar a transition ativa e retomar instalação SQLite/profile após crash, sem nova baseline. Não há activation transaction nem instalação B aqui; nenhum crash posterior a ativação pode ser anunciado como coberto. Nunca apagar A nem fazer “cancelar” voltar para A depois da ativação.

A outbox A não é transmitida em B e não recebe marca de superseded nesta preparação. Uma implementação futura só pode marcar efeitos com evidência suficiente, preservando envelopes/receipts. Reviews/drafts fora do grafo não são migrados silenciosamente.

## Operação self-hosted e backups

O ledger PR #9 continua com `sync_restores`, `sync_restore_vaults`, `sync_epoch_challenges`, `sync_epoch_authorizations`. `lpctl restore` preserva esse ledger num journal externo durável antes de substituir bancos, mescla estados monotônicos e gera novo epoch. Um cofre A ainda pendente não pula para C; autorização anterior não é apagada por restore antigo. Não existe comando administrativo de ativação.

Backup operacional agora produz manifesto **v3**, acrescentando `generationArchiveSha256` ao digest do ledger v2 e aos checksums dos dumps sync/IdP. `pg_dump` inclui índice/tabelas ativas/archives e evidência de autorização. `verify-backup` continua read-only para a instalação: restaura ambos os dumps em bancos temporários, valida referências/geração selecionada/selo/positions/parents/heads e hash dos bytes dos envelopes arquivados, e calcula o compromisso em páginas de 100. Confere o digest v3 antes do ensaio de novo epoch. Falha limpa os bancos temporários e não modifica segredos/configuração/serviços ativos.

Manifestos v1/v2 continuam aceitos explicitamente. Ausência total de estrutura de gerações é legacy, mas presença parcial ou arquivo inconsistente falha. Atualização da API migra estado legacy sem onboarding novo. Os checksums não substituem autenticação externa do backup, e a ferramenta não interpreta finanças ou verifica signatures pela authority. Staging/transitions futuros precisam ser incluídos quando existirem; não estão disfarçados como campos já persistidos.

## Validação e limites da evidência

Veja [evidência deste draft](self-hosted-anchor-generation-validation.md). A [evidência PR #9](self-hosted-epoch-recovery-validation.md) permanece histórica, com seus próprios limites.

Entregue: normal sync/cliente anterior, arquivo remoto transacional e imutável, SQLite backup/arquivo/mapping, C1+C2, tombstone/branches no plano, reviews, paginação, rollback/retry de preparação, contratos finais/chaining, clean-install/backup/verify/restore operacional e canários. **Não entregue:** geração B ativa, nova proteção B, staging/upload, activation replay/concurrency, instalação/saga B, todos os fault points posteriores ao planejamento, integração financeira E1→E2→E3, UX funcional de recuperação.

`protocolVersion=1`, `domainSchema=1` e wire financeiro normal permanecem iguais. Discovery continua `epochRecovery:{formatVersion:1,authorizationAvailable:true,activationAvailable:false}`. As decisões do Vault/Visão e Decisões não foram alteradas: local-first, causalidade sem relógio, revisão explícita e autoridade do usuário permanecem necessárias.
