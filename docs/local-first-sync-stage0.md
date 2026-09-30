# Sincronização local-first — resultado da Etapa 0

Data: 30/09/2026. Base auditada: `276b304`, desktop 0.3.9, Android schema 5. Referência: [proposta](local-first-sync-proposal.md). Este documento registra decisões de implementação da Etapa 0; não transforma as decisões de produto ainda abertas em funcionalidades aprovadas.

A entrega contém inventário dos writers, contratos portáveis, vetores fixos, fixtures SQLite com dados fictícios, ensaios de preservação e proteção das atualizações existentes. Não há API, conta, login, motor de sync, filas, chaves de usuário ou transporte. Nenhum app depende de `@lionpocket/sync-protocol`. As capacidades da Etapa 0 são `syncEnabled: false` e `entityScopes: []`; não existe botão ou configuração que habilite sync.

## 1. Conferência da proposta contra o código

| Afirmação / área | Resultado da conferência |
| --- | --- |
| Schemas diferentes | Confirmado: desktop tem marcadores 1–11 (5 é seed), Android usa `user_version` 1–5. Esses números não são versões do domínio ou do protocolo. |
| IDs | Confirmado: UUIDv4 desktop, hex de `randomblob(16)` no mobile e IDs de seeds legados. Não promover nenhum deles a ID global sem sidecar/proveniência. `randomblob` fica restrito à identidade local existente. |
| Valores | A persistência usa centavos; tipos públicos do core/UI usam valores em reais. DTO de sync precisa sair das colunas SQLite, sem round-trip pela UI ou `fromCents`/`toCents`. Ambos aceitam realizado zero e ausência `null`. Algumas constraints de parcelas continuam exigindo valor positivo no Android. |
| Exclusões | Quatro tabelas financeiras têm `deleted_at`. Cadastros são removidos fisicamente; referências são desligadas. Não há tombstone global ou registro de exclusão de cadastro. |
| Geração por leitura | Confirmado. Listagens, overview e anual podem inserir projeções. Reset de recorrência pode fazer `DELETE` físico; correções também podem ocultar ocorrências por colisão. Um hook SQL genérico não distingue ação da pessoa de cache. |
| Identidade de ocorrência | Android tem `occurrence_date`, mas seu writer também usa compra/vencimento para encontrar históricos. Desktop não possui a coluna. Não confundir existência da coluna com prova de identidade histórica ou slot global. |
| Backups mobile | Lista exata de 11 tabelas e colunas; rejeita objetos desconhecidos, triggers/views, esquema futuro, corrupção e FKs inválidas. Uma tabela sidecar nova já tornaria um SQLite incompatível com o validador atual. |
| JSON desktop no Android | `parseBackupJson` informa schema mobile 4 para o legado. Contudo, `prepareImport` acrescenta `local_preferences: []` e chama `loadBackupData` com **a versão atual (5)**. O conversor infere `occurrence_date` de uma data mutável: é intercâmbio legado, não prova de slot. |
| Restauração desktop | **Não existe comando de restore desktop no código atual.** `ipc.ts` oferece backup SQLite, export JSON/CSV e import XLSX. JSON desktop é lido/restaurado em staging pelo **Android**. Implementar restore desktop não pertence a esta etapa. |
| Proteção Android | A conexão ativa já passa callback de cópia `VACUUM INTO`. A condição foi generalizada de `< 5` para `< migrations.length`. Cada migration agora confere FKs, não apenas a 5. Chamadas sem callback são usadas em cópias descartáveis/testes; não devem ser usadas para uma nova atualização da base ativa. |
| Proteção desktop | Adicionada antes de atualização pendente: cópia SQLite consistente, migration + seed na mesma transação, integridade/FKs antes de COMMIT e fechamento em erro. Banco atual completo não repete correções históricas em toda abertura. Versão futura é rejeitada. |
| Criptografia | Nenhum binding, gerenciador de chaves ou SQLCipher integrado aos apps. Resultado do spike: compatibilidade de bytes entre libsodium Linux e Node, **não** Android↔Electron. |

`packages/core` continua responsável por regras financeiras (`daily-finance`, `planning`, `transactions`, `credit-cards`), conversões de centavos e intercâmbio (`local-files`, `spreadsheet-import`, `xlsx`). Não persiste registros nem fornece CSPRNG/cofre/criptografia. Os contratos reaproveitam seus enums e validador de datas; não mudam os DTOs da UI nem implementam primitivas no core.

