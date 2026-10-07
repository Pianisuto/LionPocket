# Planejamento local no LionPocket Mobile

A seção **Planejamento do mês** em Recorrências permite definir a [margem de segurança mensal](monthly-planning.md): um valor para imprevistos que não cria despesas nem altera o saldo financeiro. A margem funciona offline, participa de sync e backup e permanece ao desvincular o servidor.

> Estado atualizado: [paridade funcional local](mobile-functional-parity.md). O novo bloco completa os fluxos restantes, adiciona preferências e migração v5 com suporte a valores zero.


Este bloco complementa o [uso financeiro diário](mobile-daily-finance.md). A implementação segue as decisões de produto: React Native bare, Android, SQLite privado do aplicativo, funcionamento offline e domínio compartilhado com o desktop. Não há backend, conta ou sincronização. As alterações locais do bloco anterior foram preservadas.

## Fluxos disponíveis

- **Recorrências:** entradas e saídas, ativas ou pausadas, ocorrência única, semanal, mensal, intervalo personalizado em dias/semanas/meses/anos e meses do ano escolhidos. Intervalos personalizados podem seguir o calendário fixo ou a última data efetiva. Categoria, pagamento, cartão, início, dia de cobrança, valor e observações são editáveis.
- **Parcelamentos:** criação a partir da parcela atual, lançamentos mensais até a última parcela, progresso por mês e pagamentos acumulados. Edição do valor, calendário, total e numeração da série, com preservação dos valores e datas das parcelas concluídas. Exclusão remove as parcelas pendentes e preserva as concluídas. Ao cadastrar uma compra, a tela abre o mês do vencimento informado.
- **Objetivos:** alvo, valor guardado, progresso, restante, sugestão mensal conforme prazo, prioridade, situação explícita, categoria, modelo, link e observações. Editar o valor guardado não cria movimentação financeira. Atingir o alvo não muda automaticamente a situação, como no desktop.
- **Cadastros:** criação, edição e exclusão de categorias, formas de pagamento e cartões. Categorias têm cor e tipo; cartões têm fechamento opcional e vencimento. Excluir um cadastro remove seus vínculos dos lançamentos, séries e objetivos sem remover valores ou datas. Uma categoria em uso por lançamentos ou séries não pode mudar de tipo.
- **Lotes mensais:** seleção de pendentes da consulta, seleção individual, limpar seleção e concluir selecionados; pagamento da fatura agrupada por cartão e vencimento. A confirmação informa quantidade e regra de realização. Todas as baixas usam uma única transação SQLite, preservam o realizado informado (inclusive zero) e usam hoje como data. Itens já concluídos/excluídos e IDs repetidos não são baixados novamente.

Os formulários e seletores usam telas móveis, com áreas de toque, listas roláveis e mensagens de erro. O teclado é recolhido ao abrir seletores e salvar os novos formulários. Datas são digitadas em ISO e valores aceitam vírgula ou ponto decimal.

## Domínio compartilhado

`packages/core/src/planning.ts` extrai as regras existentes do desktop para:

- gerar datas fixas a partir da âncora original, sem acumular o ajuste de fevereiro;
- tratar semanas, intervalos personalizados e meses escolhidos;
- determinar a data efetiva: compra no cartão; pagamento/recebimento realizado nas demais formas; data prevista quando ainda não realizado;
- projetar intervalos a partir da última data efetiva;
- converter uma ocorrência em compra/vencimento segundo o ciclo da fatura;
- planejar a correção de parcelas, renumeração, início histórico, calendário e restrições contra redução abaixo de parcelas concluídas ou colisão com suas datas.

O desktop usa essas funções por adaptadores de seus registros SQL; interface, banco e operações Electron permanecem próprios. Os 53 testes anteriores do desktop continuam passando. O mobile usa `calculateGoal`, calendário, ciclo do cartão, competência, totais e agrupamento de faturas já existentes no core. Validações dos novos formulários também ficam no core, sem adicionar dependência de SQLite ou Electron ao domínio.

