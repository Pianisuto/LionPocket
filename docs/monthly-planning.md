# Margem de segurança mensal

A margem de segurança é uma restrição de planejamento para imprevistos, definida separadamente para cada mês. Não é despesa, lançamento, categoria, conta a pagar ou movimentação de dinheiro. Não altera entradas, saídas, saldo realizado, saldo projetado original, renda comprometida, gráficos ou contas a caminho. Nenhuma margem é copiada automaticamente para o mês seguinte.

O [reforço mensal dos objetivos](goal-monthly-reinforcement.md) é um planejamento separado, por objetivo e mês, e não faz parte da margem de segurança.

## Uso e apresentação

Em **Recorrências → Planejamento do mês**, a pessoa define ou edita a margem em um formulário temporário. O mês aparece tanto na seção quanto no editor; remover a margem é uma ação explícita dentro do editor, e salvar zero também a desativa. Desktop aproveita o seletor de mês da barra existente. Android usa o mesmo estado de mês da tela principal, com navegação anterior/próximo na seção de planejamento. A seção tem identidade própria e fica fora das listas/totais de recorrências.

No Dashboard Desktop, os quatro cards e o valor principal de **Saldo projetado** ficam iguais. Com margem, apenas a dica passa a mostrar “R$ … após margem de segurança”. Sem margem/zero, continua “Se tudo ocorrer como planejado”. No Mobile, a informação auxiliar aparece junto ao saldo projetado no card de saldo existente e na Visão geral; o restante desses cards permanece igual. Resultados negativos são mostrados normalmente, com a cor de atenção já existente no Mobile.

`monthlyPlanningBalance` no core compartilhado devolve `projectedBalance`, `safetyMargin` e `balanceAfterSafetyMargin`. A subtração ocorre em centavos e não limita o resultado a zero. Por exemplo, saldo projetado de R$ 300 com margem de R$ 500 resulta em -R$ 200 após margem. O [Dinheiro protegido e Livre agora](protected-money-free-now.md) usam esta margem; nenhuma transferência/reserva automática existe.

## Modelo e persistência

`MonthlyPlanning` pertence ao core e contém `month` (`AAAA-MM`) e `safetyMarginCents` (inteiro seguro não negativo). A tabela SQLite `monthly_planning` usa os mesmos nomes/colunas nas duas plataformas: `id`, `month`, `safety_margin_cents`, `created_at`, `updated_at` e `deleted_at`. A identidade local é o próprio mês, com unicidade e `CHECK(id=month)`; não é uma preferência em settings nem uma recorrência. O agregado poderá ganhar outros componentes de planejamento no futuro, em uma evolução explícita de schema; nenhum desses campos existe agora.

As migrations são Desktop **15** e Mobile **10**. Criam a tabela vazia (bases antigas começam sem margem) e ampliam o CHECK de tipos de `sync_identity` com a reconstrução transacional de sidecars que o projeto já utiliza. Históricos de migrations permanecem inalterados. Filas, envelopes preparados, recibos, DAG, estado de sincronização e dados financeiros existentes são preservados. O backup de proteção anterior à migração e as verificações de integridade/referências continuam nos adaptadores existentes.

Zero é um `put` do agregado, representando um componente desativado. Não exclui a identidade do mês nem cria um tombstone. Isso permite remover/redefinir a margem repetidamente e preparar o agregado para outros componentes futuros. Ausência de registro e zero têm a mesma apresentação/cálculo.

## Local-first, sync e desvinculação

O CRUD SQLite funciona completamente offline, sem conta ou servidor. Com sync, os triggers financeiros capturam alterações atomicamente com o salvamento e publicam a entidade `monthlyPlanning`, snapshot `{month, safetyMarginCents}`, pelo transporte E2EE/DAG existente. A identidade no wire é UUID v5 derivado do cofre e mês, de modo que aparelhos do mesmo cofre reconheçam o mesmo agregado. Não existem vínculos com lançamentos ou dependências de catálogos. Alterações concorrentes incompatíveis entram na revisão de conflitos existente, com uma descrição própria de planejamento.

O servidor anuncia o novo escopo financeiro `monthlyPlanning`. O transporte, envelopes, criptografia e versões de protocolo/domain/control não mudam, mas a compatibilidade do discovery é fail-closed: clientes anteriores a essa funcionalidade rejeitam o escopo desconhecido em `assertCompatibleEnvironment`, com `unsupported_capability`, antes de receber revisões. Portanto, atualizar somente o servidor interrompe o sync dos clientes antigos; a quarentena de revisões não é alcançada nesse caso. **Servidor e todos os clientes vinculados precisam ser atualizados em conjunto** para versões que conheçam esse escopo. Não há negociação para rolling upgrade neste PR. Dados locais e pendências permanecem preservados, e o uso offline continua disponível durante a incompatibilidade.

**Desvincular servidor preserva todas as margens**, incluindo mudanças pendentes. O controlador compartilhado do PR #20 remove transporte/credenciais, não a tabela financeira. Margens podem ser editadas em modo local após a desvinculação. Uma nova baseline inclui cada mês preservado; ao mudar de cofre, o wire recebe o namespace do novo cofre, mantendo a identidade local do mês. Reconexão de um backup ao mesmo vínculo captura diferenças locais, inclusive zero. Os caminhos genéricos de arquivo/rebaseline de epoch também incluem essa entidade e conservam seus snapshots.

## Backup, restauração e exportação

Backups SQLite do Desktop e Android incluem a tabela naturalmente. O JSON completo do Desktop anuncia schema 15; o conversor compartilhado o mapeia para Mobile schema 10 e preserva os centavos. JSON/SQLite do Mobile passam pela whitelist e validação/staging atuais. Backups antigos continuam migrando para uma tabela vazia. Restauração mantém o comportamento existente de desativar transporte até reconexão explícita.

Importação JSON aditiva mantém a política existente: agrega meses inexistentes, não substitui identidades com valores divergentes silenciosamente. Um conflito no mesmo mês aborta a importação para revisão. O CSV de lançamentos continua contendo somente movimentações, sem margem de segurança.

## Cobertura

As regressões cobrem validação/cálculo no core, meses independentes, CRUD/zero, persistência e reabertura dos adaptadores Desktop/Android, SQLite/JSON/staging/restore e conversão Desktop → Android. O upgrade Desktop parte de um fixture com o CHECK de identidade v14 reconstruído: rejeita `monthlyPlanning` antes da migration e permite seu salvamento após v15, preservando linhas financeiras e sidecars de sync populados. Android parte do schema v9 real e verifica também rollback tardio. Testam também sync bidirecional, conflitos, edição offline/reconexão, nova baseline após desvinculação, o controlador real de desvinculação nas duas plataformas e replay de epoch com margem ativa/zero.

Testes de apresentação verificam o Dashboard Desktop renderizado (quatro cards, projeção original e texto anterior sem margem) e a apresentação condicional compartilhada pelas duas telas de saldo Mobile. As fixtures descartáveis de atualização nativa Android incluem margens de dois meses, para comparação de todas as tabelas após instalação/migração/reabertura. O resultado de cada ensaio executado deve ser registrado no PR; testes com `node:sqlite` não substituem execução do Nitro SQLite no Android. Windows instalado/protocolo/DPAPI exige host descartável Windows e não pode ser afirmado a partir de Linux.