## 2. Inventário completo de escritas desktop

Entradas de UI/IPC estão em [`ipc.ts`](../apps/desktop/src/main/ipc.ts); os writers financeiros estão em [`database.ts`](../apps/desktop/src/main/database.ts). “Transação” abaixo refere-se ao domínio **atual**, sem outbox.

| Writer / entrada indireta | Tabelas e efeitos | Atomicidade atual / captura futura |
| --- | --- | --- |
| construtor → `migrate`, `seed` | DDL, índices, marcadores; corrige `start_month`; seed de categorias/pagamentos e recoloração legada | Agora uma transação protegida. Não atribuir autoria humana a correções/seed. Não repetir correções históricas em uma migration aditiva. |
| `createCatalogItem` | Categoria/pagamento: `INSERT OR IGNORE`; cartão: INSERT ou UPDATE | Statement único. Colisões de nome precisam virar conflito explícito no futuro; nunca promover OR IGNORE ao protocolo. |
| `findOrCreateCategory`, `findOrCreatePaymentMethod`, `findOrCreateCard` | Cadastros criados durante importação | Statements individuais, associados à ação de importação. |
| `deleteCatalogItem(category/card)` | Desliga FKs em recorrências, compras, transações; categoria também em objetivos; cartão limpa `charge_day`; DELETE físico do cadastro | Transação. Desktop não expõe exclusão de pagamento. Futuro commit deve conter cadastro e todos os desligamentos. |
| `ensureRecurringForMonth` | INSERT de transações recorrentes; interpreta histórico/tombstone para evitar regeneração | Vários statements sem transação própria. Chamado por `listTransactions`, `getOverview`/resumos e prioridades. Consultar não pode criar outbox. |
| `saveTransaction` | INSERT/UPDATE transação; reset de projeções custom ancoradas ao realizado | Sem transação conjunta para todos os efeitos. Etapa 1 deve envolver alteração + sidecars/outbox. |
| `deleteTransaction` | DELETE de prioridade mensal + `deleted_at/updated_at` da transação | Dois statements sem transação conjunta. Precisará da mesma unidade de trabalho. |
| `settleTransaction` | Status, realizado com `COALESCE` (zero preservado), data efetiva/auditoria; invalida projeções custom | Sem transação própria conjunta. |
| `settleTransactions` | Várias baixas + resets de custom; consulta apenas pendentes | Transação de lote; outbox futura usa esse mesmo limite. |
| `resetRollingRecurringProjections` | DELETE físico de futuras ocorrências ainda planejadas/sem realizado | Cache, não exclusão da pessoa. Exige marcador de promoção antes de sync de planejamento. |
| `setTransactionPriority` | Pode gerar recorrências; limpa/reinsere prioridade mensal, fixa/desfixa série e reordena prioridades globais | Parte de geração ocorre antes da transação de prioridade. Posições transitórias não são snapshots. Sincronizar lista completa. |
| `saveRecurringExpense` | INSERT da série ou UPDATE; ajusta projeções, remove cache quando estrutura muda, usa datas temporárias e resolve colisões; preserva realizados | Edição em transação; criação e consultas de geração têm outros limites. Definição + aliases/ocorrências alteradas precisam ser agregados. |
| `deleteRecurringExpense` | Tombstone da série e limpeza das duas prioridades; visibilidade de ocorrências depende da série | Transação. Não representa uma exclusão global individual de cada ocorrência. |
| `createInstallmentPurchase`, `saveInstallmentPurchase` | Compra e transações; renumeração, ocultação de excedentes, novas parcelas e datas temporárias para constraints | Transações. Slots globais não podem depender da numeração ou das datas temporárias. |
| `deleteInstallmentPurchase` | Tombstones de compra e transações vinculadas | Transação. Capturar o conjunto inteiro. |
| `saveGoal`, `deleteGoal` | INSERT/UPDATE ou tombstone de objetivo | Statement único. Saldo economizado é absoluto. |
| `insertImportedTransaction` | INSERT OR IGNORE de transação com `source_type=imported`, chave de arquivo/aba/linha | Sem ledger separado e sem transação de importação completa. Unicidade depende de origem/vencimento e ativos. |
| `importFinancialSpreadsheet` (`importer.ts`) | Cria cadastros, séries, objetivos, transações por chamadas acima | **Sem transação global ou backup automático**. Usa caminho/aba/linha, deduplica séries/objetivos por descrição/nome; `number(...) || null` apaga a distinção de zero em alguns trechos. Registre como dívida local, não alterada silenciosamente nesta etapa. |

