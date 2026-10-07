# Dinheiro protegido e Livre agora

Os dois valores são **derivados**: não existe tabela, coluna, migration, entidade de sync nem item de backup novo. As únicas fontes persistidas continuam sendo a [margem de segurança](monthly-planning.md), os [reforços mensais dos objetivos](goal-monthly-reinforcement.md) e os lançamentos. Nada disso é despesa, movimentação ou alteração de `savedAmount`, e nenhum valor derivado é sincronizado.

Toda a regra está no core (`packages/core/src/free-now.ts`). Desktop (`getOverview`) e Android (`monthlyOverview`) chamam a mesma função com os mesmos dados; os componentes só formatam.

## Dinheiro protegido

`dinheiro protegido = margem de segurança do mês + reforços ativos dos objetivos do mês`, em centavos (`protectedMoney`).

O reforço só conta com o objetivo `planned` ou `saving` (regra do PR #22). Pausado, concluído, cancelado ou excluído não conta, mas o valor segue no histórico. Cada mês é independente e nada é copiado para o seguinte.

## Saldo em mãos: fonte canônica

O LionPocket **não conhece saldo bancário**, saldo inicial nem sobra de meses anteriores. A única noção de “dinheiro que já se movimentou” é o **Saldo realizado** do mês (`summarizeMonth(...).realizedBalance` = recebido − pago no mês), o mesmo número exibido nos cards. Livre agora o usa como ponto de partida (`realizedBalanceCents`, “Em mãos” na interface), nunca como saldo bancário. Se a pessoa tem dinheiro de meses anteriores que não está lançado, ele não entra.

## Livre agora

```
Livre agora = ponto mais baixo do saldo até o fim do mês − dinheiro protegido
```

A pergunta que ele responde é: *quanto dá para gastar agora sem que o saldo fique negativo em algum dia do mês?* O resultado **não é limitado a zero**; negativo significa que, se tudo ocorrer na data prevista, falta dinheiro em algum momento.

### Simulação dia a dia

Parte-se do saldo em mãos e, de hoje em diante, aplica-se cada evento na sua data. O menor saldo desse caminho (incluindo o saldo de hoje) é o ponto mais baixo (`lowestPointCents`, na primeira data em que ocorre, `lowestPointDate`).

1. **Contas**: despesas ainda `planned` do mês (inclusive atrasos carregados de meses anteriores, que saem hoje), pela própria data de vencimento. Pagas, canceladas e de valor zero não entram.
2. **Entradas**: receitas ainda `planned` com data de hoje em diante. Recebida ou cancelada nunca conta como futura. Receita prevista com data **já passada** (atrasada) não entra: não se conta com dinheiro que não chegou. Entradas de valor zero são ignoradas.
3. **Protegido**: margem + reforços do mês, subtraídos uma vez do ponto mais baixo.

Uma conta paga depois de uma entrada que a cobre não reduz o valor imediato; uma que a entrada não cobre, reduz. Cartão, parcelas e recorrências já são lançamentos com vencimento calculado (fatura, parcela, ocorrência) e contam uma vez, pela própria data. Pagar uma fatura move seus lançamentos de “pendente” para “realizado”, sem contagem dupla.

### Regra determinística do mesmo dia

No mesmo dia, as **contas saem antes das entradas**. Não há garantia de que o dinheiro chegue antes do vencimento, então a regra é a conservadora. Uma entrada ainda prevista para hoje é uma entrada futura; as contas de hoje saem antes dela.

### Mês e virada

Livre agora só existe para o **mês atual** (`calculateFreeNow` devolve `null` para qualquer outro). Meses passados e futuros continuam mostrando o saldo após proteções. O período é o mês consultado: no último dia do mês, o que vence no mês seguinte não entra. No dia 1º, o mês novo usa a própria margem e os próprios reforços; os do mês anterior não carregam.

## Estruturas do core

`ProtectedMoney` (`safetyMarginCents`, `goalReinforcementCents`, `protectedMoneyCents`), `ProtectionBalance` (acrescenta saldo projetado e saldo após proteções) e `FreeNow` (acrescenta `realizedBalanceCents`, `nextIncome` informativa, `lowestPointCents`, `lowestPointDate`, `commitmentsUntilLowestPointCents`, `incomesUntilLowestPointCents` e `freeNowCents`). Todos em centavos inteiros seguros. `freeNowComposition`, `freeNowHorizon` e `protectionHint` geram as linhas e textos compartilhados pelas duas plataformas.

## Apresentação

- **Saldo projetado** continua sendo o card principal. Sem proteções, a dica original (“Se tudo ocorrer como planejado”) fica igual. Com proteções, a dica mostra “R$ … após margem de segurança”, “… após reforços dos objetivos” ou “… após proteções”.
- **Desktop**: uma faixa fina abaixo dos quatro cards (não é um quinto card) com o valor e a data mais apertada (“O saldo do mês fica mais apertado em 26/10.”). “Ver composição” expande: em mãos, contas e entradas até o ponto mais baixo, margem e objetivos (omitidos quando zero) e o resultado.
- **Android**: o mesmo bloco, com “Ver composição”, dentro do card de saldo existente e na Visão geral.
- Valor negativo aparece com a cor de atenção de cada plataforma.

## Fora do escopo

Integração bancária, saldo inicial, transferência ou reserva automática, previsão por IA, orçamento por categoria e alteração automática de `savedAmount`.

## Cobertura

`packages/core/src/free-now.test.ts` cobre cada regra acima (sem proteções, só margem, só reforços, ambos, entrada amanhã, várias contas, contas depois da entrada cobertas ou não por ela, mesma data, receita recebida/atrasada, despesa paga, cancelados, sem entrada futura, negativo, objetivos pausados/concluídos, troca de mês e virada, cartão/parcela/recorrência e um caso real de outubro). `apps/desktop/src/main/freeNow.test.ts` roda a mesma massa nos bancos SQLite do Desktop e do Android e exige resultados idênticos. Os testes de apresentação verificam o Dashboard Desktop renderizado e o modelo de exibição Mobile.
