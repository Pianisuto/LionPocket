# Dinheiro protegido e Livre agora (“Pode gastar hoje”)

Os dois valores são **derivados**: não existe tabela, coluna, migration, entidade de sync nem item de backup novo. As únicas fontes persistidas continuam sendo a [margem de segurança](monthly-planning.md), os [reforços mensais dos objetivos](goal-monthly-reinforcement.md) e os lançamentos. Nada disso é despesa, movimentação ou alteração de `savedAmount`, e nenhum valor derivado é sincronizado.

Toda a regra está no core (`packages/core/src/free-now.ts`). Desktop (`getOverview`) e Android (`monthlyOverview`) chamam a mesma função com os mesmos dados; os componentes só formatam.

## Dinheiro protegido

`dinheiro protegido = margem de segurança do mês + reforços ativos dos objetivos do mês`, em centavos (`protectedMoney`).

O reforço só conta com o objetivo `planned` ou `saving` (regra do PR #22). Pausado, concluído, cancelado ou excluído não conta, mas o valor segue no histórico. Cada mês é independente e nada é copiado para o seguinte.

## Saldo em mãos: fonte canônica

O LionPocket **não conhece saldo bancário**, saldo inicial nem sobra de meses anteriores. A única noção de “dinheiro que já se movimentou” é o **Saldo realizado** do mês (`summarizeMonth(...).realizedBalance` = recebido − pago no mês), o mesmo número exibido nos cards. Livre agora (“Pode gastar hoje”) o usa como ponto de partida (`realizedBalanceCents`, “Em mãos” na interface), nunca como saldo bancário. Se a pessoa tem dinheiro de meses anteriores que não está lançado, ele não entra.

## Livre agora

```
Livre agora = ponto mais baixo do saldo até o fim do mês − dinheiro protegido
```

A pergunta que ele responde é: *quanto dá para gastar agora sem que o saldo fique negativo em algum dia do mês?* O resultado **não é limitado a zero**; negativo significa que, se tudo ocorrer na data prevista, falta dinheiro em algum momento.

### Simulação dia a dia

Parte-se do saldo em mãos e, de hoje em diante, aplica-se cada evento na sua data. O menor saldo desse caminho (incluindo o saldo de hoje) é o ponto mais baixo (`lowestPointCents`, na primeira data em que ocorre, `lowestPointDate`).

1. **Contas**: despesas ainda `planned` do mês (inclusive atrasos carregados de meses anteriores, que saem hoje), pela própria data de vencimento. Compras de cartão aparecem agrupadas por fatura (“Fatura X”). Pagas, canceladas e de valor zero não entram.
2. **Entradas**: receitas ainda `planned` com data de hoje em diante. Recebida ou cancelada nunca conta como futura. Receita prevista com data **já passada** (atrasada) não entra: não se conta com dinheiro que não chegou. Entradas de valor zero são ignoradas.
3. **Protegido**: margem + reforços do mês, subtraídos uma vez do ponto mais baixo.

Uma conta paga depois de uma entrada que a cobre não reduz o valor imediato; uma que a entrada não cobre, reduz. Cartão, parcelas e recorrências já são lançamentos com vencimento calculado (fatura, parcela, ocorrência) e contam uma vez, pela própria data. Pagar uma fatura move seus lançamentos de “pendente” para “realizado”, sem contagem dupla.

### Linha do tempo

O mesmo caminho vira `FreeNow.timeline`: uma linha “hoje” (em mãos) e uma linha por evento, com data, descrição, valor com sinal e **saldo corrente**. Exatamente uma linha (a primeira de menor saldo) vem marcada como `lowest` (“mais apertado”). É esta lista que a interface mostra em “Ver dia a dia”; nenhum número é recalculado na UI.

### Regra determinística do mesmo dia

No mesmo dia, as **contas saem antes das entradas**. Não há garantia de que o dinheiro chegue antes do vencimento, então a regra é a conservadora. Uma entrada ainda prevista para hoje é uma entrada futura; as contas de hoje saem antes dela.

### Mês e virada

Livre agora só existe para o **mês atual** (`calculateFreeNow` devolve `null` para qualquer outro). Meses passados e futuros continuam mostrando o saldo após proteções. O período é o mês consultado: no último dia do mês, o que vence no mês seguinte não entra. No dia 1º, o mês novo usa a própria margem e os próprios reforços; os do mês anterior não carregam.

## Estruturas do core

`ProtectedMoney` (`safetyMarginCents`, `goalReinforcementCents`, `protectedMoneyCents`), `ProtectionBalance` (acrescenta saldo projetado e saldo após proteções) e `FreeNow` (acrescenta `realizedBalanceCents`, `nextIncome` informativa, `lowestPointCents`, `lowestPointDate`, `commitmentsUntilLowestPointCents`, `incomesUntilLowestPointCents`, `timeline` e `freeNowCents`). Todos em centavos inteiros seguros. `freeNowHeadline`, `freeNowComposition`, `freeNowRowDate` e `protectionHint` geram os textos e linhas compartilhados pelas duas plataformas.

## Apresentação

- **Saldo projetado** continua sendo o card principal. Sem proteções, a dica original (“Se tudo ocorrer como planejado”) fica igual. Com proteções, a dica mostra “R$ … após margem de segurança”, “… após reforços dos objetivos” ou “… após proteções”.
- **Manchete**: “Pode gastar hoje: R$ X” com a nota “Sem ficar no vermelho este mês. O mais apertado é 26/10.”. Quando o resultado é negativo, vira “Faltam R$ X” com “Pelo que está planejado, o saldo não cobre tudo até 26/10.” (a frase acrescenta “e contando suas proteções” quando há margem ou reforços). Se o ponto mais apertado é hoje, a data é omitida.
- **Detalhe (modal no Desktop, “Ver dia a dia” no Android)**: lista a linha do tempo (Hoje → cada conta/entrada; o Desktop mostra o saldo corrente em todas as linhas, com “Saldo” apenas no cabeçalho; o Android mostra o de “Em mãos” e o da linha “mais apertado”) e, abaixo, a conta final: menor saldo do mês, − margem, − objetivos (omitidos quando zero) e o resultado.
- **Desktop**: “Pode gastar hoje” fica dentro do card “Saldo projetado”, ao lado do valor projetado, separado por uma linha vertical discreta. O valor disponível e a seta abrem o modal com a manchete, “Seu saldo, dia a dia” (selo de data, nome, movimento e saldo em cada linha, com destaque rosa no ponto mais apertado) e o painel “A conta”. A grade mantém quatro cards, em quatro ou duas colunas conforme o espaço disponível. A grade passa para duas colunas antes de os dois valores ficarem apertados.
- **Android**: o mesmo bloco, com “Ver dia a dia”, dentro do card de saldo existente e na Visão geral.
- Valor em falta aparece com a cor de atenção de cada plataforma.

## Fora do escopo

Integração bancária, saldo inicial, transferência ou reserva automática, previsão por IA, orçamento por categoria e alteração automática de `savedAmount`.

## Cobertura

`packages/core/src/free-now.test.ts` cobre cada regra acima (sem proteções, só margem, só reforços, ambos, entrada amanhã, várias contas, contas depois da entrada cobertas ou não por ela, mesma data, receita recebida/atrasada, despesa paga, cancelados, sem entrada futura, negativo, objetivos pausados/concluídos, troca de mês e virada, cartão/parcela/recorrência e um caso real de outubro). `apps/desktop/src/main/freeNow.test.ts` roda a mesma massa nos bancos SQLite do Desktop e do Android e exige resultados idênticos. Também cobre a linha do tempo (saldo corrente, uma única marca de mais apertado, despesas antes de entradas no mesmo dia) e as manchetes. Os testes de apresentação verificam o Dashboard Desktop renderizado e o modelo de exibição Mobile.