Backups/exportações: `backup:create` usa `node:sqlite.backup`; `export:json` usa nove tabelas de `exportData()` (inclui exclusões e prioridades); CSV inclui apenas lançamentos visíveis, nomes de JOIN e reais, portanto não é backup completo. Export JSON é v1 sem `platform/schemaVersion`. Não possui IDs/proveniência de sync. Preferências da UI (tema etc. em `localStorage`) ficam por aparelho, fora do protocolo.

## 3. Inventário completo de escritas Android

Fachada pública: [`transactions.ts`](../apps/mobile/src/db/transactions.ts). Drivers: [`repository.ts`](../apps/mobile/src/db/repository.ts), [`planningRepository.ts`](../apps/mobile/src/db/planningRepository.ts). Todos os callbacks transacionais devem usar `tx.executeAsync`, nunca a conexão enfileirada; o adaptador de testes detecta essa violação.

| Writer / entrada indireta | Tabelas e efeitos | Atomicidade atual / captura futura |
| --- | --- | --- |
| `connection.database` → `migrate` | Migrations por `user_version`, rebuild v5 de transações/recorrências/objetivos/prioridades | Backup da base ativa antes de qualquer avanço de versão existente; transação por versão. Falha numa versão conserva o último schema confirmado, não necessariamente a versão de início de todo o percurso. |
| `seedNewCatalogs` | Substitui categorias iniciais e renomeia PIX | Apenas base nova v0, durante migration. Nunca seed em restore de base preenchida. |
| `completeStandardCategories` | Adição explícita de categorias faltantes | Transação. É ação humana separada, não seed automático. |
| `createCatalog` | Cria/edita categorias, pagamentos, cartões; checa nomes e uso da categoria | Transação. INSERT agora lista colunas explicitamente para tolerar campos aditivos com default/NULL. |
| `removeCatalog` | Desliga FKs em tabelas financeiras; cartão limpa `charge_day`; DELETE físico | Transação. Futuro tombstone e desligamentos no mesmo commit. |
| `generateMonth` / `insertGenerated` | Materializa transações recorrentes/parcelas; conserva `occurrence_date` e consulta histórico | Transação por geração. Chamado por `list`, `annual`, overview, prioridades, listagens de parcelas. Não captura como alteração humana. |
| `save`, `resetRolling` | INSERT/UPDATE transação e DELETE de futuras projeções custom | Mesma transação. Para Etapa 1, restringir a manuais sem vínculos e capturar snapshot final. |
| `remove` | Tombstone da transação | Statement único; não remove linha de prioridade como desktop. Prioridade oculta permanece no banco. |
| `settle` → `settleMany` | Baixas e resets custom; realizado `COALESCE` preserva zero | Transação de lote. |
| `setPriority` | Geração, fixação da série, limpeza/reinserção mensal, reordenação com deslocamento temporário de posições | Transação da prioridade; geração pode ser anterior. Não emitir revisões por posição intermediária. |
| `saveRecurring` | INSERT/UPDATE série, reprogramação/limpeza de cache e ajustes de transações, datas `pending-*` | Transação. Confirmados e overrides ainda precisam de identidade/promoção explícita antes da Etapa 3. |
| `removeRecurring` | Tombstone da série | Statement único; prioridades e filhos persistem, com filtragem por série. Difere do desktop. |
| `saveInstallment` | Compra + transações, renumeração, novas parcelas, tombstones de excedentes, datas `editing-*` | Transação. |
| `removeInstallment` | Tombstones de compra + filhos | Transação. |
| `saveGoal`, `removeGoal` | Objetivo, saldo absoluto, exclusão lógica | Save em transação; remove em statement único. |
| `writePreferences` | Upsert de `local_preferences` | Transação; preferências locais, sem escopo de sync. |
| `applyImportPlan` | Cadastros, séries, objetivos, transações e `local_import_records` | Uma transação externa com repositório vinculado ao `tx`. Deduplica chaves antigas inclusive após exclusão. Deduplicação por nome/descrição é conveniência de importação local, não identidade global. |
| `loadBackupData` / `replaceRows` | Recria schema conhecido em staging e substitui linhas; migra para versão atual | Staging descartável; não executa schema/SQL do arquivo no banco ativo. Inserts com lista de colunas; FKs conferidas. |
| `restoreBackup` | Substitui registros das 11 tabelas do banco ativo com schema atual | Valida shape/versão; callback de proteção deve ter sucesso; substituição em uma transação. Integridade da entrada foi conferida no staging. Falha tardia reverte os registros. |

