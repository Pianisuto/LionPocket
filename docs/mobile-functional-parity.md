# Paridade funcional local — LionPocket Mobile

Entrega de 29/09/2026, sobre [planejamento](mobile-planning.md), [arquivos e prioridades](mobile-local-first.md) e [identidade visual](mobile-visual.md). A referência é o comportamento das telas, formulários e do banco do desktop atual. O desktop permanece inalterado. Android, SQLite, arquivos e calendário permanecem locais; não há backend, conta ou sincronização.

## Fluxos locais disponíveis

| Desktop | Mobile |
| --- | --- |
| Resumo mensal, saldo projetado, entradas/saídas planejadas e realizadas, renda comprometida e atrasos | Mês e **Visão geral do mês** |
| Distribuição das saídas por categoria, detalhes e porcentagens | Visão geral; toque na categoria |
| Próximas contas, faturas agrupadas, baixa individual/em lote, recentes e objetivos | Visão geral, com atalhos para editar e concluir |
| Gráfico anual, doze competências e categorias | **Ano**, com detalhes por mês |
| Escolha direta de mês/ano, mês atual e anterior/próximo | Toque no título do mês; seletor com ano e doze meses |
| Cadastro/edição/exclusão de lançamentos, valores planejados e reais distintos, realização zero, observações e ciclo do cartão | Mês; **Novo** e ações do lançamento |
| Realização sugerida para datas anteriores a hoje, enquanto a situação não for escolhida manualmente | Formulário de lançamento; conserva a escolha explícita ao mudar a data |
| Salvar e adicionar outro | Formulário novo; limpa descrição, valores e observações, mantendo tipo, categoria, pagamento, cartão, datas e situação |
| Sugestões do histórico sem sobrescrever campos preenchidos | Formulário novo; frequência/recência, preenchimento somente de campos vazios |
| Calendários, incluindo compra, vencimento, realização, início de recorrência, parcelas e prazo | Calendário Android em português, com digitação ISO opcional e cancelamento sem alteração |
| Prioridades mensais/herdadas de recorrências e ordenação | Fixar, retirar, subir/descer; movimenta a série e preserva itens ocultos pelos filtros |
| Preferência de mostrar/ocultar prioridades | **Mais → Preferências**; ocultar usa a ordenação normal e mantém posições salvas |
| Busca, filtros de tipo/situação/pagamento/origem e ordenação em ambas as direções | Filtros junto de Lançamentos |
| Recorrências, compras parceladas e objetivos | **Planejar**, com totais de recorrências ativas, parcelas do mês e progresso geral dos objetivos |
| Link de objetivo | **Abrir link**, somente http/https e mediante toque explícito |
| Cadastros padrão, categorias, pagamentos e cartões | Instalações novas recebem as 22 categorias do desktop; bancos existentes conservam seus cadastros. **Cadastros → Adicionar categorias padrão faltantes** complementa apenas os ausentes |
| Tema claro/escuro e privacidade local | **Mais → Preferências**; mesmas paletas do desktop, fontes e marca |
| Léo: resumo, próxima conta, objetivos, backup, CSV, tema, carinho, rugido, petisco, cochilo e acessórios | Toque no leão do cabeçalho ou **Mais → Falar com o Léo**; humor calculado com os números reais, piscadas/reação e acessórios do desenho SVG original |
| Importação XLSX e exportações CSV/JSON/backup | **Mais → Dados locais**; também importa CSV/JSON desktop e restaura JSON/SQLite mobile, com revisão e cópia obrigatória |

Janelas Electron, atalhos de teclado, arraste com mouse e atualização automática do executável são recursos da plataforma desktop. Seus fluxos financeiros usam controles de toque e o pacote Android. Abrir um link depende de haver aplicativo Android capaz de tratá-lo; os dados financeiros e demais funções locais não dependem da internet.

## Valores e proteção do banco

Lançamentos manuais e recorrências aceitam planejado zero, assim como o desktop. Objetivos aceitam alvo zero. Parcelas continuam exigindo valor positivo, conforme a regra do banco desktop. Realizado/guardado zero é preservado. JSON desktop com esses valores pode ser importado sem conversão monetária silenciosa. CSV continua com as onze colunas do desktop; para recuperação fiel use JSON Mobile ou SQLite.

