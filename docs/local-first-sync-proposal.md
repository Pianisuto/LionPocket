# Proposta de sincronização local-first — LionPocket

**Data:** 30/09/2026. **Estado:** proposta para revisão; não é uma implementação nem uma decisão já aprovada. **Base examinada:** monorepo no commit `276b304`, desktop 0.3.9 e mobile com schema v5.

## 1. Objetivo e limites

Sincronizar uma base financeira pessoal entre desktop e Android, preservando o SQLite como banco de trabalho de cada cliente. O servidor recebe alterações duráveis, distribui versões e autoriza acesso; abrir o app, consultar, lançar, planejar, importar, exportar e fazer backup continuam possíveis sem conta, internet ou servidor.

A direção vem de `/home/lvulczak/Documentos/Obsidian/Pessoal/Lion Pocket/Visão e Decisões.md`: monorepo com domínio compartilhado, Android bare React Native, backend opcional, self-hosting e Lion Pocket Cloud com o mesmo protocolo, código sob `AGPL-3.0-only`. Esse arquivo permanece como fonte das decisões de produto e não foi alterado.

Este bloco não implementa notificações push, Open Finance, conciliação bancária, compartilhamento familiar, anexos ou cobrança. Enviar alterações por HTTPS é parte do sync. Assinatura Cloud, expiração de sessão ou indisponibilidade do servidor nunca bloqueiam o banco local. Sync também não substitui backup: uma exclusão válida pode chegar a todos os dispositivos.

**Recomendação central:** identidade global adicional, outbox transacional, revisões imutáveis com ancestralidade explícita, tombstones e conflitos preservados, com conteúdo financeiro criptografado ponta a ponta. Começar com lançamentos manuais sem vínculos, dois dispositivos e sincronização acionada pela pessoa.

## 2. Situação real do monorepo

| Área | Evidência atual | Consequência para o sync |
| --- | --- | --- |
| Estrutura | `apps/desktop`, `apps/mobile`, `packages/core`; npm workspaces; sem backend/protocolo de sync | Acrescentar serviço e contratos compartilhados, sem mover SQLite para o servidor |
| Desktop | `apps/desktop/src/main/database.ts`: `node:sqlite`, WAL, `foreign_keys = ON`, tabela `migrations` com marcadores até 11; seed registrado na versão 5 | O número de migration desktop não corresponde ao `user_version` mobile. A rotina atual combina inspeção de colunas, DDL e ajustes de dados, sem uma transação global de atualização |
| Mobile | `src/db/migrations.ts`: migrations 1–5, controladas por `PRAGMA user_version`, transações por versão | Próxima versão candidata: 6. Não editar migrations históricas |
| Identidades | Desktop usa `randomUUID()`. Mobile usa `lower(hex(randomblob(16)))`, além de IDs de seed como `cat-food`, `payment-pix` e `default-category-*` | IDs atuais são opacos e válidos localmente; IDs fixos de seed não identificam uma entidade global |
| Lançamentos | Desktop: `planned_cents`, `actual_cents`. Mobile: `planned_amount_cents`, `actual_amount_cents`. Ambos preservam zero e `null` | DTO canônico em centavos inteiros; adaptadores traduzem nomes, sem conversão monetária pela UI |
| Planejamento | Ambos têm `recurring_expenses`, `installment_purchases`, `goals`; campos monetários também têm nomes diferentes | Reutilizar regras do core e explicitar identidade de séries/ocorrências |
| Exclusões | Lançamentos, séries, parcelas e objetivos têm `deleted_at`. Cadastros são removidos fisicamente nos dois apps, após desligar referências | Acrescentar exclusão lógica de cadastros e capturar efeitos associados |
| Projeções | Consultas mensais/anuais materializam recorrências. Há `DELETE FROM transactions` para invalidar projeções de recorrências nos dois apps | Separar invalidação de cache de uma exclusão solicitada pela pessoa |
| Ocorrências | Mobile tem `occurrence_date` desde v3, com índice único por série/data incluindo excluídos. Desktop não tem essa coluna; usa `COALESCE(purchase_date, due_date)` e índices parciais sobre ativos | Não usar vencimento mutável como identidade nem deduplicar só pelo índice atual |
| Prioridades | Duas tabelas em ambos: `recurring_transaction_priorities` e `transaction_priority_order`; posições únicas; reordenação remove e reinsere linhas | Sincronizar a lista inteira como unidade; os números de posição são uma projeção local |
| Importação | Mobile tem `local_import_records`. `source_id` de importados pode ser uma chave de arquivo/linha, não uma FK | Distinguir referência de série de chave de importação no contrato |
| Backup | Desktop exporta nove tabelas financeiras em JSON v1 e usa `node:sqlite.backup`. Mobile exporta onze tabelas em JSON v1/schema v5 e SQLite via `VACUUM INTO` | Backups novos precisam de identidade/proveniência; credenciais nunca devem viajar no backup |
| Restauração | Mobile valida lista exata de tabelas/colunas, migra em staging e substitui registros; desktop JSON é traduzido por `desktopBackupData()` | Toda alteração de schema exige atualizar validadores, conversores e formatos, além dos repositórios |
| Preferências | Mobile: `local_preferences`; desktop usa também armazenamento da interface, por exemplo tema em `localStorage` | Tema, filtros, Léo, privacidade da tela, endpoint e credenciais permanecem por dispositivo na v1 |
| Proteção | Android `allowBackup=false`; SQLite no armazenamento privado. Electron com `contextIsolation`, sem Node no renderer e com sandbox | Não há criptografia explícita do banco local ou gerenciamento de chaves de sync no código examinado |

A migration mobile 5 reconstrói lançamentos, recorrências, objetivos e prioridades para aceitar valores zero, preserva registros e verifica referências. `connection.ts` cria cópia consistente antes de atualizar bases v1–v4. Essa proteção precisa passar a abranger qualquer próxima atualização de uma base existente; hoje a condição está limitada a versões anteriores à 5.

O conversor atual de JSON desktop assume schema mobile v4 e infere `occurrence_date` de compra/vencimento. Isso resolve intercâmbio local legado, mas não prova identidade compartilhada nem a data original de uma ocorrência já editada. Importação de arquivo não deve ser reutilizada como protocolo de sync.

Fontes locais principais: [database.ts](../apps/desktop/src/main/database.ts), [migrations.ts](../apps/mobile/src/db/migrations.ts), [repository.ts](../apps/mobile/src/db/repository.ts), [planningRepository.ts](../apps/mobile/src/db/planningRepository.ts), [backupRepository.ts](../apps/mobile/src/db/backupRepository.ts), [importRepository.ts](../apps/mobile/src/db/importRepository.ts), [local-files.ts](../packages/core/src/local-files.ts), [types.ts](../packages/core/src/types.ts) e [paridade funcional](mobile-functional-parity.md).

## 3. Identidades, escopo e contrato de domínio

### 3.1 Identidade global sem trocar chaves locais