Orquestração em [`localData.ts`](../apps/mobile/src/files/localData.ts): `prepareImport` valida SQLite/JSON em cópia, importa CSV/XLSX por plano e calcula prévia sem alterar a base ativa. `commitImport` recaptura merge desktop no momento da confirmação, protege a base e aplica append/restore. `mergeBackupData` remapeia cadastros por nome, rejeita mesmo ID com conteúdo diferente, mantém prioridades locais e aloca posições livres. Isso não substitui merge por ancestralidade.

SQLite/backup de recuperação usam `VACUUM INTO`; JSON v1 mobile contém plataforma/schema e as 11 tabelas; CSV não guarda tombstones, prioridades, chaves de importação ou auditoria completa. Arquivos internos são privados, transferências temporárias são removidas e o Android desabilita backup automático (`allowBackup=false`). A criptografia local não está implementada.

## 4. Decisões adotadas nesta etapa

1. Contratos isolados em `packages/sync-protocol`, sem motor/serviço. O core continua financeiro. DTOs completos para o domínio futuro estão tipados; **validação executável de domínio se limita ao piloto manual sem referências**. Não anunciar os outros tipos antes de seus adaptadores/invariantes/testes.
2. Sidecar de identidade, UUIDv4 seguro e UUIDv5 por slot comprovado, sem substituir PK/FK locais. Não houve backfill ou geração de IDs globais em bases nesta etapa.
3. Revisões imutáveis, snapshots completos, pais/heads e tombstones; sem LWW por horário, soma de saldos ou descarte de ramo. Unidade de lote é commit, prioridades são listas inteiras. Formalização em [contratos](local-first-sync-contracts.md).
4. Perfil canônico inteiro compatível com RFC 8785; UTF-8, base64url sem padding, conjuntos ordenados e int64 decimal textual. Novas propriedades/versões não entram silenciosamente em envelopes v1.
5. Suite `lp-sodium-v1` candidata: XChaCha20-Poly1305 combinado, Ed25519 detached direto, sealed boxes de libsodium. É candidato técnico, **não aprovação dos bindings nem da segurança do produto**. [Spike e limites](local-first-sync-crypto-spike.md).
6. Apenas proteção local agora: Android usa a versão final real no guard e verifica FKs por versão; desktop protege upgrade e atomicidade. Construtor desktop síncrono exige `VACUUM INTO`, alternativa ao backup assíncrono recomendado na proposta. Backups manuais existentes continuam com suas APIs.
7. Migrations 1–5 mobile e SQL histórico desktop não ganharam colunas de sync nem foram reescritos. Não reservar 6/12. Rebuild de constraints e sidecars são **ensaios descartáveis**, não migrations de produção.
8. Formatos v1 de backup continuam intactos. Não guardar credenciais, sessão, segredo, cursor/dispositivo ativo em futuros backups financeiros portáveis. Cópia física exige invalidação operacional antes de reconectar no futuro.

## 5. Preparação das migrations e proteção sem perda

Fixtures e procedência: [README](fixtures/local-first/README.md). Android v1–v4 usa DDL histórico real e dados sintéticos. Desktop pre-11 é reconstruído a partir do caminho aditivo conhecido, pois a história disponível não fornece uma exportação de produção v10. Não declarar essas fixtures como bases reais de usuários nem como cobertura de todo schema histórico desktop.

O manifesto de teste captura `user_version`, schema/índices, colunas, contagens, registros ordenados e SHA-256 de **todas** as tabelas; inclui excluídos, prioridades e ledger de importação. Comparação pós-migration projeta exatamente as colunas de origem, não apenas os totais. Cópia física é comparada ao manifesto prévio. Nenhum teste faz leitura de dados financeiros da pessoa para produzir fixtures.

Roteiro para a próxima migration (ainda não aplicada):

