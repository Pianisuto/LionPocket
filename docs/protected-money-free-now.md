# Dinheiro protegido e Livre agora

Os dois valores são **derivados**: não existe tabela, coluna, migration, entidade de sync nem item de backup novo. As únicas fontes persistidas continuam sendo a [margem de segurança](monthly-planning.md), os [reforços mensais dos objetivos](goal-monthly-reinforcement.md) e os lançamentos. Nada disso é despesa, movimentação ou alteração de `savedAmount`, e nenhum valor derivado é sincronizado.

Toda a regra está no core (`packages/core/src/free-now.ts`). Desktop (`getOverview`) e Android (`monthlyOverview`) chamam a mesma função com os mesmos dados; os componentes só formatam.

## Dinheiro protegido

`dinheiro protegido = margem de segurança do mês + reforços ativos dos objetivos do mês`, em centavos (`protectedMoney`).

O reforço só conta com o objetivo `planned` ou `saving` (regra do PR #22). Pausado, concluído, cancelado ou excluído não conta, mas o valor segue no histórico. Cada mês é independente e nada é copiado para o seguinte.

## Saldo disponível: fonte canônica

O LionPocket **não conhece saldo bancário**, saldo inicial nem sobra de meses anteriores. A única noção de “dinheiro que já se movimentou” é o **Saldo realizado** do mês (`summarizeMonth(...).realizedBalance` = recebido − pago no mês), o mesmo número exibido nos cards. Livre agora usa exatamente esse valor como ponto de partida (`realizedBalanceCents`) e a interface o chama de “Saldo realizado do mês”, nunca de saldo bancário. Se a pessoa tem dinheiro de meses anteriores que não está lançado, ele não entra.

## Livre agora

```
Livre agora = saldo realizado do mês
            − compromissos até a próxima entrada
            − dinheiro protegido
```

O resultado **não é limitado a zero**; negativo significa que, se tudo vencer como previsto, falta dinheiro antes da próxima entrada.

### Cronologia

A referência é o dia de hoje (data local).

1. **Próxima entrada**: a primeira data, de hoje em diante, com receita ainda `planned` no mês. Receita recebida ou cancelada nunca conta como futura. Receita prevista com data **já passada** (atrasada) não serve de âncora e também não entra no saldo: não se conta com dinheiro que não chegou. Várias entradas na mesma data são somadas (`nextIncome.count`, `description` nulo quando há mais de uma). Entradas de valor zero são ignoradas.
2. **Compromissos**: despesas ainda `planned` (inclusive atrasos carregados de meses anteriores) que o próprio sistema já conta no mês (`expenseCountsInMonth`) e cujo vencimento é **anterior ou igual** à data da próxima entrada. Pagas, canceladas e de valor zero não entram, e as que vencem depois da entrada não reduzem o valor imediato.
3. **Sem outra entrada no mês**: valem todas as pendências até o último dia do mês (`commitmentsUntil`).
4. **Protegido**: margem + reforços do mês, subtraídos uma vez.

Cartão, parcelas e recorrências já são lançamentos com vencimento calculado (fatura, parcela, ocorrência); contam uma vez, pela própria data. Pagar uma fatura move seus lançamentos de “compromisso” para “realizado”, sem contagem dupla.

### Regra determinística do mesmo dia

Uma conta que vence **no mesmo dia** da próxima entrada conta como **antes** dela (vencimento ≤ data da entrada). Não há garantia de que o dinheiro chegue antes do pagamento, então a regra é a conservadora. Se a entrada prevista é hoje e ainda não foi recebida, ela continua sendo a próxima entrada e as contas de hoje contam.

### Mês e virada

Livre agora só existe para o **mês atual** (`calculateFreeNow` devolve `null` para qualquer outro). Meses passados e futuros continuam mostrando o saldo após proteções. O período é o mês planejado: no último dia do mês, uma receita do mês seguinte não é âncora e as contas do mês seguinte não entram. No dia 1º, o mês novo usa sua própria margem e seus próprios reforços; os do mês anterior não carregam.

## Estruturas do core

`ProtectedMoney` (`safetyMarginCents`, `goalReinforcementCents`, `protectedMoneyCents`), `ProtectionBalance` (acrescenta saldo projetado e saldo após proteções) e `FreeNow` (acrescenta `realizedBalanceCents`, `nextIncome`, `commitmentsUntil`, `commitmentsBeforeNextIncomeCents`, `freeNowCents`). Todos em centavos inteiros seguros. `freeNowComposition`, `freeNowHorizon` e `protectionHint` geram as linhas e textos compartilhados pelas duas plataformas.

## Apresentação

- **Saldo projetado** continua sendo o card principal. Sem proteções, a dica original (“Se tudo ocorrer como planejado”) fica igual. Com proteções, a dica mostra “R$ … após margem de segurança”, “… após reforços dos objetivos” ou “… após proteções”.
- **Desktop**: uma faixa fina abaixo dos quatro cards (não é um quinto card) com o valor e o período (“Até a próxima entrada: Salário, em 15/10.”). “Ver composição” expande: saldo realizado, contas antes da próxima entrada, margem e objetivos (omitidos quando zero) e o resultado.
- **Android**: o mesmo bloco, com “Ver composição”, dentro do card de saldo existente e na Visão geral.
- Valor negativo aparece com a cor de atenção de cada plataforma.

## Fora do escopo

Integração bancária, saldo inicial, transferência ou reserva automática, previsão por IA, orçamento por categoria e alteração automática de `savedAmount`.

## Cobertura

`packages/core/src/free-now.test.ts` cobre cada regra acima (sem proteções, só margem, só reforços, ambos, entrada amanhã, várias contas, contas depois da entrada, mesma data, receita recebida/atrasada, despesa paga, cancelados, sem entrada futura, negativo, objetivos pausados/concluídos, troca de mês e virada, cartão/parcela/recorrência). `apps/desktop/src/main/freeNow.test.ts` roda a mesma massa nos bancos SQLite do Desktop e do Android e exige resultados idênticos. Os testes de apresentação verificam o Dashboard Desktop renderizado e o modelo de exibição Mobile.