- `local_scope_id`: UUID aleatório que identifica a linhagem de uma base SQLite, criado mesmo sem conta. Não é o dispositivo e não depende de email.
- `global_id`: identidade estável do objeto sincronizável. A migration atribui UUIDv4 a cada registro existente e grava a associação `(entity_type, local_id) → global_id`. Não reescreve PKs/FKs existentes nem assume que um UUID legado tem proveniência global.
- Novos objetos comuns usam UUIDv4 de fonte criptograficamente segura; onde conveniente, o mesmo valor pode ser o ID local. Não usar `Math.random`, relógio, email, nome, Android ID ou MAC.
- `vault_id`: base lógica de sync criada ao aderir ao serviço. V1: uma pessoa proprietária, vários dispositivos, um vínculo ativo por banco local. Instalações puramente locais não precisam de vault remoto.
- `device_id`: instalação cadastrada em um servidor, com chaves próprias; novo cadastro após reinstalação, clonagem ou restauração. Não copiar sua identidade operacional junto com arquivos financeiros.
- `server_id` e `server_epoch`: identificam a instalação do servidor e sua geração de histórico. Cursores e sessões são vinculados também ao endpoint, vault e epoch.
- `commit_id` e `op_id`: UUIDv4 criados offline; identificam respectivamente uma alteração atômica de domínio e uma revisão de objeto. `op_id` também é o `revision_id`.

UUIDv4 e UUIDv5 seguem a [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html). UUID é identidade, não segredo de acesso. Backups futuros conservam IDs globais e `local_scope_id`; arquivos antigos sem essa informação recebem identidades novas. Dois bancos que importaram o mesmo JSON antigo não podem ser unidos automaticamente apenas porque compartilham um `id`.

### 3.2 Conteúdo sincronizado

O contrato `domainSchema: 1` inclui categorias, pagamentos, cartões, lançamentos, séries recorrentes, compras parceladas, objetivos e prioridades. DTOs usam `plannedAmountCents`, `actualAmountCents`, `targetAmountCents`, `savedAmountCents` e equivalentes de parcelas, com inteiros seguros e `null` explícito. Zero nunca significa ausência. Datas financeiras usam `AAAA-MM-DD`; meses usam `AAAA-MM`; instantes de auditoria usam UTC, sem ordenar conflitos pelo relógio do aparelho.

Referências do protocolo usam IDs globais. `source` é uma união explícita: `manual`, `recurring { seriesId, slotKey }`, `installment { purchaseId, slotId }` ou `imported { importKey, importAlgorithmVersion }`. Para o SQLite, adaptadores mantêm `source_type/source_id` e convertem conforme o tipo. Nunca exportar nomes obtidos por JOIN como fonte da categoria, valores em reais de ponto flutuante, atrasos calculados, saldos, progresso, sugestões ou totais anuais; esses dados são derivados localmente pelo core.

O tipo do objeto, os campos, suas referências, o motivo de exclusão e os horários de autoria ficam dentro do conteúdo criptografado. O servidor trabalha com objetos opacos e metadados de transporte. Cada snapshot é completo para sua unidade de domínio; evita depender de executar comandos antigos ou de regras financeiras no servidor.

Para novas importações, propor `importKey = SHA-256(versão + digest do arquivo + aba + posição da linha + conteúdo canônico da linha)`. Não usar somente caminho/nome do arquivo como identidade entre dispositivos. Marcadores antigos continuam preservados como proveniência legada, sem serem promovidos automaticamente a essa chave. Arquivo modificado pode gerar outra chave: apresentar possíveis correspondências para revisão, sem deduplicar gastos independentes apenas pela semelhança.

### 3.3 Identidade de recorrências e parcelas

Gerar a mesma ocorrência em dois aparelhos não pode criar duas despesas. Para novas séries, usar identidade derivada `UUIDv5(namespace=seriesGlobalId, name=slotKey)`:

| Frequência | Chave estável de ocorrência |
| --- | --- |
| Mensal | `monthly:AAAA-MM`, pelo mês original da programação, não pelo mês da fatura |
| Meses escolhidos | `manual:<scheduleEpoch>:AAAA-MM` |
| Única/semanal/custom fixa | `<scheduleEpoch>:<scheduledDateOriginal>` |
| Custom ancorada ao realizado | `<scheduleEpoch>:after:<predecessorGlobalId>`; a data prevista é um atributo |

`scheduleEpoch` é um UUID criado quando a estrutura da programação muda; não muda apenas por editar descrição, valor ou o dia de uma recorrência mensal. Modificar programação de modo incompatível cria nova epoch e invalida somente projeções futuras não confirmadas. Ocorrências realizadas e overrides conservam sua identidade, inclusive com vencimento/compra corrigidos. Guardar também `occurrence_date` como a data originalmente programada, sem voltar a calculá-la de uma data editada.

Nas parcelas, criar `slot_id` imutável e derivar o ID global da ocorrência da compra + slot. `installment_number` continua sendo a numeração exibida, que pode mudar na correção da série. No primeiro cadastro, slots podem ser derivados de um índice original; uma alteração do número inicial não renumera suas identidades. Parcelas novas recebem slots novos; duas expansões concorrentes da série exigem reconciliação antes de materializar os novos slots.

Histórico legado com identidade ambígua não recebe uma inferência silenciosa. Manter ID global aleatório e marcar `identity_unresolved`; apresentar candidatos e exigir revisão antes de sincronizar aquela série. Não impedir lançamentos manuais ou o uso local por isso. Slots comprovados conservam a associação ao ID global legado; publicar um mapa de aliases assinado e criptografado, para que novos aparelhos reutilizem o mesmo objeto. Esse mapa faz parte do estado da série e deve ser carregado antes de gerar ocorrências.

Projeções planejadas nunca tocadas pela pessoa são cache reconstruível: gerar localmente com o mesmo core/versão, sem enfileirar uma alteração por consulta. Editar, realizar, priorizar ou excluir uma projeção a promove a ocorrência persistente sincronizável. O tombstone dessa ocorrência bloqueia nova geração. Invalidação de cache usa motivo distinto de exclusão explícita e não cria tombstone permanente do slot. O planejamento compartilhado só entra após implementar essa distinção nos dois clientes.

## 4. Persistência local e alterações offline

### 4.1 Transação de domínio + outbox

Todas as escritas sincronizáveis passam por uma unidade de trabalho: validar → gravar domínio → registrar identidades/revisões → inserir commit na outbox → commit SQLite. Inclui baixas em lote, mudanças de cartão, exclusão de cadastros, importações, alteração de série e prioridades. Se qualquer parte falhar, tudo reverte. Não tentar detectar alterações comparando apenas `updated_at` ou consultando o banco periodicamente.

Sem vínculo remoto, não gerar uma fila eterna: preservar domínio e identidades; ao habilitar sync, publicar baseline consistente de objetos ativos e tombstones conhecidos. Com vínculo remoto, novas alterações continuam entrando na outbox mesmo com sessão expirada, servidor inacessível ou sync pausado. Se faltar chave para preparar o envelope, conservar o payload local protegido e prepará-lo após desbloqueio; salvar finanças não depende de autenticar na rede.

Ao salvar, registrar snapshot canônico, `op_id` e `parents` das versões efetivamente usadas como base. Edições locais sucessivas referenciam a última revisão local, mesmo não enviada. Não atribuir como pai uma versão remota cujo conteúdo não foi incorporado. Receber alterações grava inbox/revisões/projeção na mesma transação de aplicação e **não** volta a gerar outbox, exceto uma reconciliação explícita.

Depois de criptografar/assinar, o envelope de cada commit é imutável. Retry reenviará exatamente os mesmos IDs, pais e bytes; edição posterior cria outro commit. V1 não compacta operações ainda pendentes. Estados locais: `pending → prepared → in_flight → acknowledged`; erro de transporte permite retry, erro permanente fica visível e mantém os dados. Um crash em `in_flight` volta a retry.