1. Determinar versão/esquema antes de qualquer DDL; recusar versão futura. Criar cópia consistente fora da transação; falha de backup aborta. Registrar caminho, versão e manifesto. Cópias não são apagadas automaticamente pela atualização.
2. Fazer sidecars aditivos primeiro: `sync_local_state` singleton/linhagem e `sync_identity` com PK `(entity_type, local_id)` e `global_id UNIQUE`, sem FK que cause cascade da identidade na exclusão. Sem binding/credencial/ativação de sync. Backfill inclui registros excluídos; nomes/IDs fixos/hex não são prova global. CSPRNG Android precisa do binding escolhido, não de `randomblob` para IDs globais.
3. Inserir sidecars e qualquer alteração financeira futura na mesma transação. Conferir manifestos e unicidade; em conflito, abortar sem OR IGNORE ou “limpar duplicatas”. Testar falha após backfill/DDL e reabertura. No mobile, manter a execução com `tx`.
4. Para novas colunas, usar NULL/default local compatível, sem reescrever colunas antigas. `occurrence_date` desktop desconhecida permanece NULL e identidade unresolved. Datas de auditoria legadas em SQLite são preservadas como strings de proveniência; instante de migration não é data histórica do objeto.
5. Unicidade ativa de cadastros requer reconstrução. O ensaio em `tools/sync-stage0/catalog-rebuild.cjs` preserva o **grafo financeiro inteiro**: cópias TEMP dos nove componentes, DROP na ordem inversa, CREATE dos pais antes dos filhos, INSERT explícito, recriação de índices, `foreign_key_check` e COMMIT. Não renomeia pais existentes e mantém `foreign_keys=ON`; não deixa CASCADE apagar prioridades. Testes comprovam rollback e preservação por coluna. **Não usar esse script no banco ativo**: índices têm prefixo de ensaio, timestamps novos ficam desconhecidos e os repositórios/backup validators ainda não reconhecem as novas colunas.
6. Antes de publicar o rebuild, adaptar filtro de ativos, colisão de nome, exclusão lógica, leitura de referências tombstonadas, timestamps/proveniência e snapshots. O ensaio permite dois cadastros com mesmo nome quando um está excluído, sem remapear referências existentes.
7. Atualizar conjuntamente `backupTables`, colunas por versão, `tablesForVersion`, `verifyDatabase`, `captureBackup`, `replaceRows`, `desktopBackupData`, parser de formatos, merge e versões do JSON. Não usar `migrations.length` indiscriminadamente para rotular um **desktop futuro** desconhecido como mobile atual. Formato novo deve carregar plataforma/schema/proveniência explícitos e manter leitura legado v1.
8. Staging deve migrar/validar sem executar SQL recebido; preservar arquivo e banco anterior até comparar conteúdo/integridade. Restore mantém IDs comprovados, protege dados posteriores/outbox, pausa/desvincula transporte e gera cadastro operacional novo. Não emitir exclusões por ausência no backup. O desktop precisa de um caminho de staging/restore próprio antes de oferecer essa função.

Ainda faltam fixtures adicionais de schemas antigos desktop, bancos maiores e ensaio nas versões SQLite nativas de Android/Electron. Uma reconstrução ampla custa espaço/tempo: medir com armazenamento limitado e interrupção de processo antes de release. Testes atuais usam SQLite real do Node, não o driver Android.

## 6. Verificação executada e limites

