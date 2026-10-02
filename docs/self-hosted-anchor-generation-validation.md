# Evidência do rebase causal do anchor

Execução local em 2026-10-02, branch `codex/causal-anchor-rebase`, base main `eb215897286845f0b632def359b4a4b9f848a2dd`, após PR #10. Bancos, contas, autorizações, devices e servidores são sintéticos e descartáveis. Não foi aberto banco pessoal nem instalada atualização em aparelho pessoal.

**Resultado: o plano v2 conserva o DAG sincronizável necessário e passa pelo replay financeiro normal antes de `planned`. Ainda não existe geração B ativa.** Discovery mantém `activationAvailable:false`; não foram criados signing/box seeds, data key, recovery, registry operacional ou binding B, staging, upload, manifesto remoto ou ativação.

O [modelo de fechamento, mapping, replay e reviews](self-hosted-epoch-recovery.md) descreve o recorte. A autorização/archives/backup do PR #10 continuam válidos; seu planner de heads como raízes foi substituído.

| Verificação | Resultado local |
| --- | --- |
| `npm test` | 407 passaram; 33 condicionais de integração separados |
| Desktop private beta, timeout/hookTimeout de 30s | 153 passaram |
| `npm run typecheck` | Todos os workspaces/harnesses passaram |
| `npm run lint` | Zero erros; warnings de non-null assertions/regras existentes |
| `git diff --check` | Passou |
| `npm run release:validate` | 0.3.10 / Android versionCode 3 |
| `npm run sync:dev:test` | PostgreSQL/Keycloak: 61 passaram; cliente anterior executado separadamente |
| `node tools/release/version-skew.cjs` | 3 passaram, engine/controller anterior de `8de0087cdbcdcc670ec2073ba3f4ea51932072b4` sem alteração |
| `npm run sync:self-hosted:validate` | Compose/TLS/CA/proxy com fixtures externos passaram |
| `npm run sync:self-hosted:test` | 21 unitários; clean install/normal sync/backup/verify/restore/TLS/offline/canários passaram |

A execução padrão encontrou o timeout de 5s do teste preexistente de falha deliberada de backup de migration: SQLite pode esgotar seu busy timeout nativo nesse caminho inválido. O deadline desse teste foi aumentado para 30s, preservando todas as assertions. Depois disso a suíte completa passou. Não foi alterada a implementação de migrations financeiras.

## Regressão obrigatória e conflitos

O teste que demonstrava X/Y roots perdendo Z agora exige ZB com `restoredFrom=Z`, XB/YB com parent ZB, exatamente dois heads, common base ZB, transação presente e conflito aberto na projeção SQLite normal. Usa banco de destino descartável e `applyCommit` existente, sem criptografia ou servidor B.

Os 43 testes de archive/planner cobrem:

- cadeia linear completa e exclusão de história desconectada não necessária;
- edit/edit, delete/edit, três heads e branches com dois níveis;
- common base histórico A1; ausência de base única em raízes independentes e criss-cross com duas bases maximais;
- branches com devices diferentes A; heads B restaurados pelo mesmo anchor;
- automerge de grupos que seria possível no anchor, mas permanece aberto com heads restore;
- resolução explícita; automerge normal volta a funcionar com novos heads locais e ancestors restore;
- dependency em head, C1 histórico não-head com C2 atual, e dependency transitiva C1→D1;
- rejeição de head, parent necessário e dependency necessária, sem desrejeitar;
- delete head, delete ancestor e preservação de tombstones/conflicts;
- tombstone desconectado, ressurreição proibida e authoredAt ambíguo entre deletes necessários mantidos em review;
- ciclos de parent, dependency e combinado; edges ausentes/estrangeiras e payload inválido;
- dirty uncaptured, inbox pendente/quarantine, identity unresolved e review desconhecido;
- colisão com revision/op A, commit A e colisão entre IDs novos;
- páginas de 100+7 revisões e stress de **4.000 revisões**, cadeia causal de 3.999 revisões mais um objeto independente;
- alteração do grafo local após archive bloqueada, sem substituir archive;
- retry sem substituir mapping durável; mesmo archive e UUID source determinístico gerando bytes/digests iguais;
- crash antes do selo, durante reserva e após todos os inserts do mapping, antes de `planned`, com rollback completo;
- schema PR #10 real de sete colunas, migração idempotente, recusa de formato 1, descarte/replanejamento sem alterar archive A;
- digest alterado por parent B; headsSha256 separado dos ancestors;
- backup SQLite que inclui o novo mapping e passa por inspeção/validação;
- metas, cards, séries, prioridades recorrentes/mensais, installment slots e aliases preservados no replay.

