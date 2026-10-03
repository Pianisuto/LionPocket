# Activation crash-safe do aparelho âncora

Base exata: `a42613567d2748db46b76c6aaef7e1d92cf7c5ba`, main após merge do PR #12. Fixtures descartáveis, dados sintéticos e adapters SQLite reais desktop/Android. Nenhuma decisão do Vault, identidade permanente de assinatura Android, canal de distribuição ou versão do wire financeiro foi alterada. Nenhuma release/imagem foi publicada.

## Contrato e consentimento

`EpochActivationRequest` v1 contém exatamente `formatVersion`, `activationId`, `serverId`, `vaultId`, `restoreId`, `fromEpoch`, `toEpoch`, `anchorDeviceId`, `manifestSha256`, `transitionSha256`, `signature`. UUIDs são v4 canônicos; digests SHA-256 são base64url de 32 bytes e assinatura Ed25519 de 64 bytes. A assinatura cobre JSON canônico `{context:"LionPocket/epoch-activation-request/v1",request:<campos sem signature>}`. Não há timestamp como identidade.

O anchor gera activationId por CSPRNG e persiste request canônico, digest, commitments, epoch esperado, bindingId novo e snapshot financeiro na saga **antes de qualquer consulta/chamada remota**. Retry e status usam os mesmos bytes. A preparação não ativa automaticamente. A interface exige **Ativar sincronização recuperada**, com o texto: “Depois desta etapa, o servidor passará a usar os dados reconstruídos deste aparelho como nova base de sincronização.”

Rotas POST `/v1/vaults/:vaultId/epoch-activation` e `/v1/vaults/:vaultId/epoch-activation-status` usam owner OIDC mais assinatura do anchor preparado, sem o normal HTTP proof. Revalidam restore, tentativa preparada, autorização original e EpochTransition assinada pela authority original. Login e `lpctl` não substituem essas provas; não existe comando operacional de force activation.

Status é `prepared`, `active` ou `mismatch`. `active` contém o request sem signature, `requestSha256`, `trustPinSha256`, `logPosition`, `commitCount` e `operationCount`. Não inclui finanças/secrets. O cliente revalida transition local, manifesto, pin B e todos os campos/commitments remotos; a palavra `active` isolada não autoriza instalação. Discovery `activationAvailable:true` indica suporte ao protocolo; não indica prontidão de um vault.

## Fronteira PostgreSQL

Uma única transação bloqueia vault, environment, restore, restore-vault, staging, transition e generations. Owner issuer/subject e vaultId são preservados. Antes de qualquer substituição, revalida artifacts, key base assinada, registry, Recovery, origem selecionada e archive selado; compara todas as tabelas ativas antigas com o archive. Qualquer divergência aborta integralmente.

Na mesma transação, remove heads/operations/commits/bindings/deliveries/pairings/grants na ordem de FKs, instala exatamente registry B (um founder aprovado), pin/base_key_version/active_key_version/Recovery B, checkpoints de rotação vazios sob a nova base e `rotation_required=false`. Não há DEK no servidor. Pairings/deliveries/bindings começam vazios. Promove os envelopes exatos persistidos no staging; não recria ciphertext, nonce, assinatura ou IDs.

Cada envelope passa pelo **mesmo `acceptCommit()` do push normal**, com registry B. Ordinal numérico 1…N vira logPosition 1…N; o vault termina em N. Isso gera receipt `accepted` com digest exato, acceptedRegistryVersion 1 e heads dos objetos tocados naquele ponto, conforme a evolução causal. O auditor de backup reproduz essa evolução independentemente. Corrigida também a ordenação anterior do staging que usava o alias textual do ordinal e falhava a partir de dez commits.

A geração antiga muda `active → archived`; a nova é inserida `active`, sob o índice único parcial existente por vault. Ninguém observa a troca intermediária fora da transação. `archive_*` não recebe alterações; staging/transitions preparados continuam imutáveis. `sync_epoch_activations` separado registra request canônico/digests, escopo, commitments, activated_at de auditoria e logPosition final; triggers recusam UPDATE/DELETE. Constraints únicas `(restore_id,vault_id)` e `(vault_id,to_epoch)`, junto dos row locks, serializam concorrência sem mutex em memória.

Um retry exato devolve o mesmo record, sem reinserir log/receipts. Outro request assinado para a mesma tentativa recebe `idempotency_mismatch` (status `mismatch`). Duas intenções diferentes válidas concorrentes produzem uma única activation; a que obtiver o lock e commitar reserva a tentativa, e a outra é recusada. A durabilidade da intenção do cliente é indispensável: ele nunca gera uma segunda activationId em retry.

