# Recuperação após restore do mesmo servidor

## Estado desta implementação

**Draft — preservação de gerações e planejamento do aparelho âncora; ativação permanece indisponível.**

A base é `cfaf1ea99f56af2fa9c1ac23b429bd21f33320dc` (main depois do PR #9). O PR #9 entregou ledger e autorização de preparação. Este incremento acrescenta índice de gerações, arquivo remoto imutável, helper de backup SQLite aberto/hashado, arquivo local por tabela, journal de preparação, mapping durável e contratos separados de manifesto/`EpochTransition`.

O critério de retomada financeira **ainda não está atendido**. Não existem staging remoto, nova identidade/key/recovery B, ativação, instalação do binding B ou botão nativo de recuperação. Discovery e autorização continuam anunciando `activationAvailable:false`. Foreground não chama os novos helpers. As APIs normais continuam bloqueando A diante de B. Os helpers locais são exercitados exclusivamente com fixtures sintéticos, não instalados automaticamente nos bancos dos usuários.

**O fluxo futuro deste PR recupera apenas o aparelho âncora.** Segundo aparelho e recovery sem SQLite antigo permanecem pendentes; nenhuma parte deste draft reconecta qualquer aparelho.

### Bloqueio arquitetural novo, reproduzido em teste

A projeção atual (`projectObject` em `transport-state.ts`) usa a revisão de base comum para apresentar um objeto com conflito. Em A, X/Y podem compartilhar base Z e o objeto permanece disponível. Reemitir somente X/Y como raízes B mantém dois heads, mas retira Z do grafo ativo: a projeção encontra `base_revision_id=null` e oculta o objeto. O teste `demonstrates why normal projection cannot install a root-only conflict baseline yet` reproduz isso usando SQLite real: A possui projeção visível e dois heads; a aplicação normal de raízes equivalentes em B preserva as branches, mas não instala a transação visível.

Há um segundo aspecto do mesmo bloqueio: um head pode depender de uma revisão A histórica que já não é head. Reemitir essa revisão como raiz B adicional faz dela um head ativo; trocar a dependência para o head atual sem prova também altera seu significado. Tombstones históricos fora dos heads têm problema equivalente. Não se pode reutilizar IDs A nem escolher por timestamp.

Antes de habilitar ativação, é preciso definir e implementar um rebase de histórico/projeção que mantenha o contexto desses conflitos, as dependências históricas e os tombstones, sem produzir heads extras ou novas decisões financeiras. Uma possibilidade a avaliar é um checkpoint cifrado de projeção/conflito junto da baseline; outra é uma representação explícita de revisões auxiliares, com prova de fechamento do grafo. **Nenhuma dessas decisões foi improvisada neste draft.** O planner grava review para dependência/tombstone histórico; planos de heads suportados ainda não são instaláveis pelo caminho normal. A fronteira de epoch permanece fechada para todos os casos, inclusive os aparentemente simples.

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

O planner consulta **heads/revisões do arquivo local**, não varre tabelas visíveis. Para cada head com snapshot válido, reserva novo revision/op ID e commit ID B, mantém object ID, autoria/audit e identidade financeira, define parents B vazios, `provenance.origin='restore'` e `restoredFrom=revision A`. Exclusão continua exclusão; múltiplos heads produzem múltiplas branches, inclusive delete/edit. Não há escolha por timestamp, merge automático ou envelope A reaproveitado.

`recovery_revision_mapping` conserva A→B, object, commit B, ordinal e revisão B local. Uma transação reserva e valida tudo; crash durante mapping reverte o plano inteiro antes de qualquer publicação. Retry após plano confirmado reutiliza exatamente os IDs. O resultado é paginado, até 100 operações por página, e ainda não contém envelopes cifrados/transmissíveis.

Dependências que apontam para heads presentes no arquivo são mapeadas e ordenadas topologicamente. Dependência histórica não representável, tombstone histórico fora dos heads, ciclo, snapshot inválido, identity unresolved, inbox não aplicada/quarentenada, dirty write ou qualquer review não informativo produzem `review-required`, sem mapping parcial utilizável. Não se inventa prova. Informações de audit já reconhecidas pelo controller (`active_key_version`, `reemission_provenance`, `legacy_import_review_provenance`, `import_receipt:*`) não bloqueiam sozinhas.

`anchorPlanCommitments` calcula compromissos públicos paginados de archive/mapping/heads e contagem decimal, sem plaintext no resultado. Mapping acumula ordinal, IDs A/B/object/commit e hash da revisão B; heads acumulam pares `(objectId,revisionB)` em ordem lexical. **Esses compromissos não são um manifesto staged completo.** Envelope hash, registry/key/recovery B e completude remota continuam ausentes.

No teste integrado, C1 é aceito antes do snapshot PostgreSQL e C2 é aceito depois. Restore perde C2 remoto. Owner conserva C2 local, autoriza, faz backup e arquivo, e o plano novo contém semanticamente C1+C2. Os IDs novos diferem dos op IDs A; os envelopes/outbox A permanecem byte a byte iguais. Android offline conserva inclusive C3 e não envia nada. Isso prova preservação/planejamento, **não ativação nem sync normal B**.

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
