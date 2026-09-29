# Uso financeiro diário no Android

A interface está em `apps/mobile/App.tsx` e `apps/mobile/src/ui`. A persistência usa exclusivamente o `lionpocket.sqlite` privado do Android. `MobileRepository` contém consultas, validações de referências e mutações; a conexão nativa está isolada para permitir testes com SQLite real no Node. Não há conta, servidor, sincronização ou acesso ao banco do Electron.

## Comandos

Na raiz, com Node 22.13+ (ou 24), JDK 17 e `ANDROID_HOME` configurado:

```bash
npm ci
npm run mobile:start           # mantenha o Metro aberto
npm run mobile:android         # em outro terminal, com emulador/aparelho conectado
npm run mobile:build:android   # gera app-debug.apk
npm run mobile:build:android:release # inclui JavaScript, funciona sem Metro

npm test                      # core, desktop e mobile
npm run typecheck
npm run lint

# Somente mobile, após compilar o core
npm run build:core
npm run test --workspace @lionpocket/mobile
npm run typecheck --workspace @lionpocket/mobile
npm run lint --workspace @lionpocket/mobile
```

APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`. O APK release fica em `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`, inclui JavaScript e funciona sem Metro. A configuração atual assina release com a chave de desenvolvimento; use uma chave própria para distribuição. O APK debug depende do Metro; para instalar manualmente:

```bash
adb devices
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
adb shell am start -n com.lionpocketmobile/.MainActivity
```

Use `-r` para atualizar preservando dados. Não limpe o armazenamento nem desinstale o app para testar a atualização do banco.

## Regras e comparação com o desktop

- Valores são persistidos em centavos. O resumo soma em centavos, evitando resíduos de ponto flutuante, e não muda conforme os filtros da lista.
- Cancelados e excluídos não afetam o resumo. Planejado e realizado são independentes; pagamento rápido usa o realizado informado ou, na ausência dele, o planejado.
- Como no desktop, receitas pertencem ao mês previsto, mesmo se recebidas depois. Despesas pagas pertencem ao mês da realização; continuam visíveis no mês do vencimento para histórico. Despesas pendentes vencidas são carregadas adiante; não entram na projeção do mês original quando ele já encerrou. Somente despesas são consideradas atrasadas.
- Pagamento/recebimento rápido registra a data local de hoje, como a ação individual do desktop. O formulário permite ajustar a data. Ao concluir um lançamento novo de mês antigo, sugere a data prevista; ao quitar uma despesa já atrasada, sugere hoje.
- O fechamento e o vencimento do cartão usam as regras existentes do core. Uma compra no dia do fechamento pertence à próxima fatura. Cartões sem fechamento usam o próximo vencimento a partir da compra. A data sugerida pode ser ajustada manualmente.
- O mobile mantém a restrição da base anterior de valor planejado maior que zero; o formulário desktop permite zero. O valor realizado pode ser zero nas duas plataformas.
- O formulário mobile abre novos lançamentos como **Planejado**, inclusive em meses antigos; o desktop sugere conclusão automática para datas passadas. A situação no mobile é uma escolha explícita.
- Mobile usa formulários em tela cheia, seletores com áreas de toque e lista de cartões de lançamentos, em vez da tabela desktop. Datas são digitadas em ISO; não há calendário nativo nesta entrega.
- Os cadastros iniciais mobile são um subconjunto das categorias desktop; cartões são adicionados pelo usuário. É possível adicionar, editar e excluir categorias, pagamentos e cartões. Veja o bloco de [planejamento](mobile-planning.md) para os vínculos com séries e objetivos.
- O bloco de [planejamento](mobile-planning.md) acrescenta recorrências, parcelas, objetivos, conclusão em lote e pagamento de fatura em lote. Prioridades, sugestões, busca textual, filtro de origem/pagamento, resumo anual, importação/exportação e backups da interface desktop permanecem fora desta entrega Android.

## Migração e validações

A migration 1 é mantida. A migration 2 cria categorias, pagamentos e cartões, adiciona vínculos anuláveis e data de compra aos lançamentos, além de campos de atualização/exclusão. Tudo ocorre em uma transação e `PRAGMA user_version` só avança no sucesso. Bancos de versão futura são recusados sem alteração. Categorias padrão são criadas apenas na migration, sem repopular listas a cada abertura.

São validados descrição, valor planejado positivo, realizado não negativo e valores representáveis em centavos, datas reais, situação compatível com entrada/saída, data de realização, existência de pagamento/cartão e categoria do mesmo tipo. Cartões só se vinculam a saídas. Chaves estrangeiras ficam habilitadas. As ações de gravação bloqueiam toques repetidos enquanto estão em andamento; erros são apresentados na tela com possibilidade de correção ou nova tentativa.

## Roteiro no emulador

1. Atualize com `adb install -r`, abra o app e confira registros existentes.
2. Em **Cadastros**, adicione um cartão que fecha dia 20 e vence dia 5. Teste nome vazio, dias inválidos e nome duplicado. Adicione também categoria e pagamento personalizados.
3. Crie uma saída de R$ 125,50, categoria Alimentação, pagamento Pix e situação Planejado. Confira lista e saldo projetado.
4. Edite descrição, valor planejado para R$ 130,00 e realizado para R$ 120,25. Confira relações preservadas. Toque **Pagar** e confira data de hoje e saldo realizado.
5. Filtre por tipo e situação; os totais do painel devem continuar representando o mês completo. Uma entrada antiga planejada não deve aparecer como despesa atrasada.
6. Exclua a saída: primeiro cancele a confirmação, depois confirme. Confira remoção da lista e dos totais.
7. Crie uma entrada de R$ 2.500,00 e toque **Receber**. Confira saldo realizado. Edite para retornar a Planejado ou Cancelado.
8. Crie uma compra no cartão em 19/09/2026: vencimento sugerido em 05/10/2026. Navegue para outubro e confira o lançamento. Edite compra para 20/09: vencimento sugerido em 05/11. Confira transferência entre meses.
9. Navegue entre meses e na virada do ano. **Hoje** deve funcionar inclusive quando o mês atual já está selecionado. Confira estados vazios.
10. Force o fechamento e reabra. Confira persistência de valores, vínculos, situações e exclusões. Teste uma despesa de mês passado para conferir transporte de atraso e pagamento no mês atual.

Os testes automatizados cobrem o domínio e o repositório em SQLite real, incluindo preservação da versão 1, rollback, exclusão lógica, mudança de mês, atraso, recebimento e valores realizados diferentes dos planejados. A validação de interface deve ser repetida quando houver mudanças nos componentes nativos.

## Validação executada em 29/09/2026

Ambiente: Node 24.21, emulador `LionPocket_API_36`, Android 16/API 36. Testes do monorepo: 102 aprovados (35 core, 53 desktop, 14 mobile). Typecheck e lint passaram. Builds debug e release passaram; o release foi instalado com atualização dos dados e validado em modo avião, sem redirecionamento ao Metro.

Foi instalado um banco de teste da versão 1 no emulador antes da atualização. Após a migration 2, o lançamento legado manteve identidade, descrição, valor, data e observações. Foram conferidos criação e edição de saída com categoria/Pix, planejado de R$ 130,00 separado do realizado de R$ 120,25, pagamento, filtros, cancelamento da confirmação de exclusão, exclusão confirmada, criação/recebimento de R$ 2.500,00 e reabertura do app. A compra no cartão em 19/09 sugeriu 05/10; editada para 20/09, passou para 05/11 e mudou de mês na lista. A navegação dezembro/janeiro e o botão Hoje no próprio mês atual também passaram. Foram validados cadastros personalizados, associação aos lançamentos, mensagens de valor zero/data impossível, transporte de uma despesa de agosto para setembro, pagamento, cancelamento no mês original e reabertura para novo pagamento. Após fechar e abrir novamente o APK offline, o saldo realizado permaneceu em R$ 2.450,00 (R$ 2.500,00 recebidos menos R$ 50,00 pagos).

As verificações não alteraram arquivos da aplicação desktop. O ajuste Android adicional foi indicar ao Gradle o compilador Hermes instalado na raiz do monorepo, necessário para empacotar JavaScript no release.