### Regras de cartão e histórico

Uma cobrança antes do fechamento entra na fatura que está fechando; no dia do fechamento ou depois, entra na próxima. Quando o vencimento precede o fechamento no calendário, o pagamento ocorre no mês posterior. Por exemplo, fecha 20 e vence 5: compra em 19/09 vence 05/10; compra em 20/09 vence 05/11. Fechamento ausente usa o próximo vencimento a partir da compra.

Várias cobranças semanais/personalizadas da mesma recorrência podem compartilhar um vencimento. A unicidade dessas cobranças segue a compra, e não somente a fatura. Para localizar cobranças cuja fatura aparece até dois meses depois, a geração considera os 70 dias anteriores ao mês consultado, como no desktop.

Editar uma recorrência mensal atualiza projeções abertas sem valor realizado/data de realização. Pagos, recebidos, cancelados e projeções com valor realizado ficam preservados. Trocar a frequência/calendário descarta apenas projeções abertas sem realização e as regenera sob demanda. Alterar uma ocorrência de intervalo baseado no efetivo também recalcula projeções posteriores abertas. Pausar ou excluir a recorrência impede novas ocorrências e mantém lançamentos existentes.

Parcelas anteriores à primeira registrada contam como já pagas. Ao editar a compra, alterar a parcela atual em relação à parcela original renumera a série inteira. Metadados e total acompanham a série; datas e valores concluídos permanecem. O progresso financeiro conta pagamentos até o fim do mês consultado; a barra de calendário mostra a parcela visualizada em relação ao total. Esses dois indicadores têm sentidos distintos, como no desktop.

## SQLite e atualização de bancos existentes

As migrations 1 e 2 permanecem intactas. A migration 3 é aditiva: cria recorrências, compras parceladas e objetivos, acrescenta origem, identidade da ocorrência e número/total de parcelas aos lançamentos, e cria índices. Nenhuma tabela ou dado legado é recriado. As novas referências são anuláveis. Registros antigos recebem origem `manual`.

`occurrence_date` guarda a identidade original de uma ocorrência mesmo após ajustar seu vencimento/compra. Marcadores de exclusão impedem regenerar uma ocorrência excluída. Esse detalhe adicional da persistência móvel também impede duplicação ao mover uma ocorrência única/semanal para outra data; não foi acrescentado ao banco desktop. A equivalência financeira é testada nos casos cobertos, sem exigir schemas iguais.

Operações de série, geração e lotes usam exclusivamente o handle `tx` das transações Nitro SQLite. Não chamam a conexão enfileirada de dentro do callback; isso evita bloquear a fila esperando por si própria. Falhas revertem a operação inteira. `user_version` só avança após sucesso, e bancos de versão futura são recusados. Índices e a fila de transações protegem geração concorrente. O banco continua em `files/lionpocket.sqlite`, separado do Electron.

## Diferenças restantes em relação ao desktop

Prioridades/ordenação mensal, sugestões do histórico, busca e filtros avançados, painel anual com categorias, importação/exportação e backup/restauração foram concluídos no [bloco local-first complementar](mobile-local-first.md). Os cadastros completos, valores zero, calendário Android, links de objetivos e sugestão automática de realização foram concluídos no [bloco de paridade funcional](mobile-functional-parity.md).

## Verificações executadas em 29/09/2026

