# Reforço mensal dos objetivos

O reforço mensal é um valor **planejado** para um objetivo em um mês específico (por exemplo, Notebook: R$ 500 em 10/2026 e R$ 700 em 11/2026). É planejamento, não movimentação: não cria lançamento ou despesa, não altera `savedAmount` nem o progresso do objetivo, não transfere dinheiro e não é copiado automaticamente para outro mês. Não há reforço recorrente.

A sugestão automática (`suggestedMonthlyAmount`) continua separada. O editor oferece **Usar sugestão** apenas como ação explícita que preenche o campo; nada é gravado até a pessoa salvar, e a sugestão nunca é salva sozinha.

## Uso e apresentação

Na tela **Objetivos**, os cards mantêm a aparência atual e ganham uma linha discreta de planejamento com o mês, o reforço do mês e a ação **Definir**, **Editar** ou **Remover**. O mês também mostra o total planejado para objetivos (“Planejado para objetivos em …”). A edição acontece em um formulário temporário com o valor, a sugestão (quando existe) e “Remover reforço”.

- **Desktop** reutiliza o mês global da barra existente.
- **Mobile** navega entre meses dentro de Objetivos (“Planejando o mês”). O mês global só define o mês inicial; o mês de Objetivos é um estado local da tela e navegar nele não altera Dashboard, Lançamentos nem as demais telas.
- Nas duas plataformas, se os reforços do mês não puderem ser lidos, a tela mostra o erro (Desktop com “Tentar novamente”; Mobile com o erro e puxar para atualizar) em vez de um total zerado, e não permite definir/editar reforços até o estado real ser conhecido.
- O Dashboard não muda.

## Modelo e persistência

O reforço é um dado mensal próprio: uma linha por objetivo e mês, em centavos inteiros. `GoalMonthlyReinforcement` (core) contém `goalId`, `month` (`AAAA-MM`) e `amountCents`. A tabela `goal_monthly_reinforcements` é igual em Desktop e Mobile: `id` (`goalId:mês`), `goal_id` (FK de `goals`), `month`, `amount_cents`, `created_at`, `updated_at`, `deleted_at`, com `UNIQUE(goal_id, month)` e `CHECK`s de mês e de inteiro não negativo.

Zero é um `put`, não um tombstone: remover o reforço mantém a identidade e permite redefinir o mesmo mês quantas vezes for preciso. Ausência de linha e zero têm a mesma apresentação e cálculo.

O core expõe `goalReinforcementPlan`, `totalGoalReinforcementForMonth` (total em centavos, pronto para o futuro “Livre agora”), `goalReinforcementAction`, `goalReinforcementNote`, `suggestionToReinforcementCents` e a validação, todos compartilhados pelas duas plataformas.

## Comportamento por status do objetivo

| Status | Define/edita | Conta como protegido | Observação |
| --- | --- | --- | --- |
| Planejado / Em andamento | sim | sim | Participa do total do mês. |
| Pausado | não (só remover) | não | Valor fica no histórico; a tela explica que não conta como protegido. |
| Concluído / Cancelado | não (só remover) | não | Nenhum reforço ativo novo; valor existente só pode ser removido. |
| Excluído | — | — | Os reforços do objetivo são encerrados na mesma transação; nenhum órfão nem valor fantasma. |

Retomar um objetivo pausado volta a contar o valor que permaneceu no histórico. A exclusão do objetivo é atômica nas duas plataformas, e o total também ignora reforços cujo objetivo não existe (excluído ou ainda não recebido por sync).

## Local-first, sync e desvinculação

O CRUD funciona completamente offline. Com sync, os triggers financeiros capturam a alteração junto do salvamento e publicam a entidade `goalMonthlyReinforcement`, snapshot `{goalId, month, amountCents}` (`goalId` é a identidade global do objetivo), pelo transporte E2EE/DAG existente. A revisão depende do objetivo, e a identidade no wire é um UUID v5 derivado da identidade global do objetivo e do mês: aparelhos diferentes chegam ao mesmo objeto para o mesmo objetivo e mês, independentemente dos ids locais, e a identidade sobrevive à desvinculação e a uma nova baseline.

- Dois aparelhos que editam o mesmo objetivo e mês com valores diferentes geram um conflito para revisão (o existente). Objetivos diferentes no mesmo mês não conflitam.
- Se o objetivo foi excluído em outro aparelho, a projeção encerra os reforços dele e ignora reforços concorrentes; nenhum registro órfão é criado.
- **Desvincular servidor preserva todos os reforços** e permite editá-los offline. Ao criar uma nova baseline (inclusive para outro cofre) ou reconectar um backup ao mesmo vínculo, as diferenças locais, incluindo zero, são capturadas.
- Replay/rebaseline de epoch incluem a entidade e conservam os snapshots.

### Compatibilidade fail-closed

O servidor anuncia o novo escopo `goalMonthlyReinforcement`. Protocolo, envelopes, criptografia e versões de protocolo/domain/control não mudam, mas o discovery é fail-closed: clientes anteriores rejeitam o escopo desconhecido com `unsupported_capability`, antes de receber revisões. **Servidor e todos os clientes vinculados precisam ser atualizados em conjunto**; não há negociação para rolling upgrade. Dados locais e pendências ficam preservados e o uso offline continua disponível durante a incompatibilidade.

## Migrations, backup e restauração

- Desktop **16** e Mobile **11**, a partir dos schemas do PR #21 (Desktop 15 / Mobile 10). Criam a tabela vazia e ampliam o `CHECK` de tipos de `sync_identity` com a reconstrução transacional de sidecars já usada; filas, envelopes, DAG, recibos e dados existentes são preservados.
- Backups SQLite incluem a tabela. O JSON completo do Desktop anuncia schema 16 e o conversor o mapeia para Mobile 11; JSONs anteriores (schema 15 ou menos) seguem importáveis e começam sem reforços. A importação aditiva agrega meses novos e aborta em conflito no mesmo objetivo e mês.
- O CSV continua contendo somente lançamentos.

## Cobertura

Testes de UI (`apps/sync-server/src/goalReinforcement.ui.test.ts`) cobrem o mês local do Mobile e a falha de leitura no Desktop e no Mobile. Testes cobrem: criar/editar/remover/redefinir; meses independentes; vários objetivos no mesmo mês e total mensal; sugestão diferente do reforço; `savedAmount`, progresso e lançamentos inalterados; planejado/em andamento/pausado/concluído/cancelado; exclusão de objetivo; Desktop e Mobile com os mesmos casos; backup, JSON, merge e conversão; os upgrades reais a partir do Desktop v15 e do Mobile v10 (com rollback tardio); sync bidirecional, identidade estável, conflitos, objetivo excluído em outro aparelho, desvinculação, nova baseline, reconexão, replay de epoch e as fixtures nativas. O caso com servidor real (`pairing.integration.test.ts`) exige Postgres. Testes com `node:sqlite` não substituem o Nitro SQLite no Android, e Windows instalado exige um host Windows descartável.

Fora do escopo: Livre agora, análise temporal, reserva ou transferência automática, alteração automática de `savedAmount` e reforço recorrente.