### 4.2 Estruturas locais propostas

Esboço de responsabilidades, não SQL já aplicado:

| Tabela | Campos e invariantes principais |
| --- | --- |
| `sync_local_state` | singleton com `local_scope_id`, versão do formato e do motor; não contém credenciais |
| `sync_binding` | endpoint normalizado, `server_id`, epoch, `vault_id`, `device_id`, cursores recebidos/aplicados, protocolo, referência ao segredo no cofre do SO; uma vinculação ativa |
| `sync_identity` | PK `(entity_type, local_id)`; `global_id` único; slot/alias/proveniência quando aplicável; associação conservada após exclusão |
| `sync_revisions` | PK `op_id`; objeto global, commit, pais, snapshot local, envelope, autoria, hash; revisões imutáveis, inclusive versões concorrentes |
| `sync_heads` | PK `(global_id, op_id)`; conjunto de revisões sem descendente conhecido |
| `sync_outbox` | PK `commit_id`; sequência do dispositivo, operações, envelope/hash, estado, tentativas, próximo retry; UNIQUE `(binding, device_id, device_seq)` |
| `sync_inbox` | PK `(binding, server_epoch, commit_id)`; posição do log, envelope, estado recebido/aplicado/quarentena e erro |
| `sync_conflicts` | objeto/agregado, heads envolvidos, base comum, motivo, estado e commit de resolução; versões permanecem em `sync_revisions` |
| `sync_tombstones` | objeto, revisão da exclusão, motivo, marcador de slot/importação; sobrevive à ausência de linha na projeção |
| `sync_bootstrap` | baseline/staging, contagens, hashes e progresso; retomada da primeira publicação sem duplicação |

Não pressupor JSON1 ou uma extensão SQLite nova disponível em ambos: arrays/DTOs podem ser texto JSON validado no core. Referências entre pais são verificadas pelo motor. Inteiros de sequência/cursor de 64 bits trafegam como strings decimais para não ultrapassar a precisão de JavaScript.

Snapshots locais e conflitos contêm dados sensíveis; aplicam-se a eles as mesmas proteções do banco financeiro. A migration inicial não inclui chave secreta em qualquer dessas tabelas.

### 4.3 Unidades atômicas de domínio

- Lançamento manual e objetivo: um objeto por registro.
- Categoria, pagamento e cartão: um objeto por cadastro; desligamentos de referências fazem parte do mesmo commit da exclusão.
- Recorrência/compra parcelada: definição e mapa de slots/aliases são um agregado; mudanças que afetam overrides incluem as ocorrências alteradas no mesmo commit. Um conflito de programação bloqueia a reprojeção daquela série até resolver.
- Prioridades: um objeto para a lista global de séries, com `pinnedFromMonth`, e um objeto por lista mensal de lançamentos. A projeção recompõe as duas tabelas atuais em uma transação. Não sincronizar cada posição como escrita independente.

Commits com vários objetos são aceitos, baixados e projetados atomicamente. Na v1, se um desses objetos requer resolução incompatível, conservar o commit completo como ramo e manter a última projeção válida do agregado afetado. Não aplicar metade de uma baixa em lote ou metade de uma correção de série. Limites de tamanho devem resultar em grupos com staging/ativação, nunca dividir silenciosamente uma ação financeira indivisível.

Snapshots incluem também dependências de domínio, como as revisões de cadastro/série utilizadas pela alteração. Elas permanecem criptografadas; o servidor só verifica o grafo público de pais. O cliente busca os objetos/revisões necessários, valida suas referências e só então projeta o commit. Se uma dependência estiver tombstonada ou conflitante, registra conflito/quarentena recuperável, sem usar uma FK inválida nem descartar o lançamento.

## 5. Protocolo e servidor

### 5.1 Stack e implantação propostas