- `npm test`: **132 testes aprovados** — 40 core, 53 desktop e 39 mobile. Os testes usam SQLite real, incluindo reabertura em disco, migração v1/v2, rollback das migrations e de gravações/lotes, tombstones, valores realizados, geração concorrente e múltiplas compras na mesma fatura.
- **13 testes de comparação direta** dentro da suíte móvel executam as mesmas operações no banco desktop e no móvel: todas as frequências, ciclos com fechamento/vencimento distintos ou fechamento ausente, limites de mês, edição de recorrências com meses existentes, data efetiva/cartão, atualização de parcelas, pagamentos, exclusões, objetivos e totais mensais.
- `npm run typecheck` e `npm run lint`: aprovados.
- `npm run mobile:build:android` e `npm run mobile:build:android:release`: aprovados para as quatro arquiteturas Android configuradas. Release contém JavaScript/Hermes e foi instalado por atualização (`adb install -r`). A assinatura release continua usando a configuração de desenvolvimento existente.
- Emulador **LionPocket_API_36**, Android 16/API 36: APK release, modo avião e nenhum redirecionamento ao Metro. Atualização de banco **v2 → v3** com comparação de todas as colunas antigas: os cinco lançamentos anteriores foram preservados exatamente. `integrity_check` retornou `ok` e `foreign_key_check` vazio. Migração v1 → v3 e rollback v2 → v3 também foram validados automaticamente.

Pela interface foram criadas recorrências de entrada e de cartão, um parcelamento e um objetivo. O objetivo foi editado de 25%/Guardando para 50%/Pausado. A compra foi renumerada de parcela 4/4 para 5/6, com previsão de R$ 210,00 em 07/12; o SQLite confirmou que as parcelas pagas continuaram com planejado/realizado de R$ 200,00 e vencimentos 05/10 e 05/11. A fatura com três lançamentos foi concluída em lote, e a confirmação foi cancelada antes de um pagamento anterior. Seleção de pendentes e conclusão de selecionados também passaram.

Foram criados, renomeados e excluídos cadastros temporários de categoria, pagamento e cartão, incluindo cancelamento da confirmação de exclusão. O ciclo do cartão temporário foi alterado de fechamento 15/vencimento 25 para fechamento 16/vencimento 26 e conferido na lista. Os cadastros anteriores permaneceram. Após forçar o fechamento e reabrir o app offline, o objetivo editado, recorrências, compra corrigida e baixas continuaram presentes. A comparação final antes/depois de fechar e reabrir confirmou igualdade de todos os registros nas sete tabelas. Não foram encontrados duplicados de ocorrência ou número de parcela. O saldo realizado de teste permaneceu em R$ 3.370,10 após a última conclusão em lote e a reabertura. A integridade final do SQLite permaneceu válida.

As evidências e o roteiro abaixo complementam as verificações automatizadas. Para repetir, atualize com `-r` e nunca limpe o armazenamento antes da verificação de preservação.

### Roteiro do emulador

1. Abra a versão atual sobre o banco v2 e confira o saldo anterior e seus lançamentos.
2. Em Recorrências, crie a saída de R$ 99,90 no cartão que fecha 20/vence 5, com cobrança dia 20 e início em setembro. Confira geração em novembro. Crie também uma entrada mensal de R$ 1.500,00.
3. Em Objetivos, crie alvo de R$ 1.200,00, guardado de R$ 300,00, situação Guardando e prazo 31/12. Confira 25%, restante R$ 900,00 e sugestão mensal R$ 225,00. Edite e confira a atualização do progresso.
4. Em Parcelamentos, crie quatro parcelas de R$ 200,00 a partir da segunda, com compra 19/09 no mesmo cartão. Confira sugestão 05/10, parcela 2/4 e uma parcela anterior já paga. Navegue nos meses, pague e confira progresso. Edite a série para ampliar o total e confira que parcelas pagas mantêm valores/datas.
5. Na tela mensal, abra a confirmação de pagamento de fatura, cancele e confira que nada foi pago. Confirme o pagamento; teste também uma fatura com vários lançamentos e a conclusão de selecionados.
6. Em Cadastros, crie, renomeie e exclua itens personalizados; confira confirmação e atualização das listas. Ajuste cor da categoria e ciclo do cartão.
7. Exclua uma ocorrência e revisite o mês: ela não pode voltar. Pause/reative a recorrência e confira os meses futuros.
8. Force o fechamento e reabra ainda em modo avião. Confira recorrências, parcelamentos, objetivos, situações e lançamentos. Navegue novamente ao mesmo mês para verificar ausência de duplicação.