As migrations 1–4 não foram alteradas. A migration 5 adiciona `local_preferences`. Para relaxar os `CHECK` antigos de valor positivo, SQLite exige reconstruir as tabelas de lançamentos, recorrências e objetivos. Isso acontece numa única transação, copiando todas as colunas e registros; as duas tabelas de prioridade são preservadas e reconstruídas com suas referências. As demais tabelas financeiras ficam intactas. Os índices são repostos e `foreign_key_check` é verificado antes de avançar `user_version`.

Ao abrir um banco existente v1–v4, o app grava uma cópia SQLite consistente em `files/backups` **antes de executar qualquer migration**. Falha na cópia impede a atualização; falha na reconstrução reverte a migration. Bancos novos recebem os cadastros padrão na mesma transação da migration final. Cadastros excluídos não reaparecem nas próximas aberturas nem em restaurações.

Backups v1–v4 são abertos e migrados em uma cópia temporária. Restaurar substitui somente os registros já validados, usando o schema/handle atual v5. Backups v5 têm onze tabelas, incluindo tema, visibilidade das prioridades, contador de carinhos e acessório do Léo. Backups antigos, sem preferências, usam os padrões escuro/prioridades visíveis/juba solta/zero carinhos. A tela reaplica as preferências após restaurar. Importar JSON desktop preserva as preferências móveis atuais.

## Verificação

- Testes do monorepo: 182 aprovados, incluindo comparação direta com SQLite desktop, valores zero, resumos, categorias, importações, versões antigas, rollback e preferências nos backups.
- Typecheck e lint do monorepo aprovados.
- Builds Android debug e release aprovados.
- Atualização release `adb install -r`, emulador API 36, modo avião. Banco v4 com quinze lançamentos: dez tabelas anteriores idênticas após a migration v5; a cópia de recuperação também contém os registros originais. `integrity_check = ok`, sem violações de referências.
- Formulário no APK release: calendário em português, realização automática de data passada, planejado/realizado zero e **Salvar e adicionar outro**; dois lançamentos de teste adicionados sem modificar os quinze anteriores.
- Tema claro/escuro, prioridades ocultas, visão geral, categorias, totais de planejamento e painel anual conferidos. Tema, contador de carinhos e acessório do Léo persistiram ao reiniciar e atualizar o APK.
- Exportações pelo seletor Android: JSON completo, SQLite e CSV mensal. JSON e SQLite comparados com o banco local: todas as onze tabelas idênticas, incluindo preferências e valores zero.
- Cancelar **Substituir os dados locais?** preservou exatamente as onze tabelas e os dezoito lançamentos atuais. Confirmar a restauração JSON recuperou os dezessete lançamentos exportados; o lançamento posterior permaneceu na cópia automática de recuperação. Restauração SQLite também comparada registro a registro, com integridade e referências válidas.
- Restauração SQLite v4 pelo seletor Android: revisão informa origem v4/cópia pronta v5; depois de confirmar, as dez tabelas financeiras permaneceram idênticas ao arquivo antigo e o banco ativo abriu em v5. Preferências antigas receberam os padrões; uma nova restauração do JSON v5 recuperou integralmente as onze tabelas e reaplicou a personalização do Léo.
- APK final: filtro combinado de situação/busca/origem com ordenação por valor e direção decrescente; limpeza de filtros; prioridades existentes e seus controles; seletor direto de mês e retorno ao mês atual; gráfico anual. Formulário também conferido a 360 dp e fonte 130%, mantendo os dois botões de salvar visíveis. Densidade e fonte restauradas ao terminar.
- Comparação final depois da navegação e reinicialização: onze tabelas idênticas ao backup exportado, dezessete lançamentos, os quinze anteriores intactos; sem alterações no código do desktop.

As evidências da sessão ficam em `/tmp/lionpocket-parity-validation`; esse diretório é temporário, não faz parte dos dados do aplicativo.