Adicionar `apps/sync-server` em Node.js/TypeScript com [Fastify](https://fastify.dev/docs/latest/) e PostgreSQL, `packages/sync-protocol` para DTOs/validação/versionamento e `packages/sync-engine` para ancestralidade, filas e conflitos sem dependência de Electron/React Native. Regras financeiras continuam em `packages/core`; drivers SQLite, rede, arquivos e cofres do SO ficam nos apps. Não introduzir Redis, broker ou microserviços no primeiro fluxo.

Distribuir a mesma imagem AGPL para Cloud e self-hosted, com migrations do serviço e composição reproduzível de API + PostgreSQL + provedor OIDC + HTTPS. O provedor exato é uma decisão pendente; self-hosted precisa de um caminho documentado e empacotado para contas, sem depender do login oficial. Cloud acrescenta operação, billing e monitoramento ao redor dessa API; o motor de sync e a criptografia não mudam.

### 5.2 Endpoints v1

| Endpoint | Contrato |
| --- | --- |
| `GET /.well-known/lionpocket` | `serverId`, `serverEpoch`, versões suportadas, suites criptográficas, limites, issuer OIDC e audience. Não contém dados pessoais |
| `POST /v1/vaults` | Cria vault e registra configuração criptográfica/primeiro dispositivo, após autenticação |
| `POST /v1/devices/enroll` | Cadastro pendente com chaves públicas e prova de posse; não dá acesso ao conteúdo sozinho |
| `POST /v1/devices/{id}/approve` | Aprovação assinada pelo proprietário e envelope de chave para o novo dispositivo |
| `GET /v1/devices` / `DELETE /v1/devices/{id}` | Lista estados e revoga dispositivo/sessões; não apaga seu banco remoto/local automaticamente |
| `POST /v1/vaults/{id}/commits` | Envia um commit atômico, ou vários commits independentes com recibo individual; ACK somente após persistência durável |
| `GET /v1/vaults/{id}/changes?after=...&limit=...` | Página de commits completos, `nextCursor` e limite superior consistente do ciclo |
| `GET /v1/vaults/{id}/revisions?ids=...` | Recupera ancestrais/dependências sem avançar o cursor de alterações |
| `GET /v1/vaults/{id}/snapshot` | Baseline consistente identificado por epoch/cursor e manifesto; implementação após o fluxo mínimo |

`POST commits` devolve `accepted`/`alreadyAccepted`, posição no log e heads atuais. Uma edição baseada em pai antigo é aceita como ramo concorrente, não descartada. `409 idempotency_mismatch` significa que um ID/sequência foi reutilizado com bytes diferentes. `409 heads_changed` vale para reconciliação condicional. Pais desconhecidos retornam `missing_parents`, sem gravar parte do commit; enviar dependências e repetir os mesmos bytes. Não considerar `2xx` sem recibo completo como ACK.

Erros de auth (`401/403`), limites (`413/429`), schema/protocolo incompatível e falha transitória têm códigos distintos. `Retry-After` e backoff exponencial com jitter regulam a rede; nunca descartam outbox. A v1 pode anunciar limites conservadores de 100 commits/página e 1 MiB/commit, configuráveis. Baselines grandes usam staging validado e ativação atômica, não um POST sem limite.

### 5.3 Envelope ilustrativo

IDs abaixo são abreviações didáticas; no contrato real são UUIDs, bytes base64 e strings decimais validados.

```json
{
  "protocolVersion": 1,
  "serverId": "S",
  "serverEpoch": "E",
  "vaultId": "V",
  "deviceId": "D",
  "deviceSeq": "42",
  "commitId": "C",
  "keyVersion": 1,
  "operations": [{
    "opId": "R2",
    "objectId": "G",
    "parents": ["R1"],
    "nonce": "base64",
    "ciphertext": "base64"
  }],
  "signature": "base64"
}
```

O plaintext de cada revisão contém `domainSchema`, tipo, snapshot, mudanças/grupos semânticos e motivo de exclusão quando houver. O cabeçalho fica autenticado como associated data e a assinatura cobre o commit inteiro em serialização canônica especificada e testada; não assinar um `JSON.stringify` dependente da ordem incidental de propriedades. Não enviar `expectedHeads` nas edições comuns; reconciliações usam esse campo para exigir exatamente os heads revisados.

### 5.4 Idempotência, log e cursores

Tabelas remotas mínimas: `users` (chave `(issuer, subject)`, não email), `vaults`, `memberships` (v1 owner), `devices`, `device_grants`, `key_envelopes`, `commits`, `revisions`, `revision_parents`, `object_heads` e `sync_log`. Credenciais/sessões de usuário pertencem ao IdP; a API mantém vínculo e revogação de dispositivos. Conteúdo de domínio permanece ciphertext.

Em uma transação PostgreSQL, verificar usuário/vault/dispositivo/epoch, prova de posse, assinatura, limites, versão e pais; deduplicar `(vault_id, commit_id)`, `(vault_id, op_id)` e `(vault_id, device_id, device_seq)`; comparar hash dos bytes; gravar todas as revisões, atualizar heads e acrescentar o commit ao log. Mesma operação retorna o recibo original. Mesmo ID com outro conteúdo é erro, sem sobrescrever.

**O cursor deve refletir ordem de commit visível.** Reservar uma sequência comum antes de commit permite que uma transação lenta publique depois de uma página já lida e seja perdida. Na v1, bloquear a linha de contador do vault (`SELECT ... FOR UPDATE`), atribuir a próxima posição e manter o bloqueio até commit; publicar log, recibo e contador nessa mesma transação. A serialização é por vault, suficiente para finanças pessoais. O comportamento de sequências e isolamento está documentado pelo [PostgreSQL](https://www.postgresql.org/docs/current/transaction-iso.html); não usar `BIGSERIAL` sozinho como garantia de entrega ordenada.

Paginação não divide commits. O limite superior do ciclo fica fixo enquanto suas páginas são lidas; novas gravações entram no próximo ciclo. Na primeira leitura após ACK, o próprio autor também recebe seu commit; a inbox idempotente absorve a repetição. Não avançar cursor de pull até a posição do último envio: isso pularia alterações de outro aparelho.

Separar `receivedCursor` (envelope duravelmente salvo) de `appliedCursor` (projetado ou conflito duravelmente representado). Envelope inválido/versão desconhecida fica em quarentena, com motivo, para não perder o restante da página. Dependências ausentes são buscadas antes da projeção. Um erro em dados recebidos não derruba abertura nem edição local. A UI distingue “salvo no servidor”, “baixado”, “aplicado” e “conflitos pendentes”.

O snapshot posterior deve incluir todos os heads, versões necessárias aos conflitos/bases comuns, dependências, slots/aliases, tombstones e o manifesto do cursor de origem. O cliente verifica hashes/assinaturas e materializa em staging; o servidor não consegue produzir um snapshot financeiro em claro. Na v1, sem GC, a recuperação inicial pode reproduzir o log inteiro; checkpoints cifrados publicados por cliente autorizado passam a acelerar esse caminho na etapa 2.

Ciclo: negociar capacidades → renovar sessão se necessário → baixar mudanças → aplicar/reconciliar → enviar outbox em ordem de dependência → baixar novamente. Uma execução por banco; tentativas concorrentes coalescem. V1 por botão **Sincronizar agora**; depois, ao voltar ao primeiro plano e após salvar com debounce. Sem prometer execução contínua quando Android fecha o app; sem notificações push.

## 6. Conflitos e exclusões

### 6.1 Ancestralidade explícita

Cada revisão contém seus pais. O servidor mantém todas as revisões e calcula `heads = (heads anteriores − pais presentes) ∪ nova revisão`. Pais devem pertencer ao mesmo objeto/vault e já existir, ou aparecer antes no mesmo commit. Um pai antigo que não está mais em heads não remove outro ramo. Um objeto com um head tem uma versão convergente; dois heads não ancestrais representam concorrência. A ordem de chegada/horário nunca apaga o ramo perdedor.

Exemplo: base `R0` tem R$ 100 planejados. Desktop offline cria `R1(parent=R0)` com R$ 120; Android cria `R2(parent=R0)` com R$ 110. Após envio, ambos recebem `{R1,R2}`. O app preserva os dois valores e pede escolha. A resolução `R3(parents=[R1,R2])` registra explicitamente R$ 120, R$ 110 ou outro valor. Se um terceiro head aparecer antes de aceitar R3, `expectedHeads` falha; recuperar e revisar de novo, sem perder R3 local.

O primeiro fluxo permite edição sequencial normal e conflito manual de snapshot completo. Merge automático de grupos semânticos entra depois. A estrutura de pais já suporta ambos. Base comum ambígua (por exemplo, merges cruzados) ou ausente não permite merge automático; apresentar versões completas.

### 6.2 Regras de resolução recomendadas

| Situação | Comportamento |
| --- | --- |
| Alteração causal, um ramo | Aplicar snapshot validado |
| Ramos com conteúdo canônico idêntico | Propor reconciliação sem alterar valores; referência a todos os heads |
| Grupos independentes, base comum única | Merge de três vias, com validação completa do core, seguido de nova revisão; ex.: notas em um aparelho e baixa no outro |
| Mesmo grupo alterado nos dois ramos | Conflito manual; preservar base, ambas as versões e origem |
| Baixa financeira | Grupo indivisível `kind + status + actualAmountCents + settledDate`; não combinar status de um ramo com valor do outro |
| Valor planejado/categoria | Grupos separados só quando invariantes continuarem válidas; nunca somar valores concorrentes |
| Cartão e competência | Grupo `cardId + paymentMethodId + purchaseDate + dueDate`; recalcular/validar ciclo sem deslocar histórico realizado automaticamente |
| Objetivos | `savedAmountCents` é saldo absoluto; não somar dois snapshots como se fossem depósitos distintos |
| Programação de série | Datas, frequência, intervalos, ancoragem, epoch e slots em um grupo; preservar realizados/overrides e suspender projeções afetadas durante conflito |
| Lista de prioridades | Snapshot da lista; concorrência exige escolher/reordenar; recompor posições únicas somente após resolução |
| Dois cadastros distintos com mesmo nome | Conflito de identidade/constraint; não usar `INSERT OR IGNORE` para perder um deles. Revisar renomeação ou associação explícita com alias e remapeamento de referências |
| Mesmo arquivo importado em dois aparelhos | `importKey` versionada compartilhada evita repetição exata; se não houver proveniência confiável, apenas sugerir duplicidade. Mesmo valor/data/descrição não prova que é o mesmo gasto |

Na v1, conflito financeiro mantém a última base comum válida como projeção compartilhada; a edição local pode aparecer como rascunho preservado, separado da versão contabilizada. Sem base comum, não adicionar duas versões do mesmo objeto ao saldo: manter fora dos totais até resolver, com aviso. Mostrar valor contabilizado e impacto pendente de forma explícita. Resolver conflito não exige estar online: gera commit local condicional para envio posterior; permanece “resolução pendente” até ACK.

Dois clientes podem propor o mesmo merge. Reconciliações automáticas/manuais usam comparação exata de `expectedHeads` dentro da transação remota; somente uma encerra aquele conjunto. O outro cliente baixa o resultado, abandona apenas a proposta equivalente não aceita e não gera um ciclo de merges. Se a proposta recusada contém escolha diferente, mantê-la como rascunho para revisão.

### 6.3 Exclusão, restauração e coleta

Exclusão é uma revisão com tombstone, não remoção de transporte. Nas quatro tabelas financeiras atuais, projetar em `deleted_at`; nos cadastros, acrescentar a mesma capacidade. Um dispositivo offline que edite um objeto excluído gera ramo concorrente, sem ressuscitar o registro.

**Excluir versus editar:** tombstone prevalece na visibilidade/projeção; a edição fica recuperável em conflito. Recuperar conteúdo exige ação explícita que cria um novo objeto global, com referência ao anterior; o tombstone original permanece. Excluir versus realizar uma parcela/recorrência deve exibir a realização preservada no conflito e exigir revisão financeira, sem apagamento silencioso.

Excluir categoria/cartão/pagamento mantém o cadastro tombstonado e desliga referências conforme o comportamento atual, registrando tudo no mesmo commit. Referência concorrente a cadastro já excluído é preservada na revisão original e projetada como não disponível, com resolução para selecionar outro cadastro; não recriar o cadastro automaticamente. Índices de nome devem valer apenas para cadastros ativos.

V1 conserva revisões, tombstones e recibos por toda a vida do vault. Não usar prazo de 30/90 dias que permita reaparecimento de dados de aparelho antigo. GC posterior exige checkpoint consistente, piso de histórico, ACK dos dispositivos ativos e resnapshot obrigatório para quem ficou abaixo do piso. Mesmo após compactar conteúdo antigo, reter marcador de identidade excluída e índice de idempotência suficiente para reconhecer operações antigas. Exclusão definitiva da conta/vault é um fluxo administrativo distinto; não é uma operação por lançamento.

## 7. Usuários, dispositivos e proteção

### 7.1 Conta opcional e autorização

Login via OpenID Connect/OAuth Authorization Code com PKCE `S256`, navegador do sistema e validação de state/nonce/issuer/audience. Desktop usa callback loopback restrito; Android usa retorno registrado/aprovado para o app. Não embutir senha ou segredo de cliente no aplicativo. Esse desenho segue as recomendações para apps nativos da [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html). Tokens curtos (proposta inicial: 10 minutos) e refresh rotativo por sessão/dispositivo, com detecção de reutilização, seguem a [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).

O IdP pode oferecer passkeys/MFA; reset de login não recupera chaves de dados. Identidade de usuário é `(issuer, subject)`; trocar email não troca dono nem IDs financeiros. Cada requisição autoriza a membership do vault e verifica que o dispositivo está ativo. UUID conhecido ou sessão de outro vault não permite leitura. Admin do self-hosted opera infraestrutura, sem obter automaticamente chaves financeiras.

Cada instalação cria chaves de assinatura e troca de chaves, prova posse no cadastro e recebe sessão vinculada ao `device_id`. Requisições de sync exigem token e assinatura HTTP de método, destino, hash do corpo e nonce recente do servidor, usando biblioteca compatível com [HTTP Message Signatures, RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html). Assinatura de transporte é nova por retry; o commit armazenado continua idêntico. Essa assinatura não torna um aparelho comprometido confiável; evita aceitar apenas um token roubado e permite revogação por dispositivo.

Pareamento: dispositivo novo autentica, registra chaves públicas e fica pendente; um aparelho autorizado confirma fingerprint/código por QR ou comparação manual, assina a autorização e entrega envelope criptografado da chave do vault. Não basta o servidor dizer que uma chave pública é de um aparelho confiável. Recovery também exige código de recuperação e autenticação de conta, sem aprovação manual do operador sobre dados em claro. V1 tem um proprietário; compartilhamento/múltiplos papéis é trabalho posterior.

Revogar dispositivo bloqueia leituras, envios e refresh imediatamente na API, mesmo que access token ainda não tenha expirado. Não existe apagamento remoto garantido do SQLite de um aparelho offline. Logout ou desconectar sync conserva dados locais; opção de apagar dados é outra ação explícita. Falhas de conta não mudam as permissões de uso offline.

Conservar o histórico assinado de aprovação/revogação e a versão do registro de dispositivos associada ao aceite de cada commit. Revogação bloqueia operações novas, mas não invalida retroativamente todas as alterações financeiras legítimas do aparelho. Cliente verifica autoria histórica contra esse registro; o horário declarado pelo aparelho não serve como prova de que escreveu antes da revogação.

### 7.2 Criptografia ponta a ponta recomendada

Gerar chave aleatória de 256 bits do vault no cliente. Proposta de suite: XChaCha20-Poly1305 para snapshots, Ed25519 para commits/registro de dispositivos e X25519 sealed boxes para entregar o material de chave a um dispositivo aprovado, via biblioteca auditada e bindings nativos equivalentes nas duas plataformas. A construção AEAD e o tamanho de nonce estão documentados pelo [libsodium](https://libsodium.gitbook.io/doc/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction); assinatura e entrega a destinatário têm APIs próprias ([assinaturas](https://libsodium.gitbook.io/doc/public-key_cryptography/public-key_signatures), [sealed boxes](https://libsodium.gitbook.io/doc/public-key_cryptography/sealed_boxes)). Não implementar primitivas criptográficas no core.

Usar nonce aleatório de 24 bytes por cifragem, nunca reutilizado com a mesma chave. Associated data vincula protocolo, server/epoch, vault, objeto, op, pais e versão da chave. Reenvio conserva ciphertext/nonce; rotacionar chave ou migrar servidor cria novo envelope/commit de checkpoint com identidade de entidade preservada, não reutiliza um ID de operação com outros bytes.

Chave de administração/assinatura do vault nasce no primeiro cliente e assina o registro versionado de dispositivos. O servidor não pode substituir livremente chaves de autoria ou envelopes. Clientes fixam a identidade do vault e verificam cadeia de aprovações/versões, assinaturas e AEAD antes de projetar dados. Guardar a última geração conhecida permite detectar regressões observadas; sem contato entre dispositivos, um servidor malicioso ainda pode ocultar atualizações ou apresentar histórias separadas. Proteção completa contra equivocation exigiria mecanismo adicional de transparência/gossip e está fora da v1.

Fornecer código de recuperação aleatório de alta entropia, que protege um bundle com chaves de dados/administração; exigir que a pessoa o salve antes de habilitar sync definitivo. O servidor guarda apenas o bundle cifrado. Login, MFA e código de recuperação têm funções separadas. Não derivar a chave de dados diretamente da senha de login. Se houver opção futura de backup protegido por frase humana, usar KDF como [Argon2id](https://www.rfc-editor.org/rfc/rfc9106.html) com parâmetros versionados e medidos; isso não é necessário para o código aleatório da v1.

Revogação de aparelho exige rotação de chave para proteção futura, registro de dispositivos assinado atualizado e checkpoint cifrado na nova versão, entregue somente aos ativos. Escritas pendentes sob chave antiga ficam localmente preservadas e são rebaseadas/reemitidas por aparelho autorizado, com novos IDs de operação e proveniência; não reenviar ciphertext antigo contra outra chave/epoch. Rotacionar não retira de um aparelho revogado o conhecimento dos dados/chaves que ele já recebeu. Chaves antigas necessárias à leitura do histórico ficam no bundle dos dispositivos ativos até compaction segura.

E2EE implica que servidor não valida centavos/ciclo de cartão, não resolve conflitos financeiros, não pesquisa conteúdo nem executa regras bancárias sobre ele. Clientes autorizados validam o domínio; conteúdo inválido fica em quarentena. Não oferecer inicialmente um modo plaintext “temporário” em produção. Uma futura integração Open Finance exige uma decisão própria sobre confiança e processamento; não alterar a privacidade deste sync antecipadamente.

### 7.3 Armazenamento local e operação

Android: chaves privadas de software/bundle envolvidos por chave de wrapping no [Android Keystore](https://developer.android.com/privacy-and-security/keystore), sem presumir suporte de hardware a Ed25519/X25519. Tokens e material de chave não ficam em AsyncStorage/SQLite/exportações. Desktop: processo main acessa cofre do SO; renderer recebe apenas comandos mínimos e status. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) pode usar backend `basic_text` em Linux: detectar e recusar persistência automática de segredos nesse modo, oferecendo desbloqueio por sessão/cofre compatível. Não impedir funcionamento financeiro local.

E2EE protege os dados enviados, não o SQLite em claro, CSV/JSON exportados, screenshots ou um dispositivo desbloqueado comprometido. Criptografia do banco local (por exemplo, avaliação de SQLCipher nos drivers atuais) é uma decisão separada; exigirá proteger WAL, temporários, backups e recuperação. Até lá, manter diretórios privados, usar proteção do SO, reduzir logs e informar claramente o alcance da proteção. Sync pode ficar pausado enquanto o material criptográfico está bloqueado; o banco local continua utilizável.

HTTPS obrigatório em Cloud e self-hosted de produção; não oferecer bypass de certificado ou HTTP na configuração normal. Exceções localhost limitadas a build de desenvolvimento. Descoberta de issuer não deve aceitar origem arbitrária silenciosamente: confirmar o servidor escolhido, validar HTTPS/origem e impedir redirects que reenviem credenciais a outro host. Troca de endpoint descarta sessões da origem anterior, sem enviar automaticamente outbox para outro operador.

No backend, aplicar isolamento por vault em toda consulta, preferencialmente também RLS como defesa adicional, credencial DB restrita, quotas de payload, proteção de login no IdP e rate limits. Logs não incluem plaintext, tokens, códigos de recovery ou envelopes completos. Cloud cifra volumes/backups e usa segredos de operação fora do repositório; self-hosted recebe o mesmo guia. Guardar/restaurar também memberships, chaves públicas, recibos e epoch; ciphertext sem esses metadados não é backup operacional completo. Mensurar falhas/latência sem conteúdo financeiro e sem telemetria obrigatória no modo local.

## 8. Impacto nos schemas e migração sem perda de dados

### 8.1 Mudanças planejadas por plataforma

| Área | Mobile (v6 candidata) | Desktop (migration 12 candidata) |
| --- | --- | --- |
| Identidade/filas | Novas tabelas `sync_*`, backfill de todos os registros/identidades | Mesmo modelo lógico, com driver síncrono |
| Cadastros | Acrescentar `created_at`, `updated_at`, `deleted_at` a categorias/pagamentos/cartões; preenchimento legado identificado como migration, não autoria histórica | Acrescentar `deleted_at`; conservar timestamps existentes |
| Nomes únicos | Reconstruir cadastros para substituir UNIQUE inline por índices únicos parciais `WHERE deleted_at IS NULL`, preservando FKs | Mesmo ajuste; preservar nomes, cores, dias e IDs |
| Ocorrências | Conservar `occurrence_date`; acrescentar slots/epoch/proveniência via sidecar e campos necessários; não sobrescrever data conhecida | Acrescentar `occurrence_date` e mesmas informações de identidade; backfill somente quando demonstrável |
| Índices de geração | Acrescentar unicidade de slot global incluindo tombstones/aliases; os índices financeiros existentes deixam de definir identidade | Mesmo; ajustar geradores/invalidadores antes de mudar constraints que colidam |
| Parcelas | Mapear slot imutável por ocorrência, independente da numeração corrigível | Mesmo |
| Prioridades | Conservar tabelas como projeção; adicionar revisões de listas, sem alterar posições na migration | Mesmo |
| Importação | Preservar `local_import_records`; versionar proveniência global no contrato | Acrescentar equivalente de marcador de importação para não depender somente de lançamento ativo/data |
| Backup | Atualizar enumeração exata de tabelas/colunas e formatar exportações com identidades | JSON com versão/plataforma/schema explícitos e novas identidades; manter leitura do v1 legado |
| Escritas | Substituir `INSERT INTO ... VALUES` sem lista de colunas nos cadastros; usar exclusivamente `tx` nos callbacks | Envolver toda escrita de domínio e outbox em transação; impedir capture de valores temporários `pending-*`/`editing-*` |

A revisão das constraints de cadastro requer reconstrução transacional; a documentação de [ALTER TABLE do SQLite](https://www.sqlite.org/lang_altertable.html) descreve as limitações e o procedimento geral. Recriar tabelas dependentes quando necessário, repor índices e verificar FKs; não renomear a tabela pai casualmente, porque isso pode alterar as referências das filhas. Não desabilitar integridade como forma de aceitar perdas.

Os números 6/12 são candidatos, não slots reservados. Se uma entrega local consumir esses números, recalcular antes de implementar. A versão do protocolo/domínio não é a versão da migration de nenhum cliente.

### 8.2 Procedimento de atualização local

1. Antes de alterar qualquer base existente, criar cópia SQLite consistente: `VACUUM INTO` no mobile e API de backup no desktop; nunca copiar só o `.sqlite` aberto em WAL. Se a cópia falhar, não iniciar migration. No desktop, essa proteção precisa ocorrer antes da nova rotina tocar o banco; registrar/checkar a versão de origem antes de rodar atualizações históricas.
2. Registrar manifesto de origem, contagens, digest das colunas financeiras antigas, tabelas/índices e versão. Incluir registros excluídos, prioridades, importações e preferências.
3. Executar nova migration e backfill em transação com estratégia testada de reconstrução/FKs. Preservar IDs, referências, valores em centavos, `null`, datas, status, notas e tombstones. Metadados desconhecidos permanecem desconhecidos; nenhum dado sai pela rede.
4. Conferir valores e contagens por tabela, referências, unicidade de identidades, `foreign_key_check` e `integrity_check`; comparar todos os campos legados, não apenas totais. Somente então avançar `user_version`/registrar nova migration. A falha reverte o bloco e conserva a cópia prévia.
5. Reabrir sem rede e conferir painéis, planejamento, arquivos e exclusões. Manter cópia legada; downgrade do aplicativo não deve abrir/gravar schema novo, devendo usar essa cópia separada. Adicionar também guarda de versão futura no desktop.

Não editar migrations mobile 1–5. Fixtures de cada versão conhecida devem ser atualizadas pelo mesmo caminho utilizado em produção. No desktop, trazer amostras dos schemas históricos e tornar o novo bloco protegido/atômico antes de iniciar sync. O histórico anterior não deve ser “normalizado” às custas de dados financeiros.

### 8.3 Primeira vinculação e bancos já preenchidos

Publicar baseline de uma base escolhida, em snapshot SQLite consistente, incluindo tombstones, slots e aliases resolvidos. A criação/publicação é retomável e idempotente. Base permanece local se envio ou login falhar; objetos fora do primeiro escopo continuam disponíveis sem upload.

Em outro aparelho vazio, baixar para staging, verificar chaves, versões, referências e contagens, ativar atomicamente e então permitir novos envios. Seeds locais não devem ser publicados como novos cadastros durante esse bootstrap; associar somente os equivalentes comprovados.

Se o segundo aparelho já contém finanças, não substituir nem mesclar silenciosamente. Mostrar comparação e oferecer: usar o vault em uma base local separada, conservando a base atual; ou preparar importação aditiva revisada. Mapear cadastros equivalentes explicitamente; cartões com mesmo nome mas ciclos diferentes e lançamentos parecidos exigem revisão. Nenhum registro preexistente é descartado por deduplicação heurística. Para o primeiro piloto, exigir base de teste vazia no segundo aparelho; onboarding de bases não vazias é etapa obrigatória antes de disponibilizar sync ao público.

### 8.4 Backups, restauração e mudança de servidor

Formato novo de backup inclui schema de origem, proveniência/IDs globais, slots, aliases, tombstones e histórico necessário à leitura de conflitos. Exportação financeira portátil e pacote de recuperação de sync têm manifestos distintos. Não embutir tokens, chaves privadas, `device_id` reutilizável, nonce de sessão ou cursor como autorização para retomar a rede. SQLite físico pode conter metadados operacionais; abrir uma cópia como restauração obriga invalidá-los e recadastrar dispositivo antes de qualquer envio.

Restaurar um backup é recuperar uma base local, não voltar o servidor no tempo. Antes da substituição, proteger o banco atual e a outbox ainda não enviada. Restaurar em staging, migrar e validar; manter cópia recuperável dos dados posteriores ao backup. Desvincular/pausar transporte, preservar IDs globais quando houver proveniência e gerar nova identidade de instalação. Com schema/backup futuro desconhecido, rejeitar sem modificar a base ativa.

Reconectar ao mesmo vault exige baixar seu estado atual e fazer comparação de três vias com a origem do backup; não emitir exclusões porque uma linha não aparece no arquivo antigo. Outbox arquivada pode reenviar envelopes exatos somente quando servidor/epoch/chaves ainda forem válidos e o dispositivo original estiver autorizado; do contrário, recuperar alterações como novos commits após revisão. Tombstones remotos impedem ressurgimento automático. A pessoa pode optar por conservar a restauração isolada ou criar outro vault.

Trocar Cloud por self-hosted, ou o inverso, é migração explícita: congelar transporte, proteger outbox, exportar checkpoint autenticado com identidades/conflitos/tombstones, autenticar e aprovar dispositivo no destino, reenvolver chaves e publicar baseline verificável. Sessões, cursores, commit IDs de transporte e server epoch não são portáveis; identidades financeiras são. Após validar o destino, ativar um vínculo único e manter origem pausada. V1 não replica um banco simultaneamente a dois servidores.

Restauração operacional do servidor deve mudar `server_epoch`; um cliente que observa epoch diferente interrompe envios automáticos, conserva outbox e negocia resnapshot/reconciliação. O runbook precisa gerar nova epoch fora do backup restaurado. Comparar checkpoint/revisões dos clientes permite recuperar alterações aceitas após o backup remoto; não tratar cursor restaurado como histórico completo nem ignorar perda detectada de revisões.

## 9. Implementação em etapas

### Etapa 0 — contratos e proteção das bases

Criar fixtures reais/anonimizadas de migrations antigas e definir DTO, IDs, invariantes, envelope e vetores de serialização/criptografia. Preparar migrations aditivas/constraints e caminhos de backup/restore, mantendo sync desligado. Identificar todas as escritas, incluindo geradores, importadores e operações em lote. Não publicar um banco novo sem testar o uso sem conta e a atualização de bancos existentes.

### Etapa 1 — fluxo vertical mínimo, ambiente de desenvolvimento

**Recorte:** um vault de teste, desktop + Android, lançamentos manuais sem categoria/pagamento/cartão, centavos/zero/`null`, criar → editar → realizar → excluir. Usar uma base vazia separada para testes; nenhuma projeção de recorrência ou importação entra na rede. O protocolo anuncia `entityScopes: [manualTransaction]`; desconhecidos permanecem locais, sem falsa indicação de “tudo sincronizado”.

1. Implementar identidade, revisões, heads, tombstones, outbox e inbox mínimos nas duas plataformas. Guardar toda edição junto com a outbox; adaptar `save/remove/settle` para transação e validação compartilhada.
2. Subir API/PostgreSQL e IdP de desenvolvimento com duas sessões reais; autenticar por PKCE, registrar/aprovar dispositivos, entregar chave cifrada. Implementar suite candidata com vetores iguais nos dois clientes. Fixtures de token podem ajudar testes isolados, mas não substituem auth/pairing no aceite do fluxo vertical.
3. Implementar somente descoberta, envio de commits, mudanças paginadas e busca de pais, com deduplicação e contador serializado por vault. Conteúdo financeiro cifrado desde o teste integrado; sem variante plaintext liberável em produção.
4. Desktop offline cria lançamento de R$ 12,34; Android sincroniza e mostra exatamente uma linha. Android offline registra realizado zero; desktop sincroniza e conserva `actualAmountCents = 0`, status e data.
5. Forçar perda da resposta após commit remoto, reenviar, matar/reabrir cliente e servidor; ainda existe uma linha e um recibo efetivo. Falha ao gravar outbox reverte a mudança local.
6. Editar valor simultaneamente nos dois aparelhos; ambos preservam dois ramos, exibem conflito e conseguem resolver com pais/heads explícitos. Repetir a resolução após concorrência deve conservar a escolha recusada para revisão.
7. Excluir em um aparelho com o outro offline; retorno do segundo não recria o registro. Edição concorrente à exclusão fica recuperável.
8. Desconectar conta/servidor e usar normalmente ambos os bancos. Usuário diferente/dispositivo revogado não pode ler/enviar commits. Inspeção do banco/log remoto não mostra descrição, valores ou notas.

**Critério de término:** ciclo completo nos apps reais e duas implementações do mesmo contrato, passando pelas falhas acima, incluindo paginação concorrente, assinatura/ciphertext alterados e restauração offline. Esse piloto não é ainda sync público para a Play Store; falta cobrir todas as escritas e onboarding dos dados existentes.

### Etapa 2 — dados existentes e cadastros

Entregar baseline/staging, revisão de bases preenchidas, colisões de nomes e aliases, tombstones de cadastros, captura de desligamentos, importações com proveniência e novos formatos de backup. Implementar restauração com outbox protegida e reconexão sem rollback remoto. Testar migração sobre schemas reais dos dois apps.

### Etapa 3 — planejamento e conflitos de domínio

Unificar slots/epoch e invalidação de projeções; migrar ocorrências comprovadas e revisar ambiguidades. Acrescentar parcelas, objetivos e prioridades como agregados. Implementar grupos de merge de três vias, UI de conflitos e atomicidade de operações em lote. Comparar duas gerações offline do mesmo mês, mudanças no ciclo do cartão, parcelas renumeradas e custom ancorada ao realizado.

### Etapa 4 — operação e disponibilidade pública

Finalizar recovery/rotação/revogação, trust do dispositivo, runbook de servidor/epoch, backups restaurados em ensaio, limites, logs, deploy self-hosted e Cloud idênticos. Executar a mesma suíte de contrato nos dois destinos e migração entre eles. Validar release Android atualizando a instalação sem limpar dados, desktop em Linux/Windows e compatibilidade entre versões. Ajustar textos de privacidade/declarações de dados à função opt-in efetivamente oferecida, mantendo uso local completo.

Push, Open Finance e modelo comercial continuam fora dessas etapas.

## 10. Riscos e verificações de aceite

| Risco | Mitigação / evidência exigida |
| --- | --- |
| Metadados alteram migrations/backups ou constraints descartam linhas | Comparação registro a registro de colunas antigas, reabertura, integridade/FKs e rollback provocado após escrita tardia |
| Escrita fora da outbox | Inventário de todos os writers; testes de fault injection nas baixas, cadastros, importações e geração; adapter remoto nunca recaptura evento |
| Cursores pulam commits | Teste de duas transações: primeira lenta, segunda concorrente; nenhuma revisão aceita desaparece da paginação |
| Crash, retry e respostas perdidas | Rodar interrupções antes/depois de commit e ACK em SQLite/PostgreSQL; mesmos envelopes geram o recibo original |
| Exclusão reaparece | Aparelho offline por longo período, tombstone seguido de edit/geração/import repetida; nenhum reaparecimento automático |
| Valores financeiros fundidos incorretamente | Zero versus `null`, duas baixas com valores/datas diferentes, objetivo com dois saldos absolutos; conflito explícito e nenhum total duplicado |
| Recorrência/parcelas duplicadas ou apagadas | Geração simultânea, alteração de vencimento/ciclo, mudança de frequência e numeração; slot estável, overrides e realizados preservados |
| E2EE e interoperabilidade aumentam esforço | Spike com bindings Android/Electron, vetores de AEAD/assinatura/serialização e review independente antes de dados reais; reprovar release se a suite não convergir |
| Perda do único aparelho/código de recovery | Testar recuperação em instalação nova com bundle cifrado; sem chave/recovery, informar irrecuperabilidade remota sem apagar backup local |
| Token roubado/isolamento falho | Testes negativos de outro issuer/user/vault, dispositivo não aprovado/revogado, assinatura inválida e troca de chaves pelo servidor |
| Servidor antigo ou schema futuro | Negociação antes de enviar; preservar outbox, quarentena recuperável, abertura offline e erro com atualização necessária |
| Restauração causa replay ou perda de mudanças recentes | Restaurar backup antigo com outbox pendente e servidor avançado; comparar diff, não mandar exclusões por ausência, novo cadastro/epoch |
| Custos de histórico e snapshots completos | Medir volumes com bases grandes; quotas limitam transporte sem bloquear app; compactação só após checkpoint/ACK especificado |
| Self-hosting fica dependente da Cloud | Implantar do zero sem credenciais oficiais e passar mesma suíte; login e discovery configuráveis, sem API premium de integridade |

O aceite deve incluir os testes locais já existentes, typecheck/lint e fixtures novas de migração. Builds/emulador são necessários nas etapas de implementação com mudanças nativas. Esta entrega documental não muda runtime, dependências ou schema e não alega que esses novos cenários já foram implementados/testados.

## 11. Decisões pendentes — separadas das recomendações

As direções já definidas na visão (local-first, backend opcional, monorepo, Android/SQLite, self-hosted + Cloud, AGPL) são restrições. As escolhas abaixo são propostas para decisão futura; nenhuma foi silenciosamente promovida a requisito aprovado.

| Decisão pendente | Recomendação deste documento | Momento limite |
| --- | --- | --- |
| Modelo de sync/conflitos | Revisões imutáveis com pais/heads e resolução explícita; começar com snapshot completo, depois merge de grupos | Antes da etapa 1 |
| Identidade global | Sidecar sem substituir IDs atuais; UUIDv4 para objetos comuns e UUIDv5 por slot comprovado | Antes da migration de preparação |
| Stack/backend | Node/TypeScript + Fastify + PostgreSQL; dois pacotes pequenos de protocolo/motor | Antes da etapa 1 |
| E2EE e suite/bindings | E2EE obrigatório no sync de produção; suite libsodium candidata, validada nos dois runtimes; sem modo plaintext inicial | Spike da etapa 0, antes de dados reais |
| IdP e primeira experiência de conta | OIDC/PKCE com IdP auto-hospedável empacotado; escolher fornecedor, bootstrap, passkeys/MFA e recuperação do login | Antes do fluxo autenticado da etapa 1 |
| Trust/recovery/rotação | Aprovação por aparelho ou recovery de alta entropia; registro assinado pelo proprietário; rotação após revogar | Contratos na etapa 0; pronto antes de sync público |
| Criptografia do SQLite/exportações | Avaliar suporte dos drivers e custo de SQLCipher; não confundir com E2EE | Antes de prometer banco local cifrado |
| Onboarding com dois bancos preenchidos | Base separada ou importação revisada; nenhum merge heurístico destrutivo | Etapa 2, antes de sync público |
| Projeção durante conflito | Base comum contabilizada, alterações conflitantes preservadas como rascunho; exclusão oculta com revisão recuperável | Antes da UI de conflito da etapa 1 |
| Identidade histórica ambígua de séries | Revisão por série; bloquear só o envio afetado; não inferir data original silenciosamente | Antes da etapa 3 |
| Preferências sincronizadas | Todas por dispositivo na v1; eventual opt-in posterior | Antes de expandir o escopo |
| Retenção/GC e limites de dispositivos | Sem GC de revisões/tombstones na v1; definir custos/quotas e checkpoint antes de retenção finita | Antes de operação pública em escala |
| Semântica de exclusão de conta/vault | Fluxo separado, exportação/recuperação e política de backups operacionais explícitas | Antes de oferecer contas ao público |
| Background Android | Botão primeiro; foreground/debounce depois; tarefa nativa só se a experiência justificar | Após estabilidade do fluxo vertical |
| Modelo comercial Cloud | Cobrar infraestrutura/conveniência; pausa de serviço conserva app e outbox locais | Etapa operacional/comercial própria |

Todas as etapas dependentes devem respeitar o resultado dessas decisões. A proposta já permite iniciar o spike e o fluxo vertical em ambiente de teste; não autoriza expor dados reais ou declarar sync pronto sem fechar criptografia, autenticação, recuperação e migração.


## 12. Resultado da Etapa 0 e decisões do piloto

Em 30/09/2026, a [Etapa 0](local-first-sync-stage0.md) foi implementada e enviada no commit `4fb76f2`, mantendo sync desativado. O [complemento técnico](local-first-sync-stage1-readiness.md) resolve a interoperabilidade Electron↔Android/Hermes debug/release, seleciona bindings pinados, fecha bytes de controle/recovery e escolhe Keycloak para o ambiente de desenvolvimento. As migrations históricas foram ensaiadas também nos drivers nativos com fixtures sintéticas.

A tabela da seção 11 registra as decisões originalmente pendentes; seu estado atualizado, escolhas específicas do piloto e gates restantes estão no complemento. API, login, sync de dados, migrations de identidade e o fluxo vertical da Etapa 1 continuam por implementar. Aprovação do recorte técnico de desenvolvimento não autoriza dados reais ou publicação sem os critérios das etapas seguintes.