Depois do COMMIT não há rollback automático. Proofs, commits e changes antigos permanecem recusados (`epoch_changed`). A UI não oferece Cancelar; oferece **Continuar finalização**. Helpers de cancelamento recusam abandonar/deletar secrets depois que existe uma intenção durável, conservadoramente também durante ambiguidade de resposta. Operações normais que alterariam profile, recovery ou chaves também são recusadas enquanto a activation estiver incompleta. Depois de outro restore, o marcador recovered anterior é tratado como histórico e a UI oferece a nova preparação.

## Instalação local e startup

Preparação mantém sua própria saga até `prepared`. A saga de activation é separada:

`activation_requested → remote_active → installing_local → local_db_installed → profile_installed → finalizing → recovered`.

No restart antes do foreground, uma intenção pendente consulta status e, se ainda prepared, reenvia o mesmo request. Depois de remote_active, revalida bundle/materializações, profile B público, Recovery, manifesto, transition, record remoto, mapping/causal closure, ciphertext local e sua decriptação/assinatura. SQLite A e finanças devem continuar correspondendo ao archive/plano; divergência bloqueia instalação, sem descartar alterações. Revalida o backup original e cria/reabre um segundo checkpoint consistente com journal `remote_active`, integridade, FKs e SHA-256, selado com fsync de arquivo/diretório.

Uma transação SQLite específica reconstrói o DAG em tabelas TEMP pelo importer/projetor normal. Copia o grafo verificado para sidecars operacionais, sem projetar sobre as tabelas financeiras main. Instala revisions, heads, tombstones, revision origin e conflitos B. Limpa transport/erros/reviews antigos do estado operacional, preservando-os no archive; instala um marker de active key B para que o sync normal não reemita baseline como se fosse uma rotação. `sync_identity`, `sync_series`, `sync_slots`, `sync_import_provenance` e `sync_aliases` permanecem byte/canonical-equivalent, inclusive fixtures não vazias. Object/global IDs e local_id não mudam.

Tabelas financeiras e sidecars lógicos são comparados registro a registro antes/depois dentro da transação. Nenhum trigger financeiro cria outbox durante instalação. A outbox antiga permanece somente no archive, com seus bytes; baseline B já aceita não entra na outbox. `sync_inbox` recebe cada envelope exato, commitId, logPosition, state `applied` e acceptedRegistryVersion 1, tornando rechecagem idempotente.

Na instalação, `received_cursor=applied_cursor=commitCount`, `pull_upper_bound=null`, `device_seq=commitCount`. `local_seq=operationCount` usa a ordem causal do mapping/importer (hoje um commit por operação preparada). O próximo write continua N+1 monotonamente, com teste explícito. BindingId novo mantém endpoint/serverId/vaultId, usa epoch/device/pin/registry/checkpoint B; binding A permanece no archive. O primeiro `/changes` normal cria o remote binding B e aceita cursor no fim da baseline, retornando zero commits se não houve novo push.

SQLite registra `local_db_installed` e continua pausado; só então profile B é salvo no mecanismo normal de storage/config e relido canonical-equivalent. Startup retoma DB A/remote ativo, DB B/profile A ou profile B/marker ausente. Coordinator recusa saga pendente e aguarda terminar inclusive o tail de um pass abortado antes da recuperação, evitando profile save antigo concorrente. Primeiro pull normal é executado sob B enquanto foreground ainda está excluído; `recovered` e despausa são duráveis juntos. Só então foreground volta. Sem sessão OIDC reutilizável no restart, finalização remota/pull aguardam login explícito; abertura/uso local continuam possíveis.

Não há cleanup/GC neste PR: bundle privado, backups, archives, mapping, envelopes, transition e journals permanecem disponíveis depois de recovered. Segundo aparelho não é instalado/migrado.

## Evidência executável