O stress é executado pelo planner completo, incluindo os dois replays commit a commit, sem recursão. A ordenação Kahn/min-heap usa causalidade, com UUID somente como desempate. A projeção linear consulta apenas o head, eliminando o scan repetido de toda a cadeia. O common-base puro usa parent ancestry linear por head; não usa dependencies como parents.

## Oracle semântico no próprio planner

A closure é lida do archive local selado por revision ID. Ambos os DAGs são reproduzidos em schemas TEMP vazios com definições financeiras/sidecars SQLite reais e o mesmo contexto de identities/series/slots/aliases. O importer e a projeção são os existentes. O replay B usa um único anchor, sem permissão de automerge para heads restore. O contexto A não concede nova permissão local de automerge às branches arquivadas.

As duas avaliações compartilham um clock de projeção fixo para timestamps auxiliares de cache, sem usá-lo para causalidade/vencedor; os authoredAt/audit dos payloads permanecem originais. A representação normalizada compara tabelas financeiras completas, heads, conflitos/base comum, tombstones, parent/dependency graph e sidecars de identidade/série/slot/alias/import. Revision IDs B voltam a A pelo mapping para comparação; IDs auxiliares de transporte/conflito não representam conteúdo financeiro. Nada é instalado nas tabelas financeiras principais. Savepoint rollback elimina a simulação inclusive em erro.

O cenário de prioridades encontrou uma identity de slot existente sem transação no cache vazio. A projeção normal agora materializa esse mesmo slot antes de inserir a prioridade, conservando local/global IDs e FK. O teste cobre a situação sem prepopular finanças do destino.

Failure de replay, novos heads auxiliares ou mismatch semântico deixam `review-required` com motivo explícito e sem mapping utilizável. Não se força projeção nem transforma blockers em warnings. Os helpers de recovery marcam seus workflows para impedir captura financeira incidental de dirty A no COMMIT desktop; workflows normais mantêm seu comportamento anterior.

## C1+C2 e Android offline C3

O cenário real PostgreSQL/Keycloak aceita C1, captura backup remoto, aceita C2 no desktop depois e mantém C3 no Android offline. Restore perde C2 remoto. Owner autoriza, cria backup/arquivo local e planeja v2: C1+C2 aparecem no mapping, com IDs novos e replay aprovado. O archive remoto não é usado para descobrir C2.

Snapshots de todos os sidecars/outbox/binding e perfil A permanecem iguais. Android continua no binding A, com C3/outbox A/SQLite financeiro intactos. Não há novo endpoint nem recuperação no foreground. Discovery e tentativa de activation continuam indisponíveis. O teste exige `phase='planned',plan_format=2` e preservação exata de A.

## Compatibilidade, CI e limites

`protocolVersion=1`, `domainSchema=1`, commits/changes v1 e backup self-hosted v3 permanecem iguais. Backup servidor não contém mapping local do cliente; backup SQLite contém e verifica a extensão. Plano antigo/incompleto nunca significa geração ativa.

`EpochBaselineManifest.mappingSha256` já compromete o novo digest causal v2. Manifesto, EpochTransition e vetor determinístico não mudaram; testes A→B→C e rejeição de A→C continuam passando. Nenhuma decisão do Vault/Visão e Decisões precisou mudar.

Os workflows do PR verificam Windows/Linux normal/private beta, packaged/installed Electron e Android debug/normal/private beta/upgrade. A tabela acima é evidência local; resultado remoto deve ser consultado no PR, sem alegação antecipada de sucesso.

Limites explícitos: tombstone desconectado, ressurreição e audit de deletes sem interpretação inequívoca permanecem em review. Grafos cujo cache/referências não podem ser materializados normalmente também bloqueiam. Review v2 ainda requer desenho futuro de nova tentativa/snapshot; somente planos v1 incompatíveis possuem descarte/replanejamento nesta implementação. Não há proteção operacional B, staging/activation, recuperação multi-device, instalação B nem saga pós-ativação. O futuro uploader deverá consumir o mapping causal e as mesmas identities/slots, sem compactação ou redefinição dos heads.