Comandos de validação: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:contracts`. O spike tem comandos próprios em seu relatório; nenhuma dependência criptográfica foi acrescentada ao app ou ao lockfile do monorepo.

Cobertura nova: preservação por coluna de Android 1/2/3/4 e desktop pre-11; reabertura e uso sem conta; SQLite/JSON restore atual; WAL na recuperação; falha de cópia; falha tardia e rollback de DDL/dados/versionamento; proteção de futura migration sobre Android 5; INSERT tolerante a coluna aditiva; rebuild de cadastros com FKs ativas/índices parciais; bytes canônicos, zero/null/int64, assinatura/hash e rejeição de adulterações no spike. Testes existentes continuam verificando recusas de arquivos inválidos/futuros e rollback de restore/importação.

Sem mudança nativa ou schema publicado nesta etapa; não foi feito build/ensaio Android ou release Electron. O spike no executável instalado não foi executado: `RunAsNode=false` abriu a interface, que foi encerrada sem ações financeiras; só o Node/Linux forneceu resultados criptográficos. Não alegar compatibilidade de driver Android, cofre, Electron empacotado, crash por energia ou uso em aparelho real a partir dos testes Node.

## 7. Pendências e entrada na Etapa 1

| Pendência | Condição de entrada / momento |
| --- | --- |
| Binding Android e Electron definitivo | Executar os mesmos vetores em Hermes/JSI e Electron main real, AEAD/assinatura nos dois sentidos, sealed box, CSPRNG e falhas. Selecionar/pinar versões; tratar bytes/ABI/rotação e realizar revisão independente. **Antes de dados reais; o spike não aprovou o transporte.** |
| IdP / provisionamento | Escolher IdP auto-hospedável, onboarding de conta/PKCE, bootstrap da autoridade do vault, assinatura HTTP e registro de dispositivos. Sem implementação nesta etapa. |
| Recovery/trust | Contratos gerais estão documentados; parâmetros de bundle, código/KDF aleatório, UI de confirmação/fingerprint, perda do último aparelho e política de rotação precisam de decisão/revisão. |
| Modelo de conflito visível | Contrato de branches/expectedHeads definido; confirmar UI/contabilização de base comum, rascunhos e recuperação como novo objeto antes do piloto. |
| Quotas / retenção | Candidatos 1 MiB/commit e 100 commits/página; negociar limites e documentar testes de atomicidade. Sem GC/tombstone TTL v1. |
| Bancos existentes | Fixtures adicionais desktop e validação nativa; formato de backup com identidade e origem e revisão de dois bancos preenchidos (Etapa 2). Não onboarding automático. |
| Planejamento/importação | Prova de slots/epoch, promoção de cache, aliases e ambiguidades; core/geradores dos dois clientes; chave de importação global versionada. Fora do piloto da Etapa 1. |
| Banco/exports cifrados | Decisão separada de E2EE; SQLCipher e cifragem de arquivo/WAL/backups não foram avaliados nem prometidos. |

Para começar a Etapa 1, usar **bases de teste vazias e separadas** e somente `manualTransaction` sem cadastro/cartão/pagamento. Preparar a migration mínima de sidecars/revisões/heads/tombstones/outbox/inbox em ambos os drivers, com outbox e mudança financeira na mesma transação. Conectar o binding escolhido depois de executar os vetores nativos; depois implementar ambiente de API/PostgreSQL/IdP, aprovação de aparelhos e fluxo manual opt-in. Conservar o funcionamento local e seguir os critérios de perda de resposta, retry, crash, concorrência, exclusão offline e isolamento da proposta. Nenhum desses serviços foi iniciado por esta entrega.

## 8. Arquivos da entrega

Modificados nesta etapa:

- `.gitignore`: saída compilada do pacote novo.
- `package.json`, `package-lock.json`: workspace/validação do protocolo; sem crypto nos apps.
- `apps/desktop/src/main/database.ts`: inicialização protegida.
- `apps/mobile/src/db/migrations.ts`: guard de backup independente da versão 5 e FK check por versão.
- `apps/mobile/src/db/repository.ts`: colunas explícitas no INSERT de cadastros.

Criados:

- `apps/desktop/src/main/migrationProtection.ts`, `migrationProtection.test.ts`.
- `apps/mobile/src/db/migrationProtection.test.ts`.
- `docs/local-first-sync-stage0.md`, `docs/local-first-sync-contracts.md`, `docs/local-first-sync-crypto-spike.md`.
- `docs/fixtures/local-first/README.md`, `desktop-v10.sql`, `mobile-v1.sql`, `mobile-v2.sql`, `mobile-v3.sql`, `mobile-v4.sql`.
- `packages/sync-protocol/package.json`, `tsconfig.json`, `.eslintrc.json`; `src/index.ts`, `types.ts`, `canonical.ts`, `validation.ts`, `envelope.ts`, `contracts.test.ts`; `fixtures/serialization.json`, `crypto-input.json`, `crypto.json`.
- `tools/sync-stage0/README.md`, `create-database-fixtures.ts`, `create-protocol-vectors.ts`, `database-manifest.cjs`/`.d.cts`, `catalog-rebuild.cjs`/`.d.cts`, `crypto-native.py`, `crypto-desktop.cjs`.

`README.md` já estava modificado e `docs/local-first-sync-proposal.md` já estava sem tracking ao início; ambos foram lidos/preservados, **não editados por esta entrega**. `packages/core` foi auditado e suas 61 verificações passaram, sem alteração de arquivos.

Resultado final: 225 testes (core 61, desktop 58, mobile 76, protocolo 30), typecheck, lint e build de contratos aprovados; runners do spike aprovados no recorte Node/Linux. Não há prova nativa Android/Electron nem release/build nativo nesta etapa.