| Requisito | Evidência |
| --- | --- |
| Domínio próprio, canonical/strict parsing, assinatura Ed25519 independente | `packages/sync-protocol/src/epoch-activation.test.ts` |
| Consentimento durável, binding novo, cursors/seq, finanças e archives preservados | `apps/desktop/src/main/sync/epochPreparation.test.ts`, ambos adapters SQLite |
| 14 pontos de falha × desktop/Android (28 reinícios reais) | mesma suíte: request persistido, resposta remota, remote_active, checkpoint, antes/durante/depois SQLite, antes/durante/depois profile save, coordinator, antes/durante/depois primeiro pull |
| Status falso/digests/pin/scope/count adulterados recusados antes de instalar | mesma suíte, oito campos adulterados, seguido de retomada válida |
| Z→X/Y, base comum ZB, conflito aberto, delete/edit e tombstone sem ressuscitar | mesma suíte de preparação e instalação B, importer/projeção real |
| Series/slots/aliases/import provenance não vazios preservados | mesma suíte; recorrência/slot promovido/proveniência de import |
| Uma transação PG, oito falhas pré-COMMIT e perda da resposta de sucesso pós-COMMIT | `apps/sync-server/src/epochRecovery.integration.test.ts`; snapshot completo antes/depois, status exato e retomada |
| Dois requests idênticos concorrentes e dois IDs distintos concorrentes | mesma integração, row locks/constraints; segundo caso em pg_dump/pg_restore isolado |
| Owner OIDC/assinatura inválidos recusados, A bloqueada após ativação | mesma integração com PostgreSQL/Keycloak reais |
| C1 antes do backup, C2 perdido no restore e preservado pelo anchor; B operacional | mesma integração: primeiro pull zero, C4 local-first → push/receipt log N+1/outbox acknowledged, pull subsequente |
| E1→E2→E3 real e sync normal nas duas gerações | mesma integração, controller nativo na segunda recuperação; objeto de 12 revisões, receipts com heads distintos e novo push E3 |
| Backup ativado, log posterior à baseline, receipts/graph/metadata e corrupção recusada | mesma integração e `activationBackup.ts`: READ ONLY; receipt e environment adulterados recusados |
| Backup v5 paginado/activation commitment e install normal sem restore | `tools/self-hosted/test_activation_backup.py`, suíte lpctl e clean-install |
| lpctl backup/verify/restore E1→E2→E3, TLS/contas, anchor recuperado e segundo aparelho antigo | `tools/self-hosted/smoke.py` / `contract.mts`; dois restores físicos e duas activations |
| API, Keycloak e PostgreSQL completamente parados após recovery; save/outbox/restart/drain | mesmo clean-install; operações locais não dependem de rede/login |
| Sem plaintext/valor/code/seeds/DEK/bundle no servidor, logs ou manifestos | canários na integração PG e clean-install antes/depois activation; snapshots locais privados preservados |
| Checkpoint Android app-private selado, integrity/FK/pin/plan/journal e path validation | `apps/mobile/src/sync/epochBackup.test.ts`, SQLite real; `DurableBackupFileTest.kt` nativo no emulador readiness |
| Exclusão do tail do coordinator antes de instalar profile B | `packages/sync-local/src/coordinator.test.ts` |
| Cliente anterior/normal wire inalterados | `tools/release/version-skew.cjs` com os clientes reais anteriores |

Falhas remotas pré-COMMIT: before_lock, after_lock, after_validate, after_first_delete, promoting_commit, after_vault_update, after_generation_swap, before_commit. Todas deixam A selecionada e tabelas iguais. O hook after_commit suprime a resposta de sucesso (retorna falha temporária); B está inteira, status/retry recuperam a mesma activation. Hooks são opções do harness, sem endpoint ou configuração de produção para injeção.

## Backup e validações

Manifesto operacional **v5** acrescenta `activationSha256` a ledger/generation/staging commitments e dumps completos. `verify-backup` continua READ ONLY na instalação ativa; em bancos temporários verifica exatamente uma geração ativa e pin, coerência com environment (ou restore pendente legítimo), origem archived/sealed, transition/manifests, baseline byte-identical ao staging, log contíguo, receipts em sequência, heads/operations, registry/Recovery/key metadata e pushes posteriores. Audita também generations alvo de activations antigas que já foram arquivadas numa recuperação seguinte.

Verificações locais: npm test, typecheck, lint, diff check, PostgreSQL/Keycloak, clientes anteriores, self-hosted clean install/backup/verify/restore/offline/canários e compilação Kotlin/debug instrumentation. Jobs existentes do PR executam Linux normal/beta, Windows normal/beta e Android/emulador, sem publicação. Resultado/HEAD final de CI ficam registrados no PR; esta página não antecipa verde remoto. O preview visual conferiu textos/botões prepared e finalização; é fixture visual, não evidência de login nativo.

## Limites

- Segundo aparelho continua com SQLite/profile/outbox antigos e `epoch_changed`. C3 offline fica intacto nele; não é incluído automaticamente no anchor.
- Recovery sem aparelho antigo, reconexão de outros aparelhos, Cloud público e background sync Android permanecem fora do escopo.
- Mismatch financeiro/sidecars após preparação, secrets ausentes, artifacts/backup adulterados ou servidor diferente bloqueiam finalização e foreground. Não há merge/rollback improvisado nem avanço de cursor sem prova.
- Retomada automática pode precisar da ação **Continuar finalização** para autenticar. Após B instalada, saves offline continuam criando outbox B; ela só é enviada quando o normal sync volta.
- Os testes de crash simulam interrupções nas fronteiras duráveis e rollback transacional, com fechamento/reabertura de SQLite. Não alegam testar falha física de armazenamento ou todos os kernels/dispositivos Android.
- Compilação e fixture nativa não substituem uma auditoria criptográfica independente. Nenhum aparelho/dado real do usuário foi usado.
