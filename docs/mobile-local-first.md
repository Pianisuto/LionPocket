# Experiência local-first no LionPocket Mobile

> Estado atualizado: [paridade funcional local](mobile-functional-parity.md). O novo bloco completa os fluxos restantes, adiciona preferências e migração v5 com suporte a valores zero.


A organização visual atual está descrita em [mobile-visual.md](mobile-visual.md): filtros pelo ícone junto de Lançamentos, painel anual em **Ano**, planejamento em **Planejar** e cadastros/dados locais em **Mais**.

Complementa [uso diário](mobile-daily-finance.md) e [planejamento](mobile-planning.md). Android, React Native bare e SQLite continuam funcionando sem internet, conta, servidor ou sincronização. O desktop não foi modificado nesta entrega.

## Lançamentos e painel

- **Prioridades mensais:** fixar, retirar, subir e descer com botões próprios para toque. As prioridades ficam no topo, independentemente da ordenação dos demais registros. Operações usam o mês completo, preservando itens ocultos pelos filtros.
- **Recorrências prioritárias:** todas as ocorrências da série são movidas juntas. A prioridade é herdada a partir do mês escolhido, sem retroagir aos meses anteriores. Retirar a prioridade desfaz a fixação da série, como no desktop. Recorrências ausentes em um mês mantêm sua posição global.
- **Ordenação:** vencimento, descrição, valor, categoria, pagamento, cartão, compra e situação, em ambos os sentidos. A preferência de visualização fica na sessão; as posições prioritárias são persistidas em SQLite.
- **Sugestões:** ao digitar pelo menos dois caracteres em um lançamento novo, o histórico do mesmo tipo sugere descrição, categoria, pagamento, cartão e valor. Ordena por frequência e data mais recente. Excluídos e cancelados não participam; realizado zero é preservado. Aplicar uma sugestão mantém as datas e a situação do formulário; um cartão sugere seu vencimento pelo ciclo existente.
- **Filtros avançados:** busca em descrição, categoria, pagamento, cartão, observações e valor; busca textual sem acentos e busca monetária por dígitos. Tipo, situação/atraso, cartão/outras formas e origem podem ser combinados. Os totais permanecem referentes ao mês completo.
- **Painel anual:** doze resumos mensais, totais realizados do ano, categorias e atalho para abrir cada mês. Usa a mesma competência do desktop: receitas por vencimento, despesas pagas no mês do pagamento, pendências carregadas adiante e cancelados excluídos. Projeções recorrentes são geradas localmente, como na consulta mensal.

As regras puras ficam em `packages/core`: filtros, busca, sugestões, prioridade herdada, ordenação, categorias e formatos de arquivos. Calendários, cartões, competência, centavos e validações reutilizam o domínio já existente. Consultas, transações, migrations e recursos Android permanecem no mobile.

## Arquivos locais

A tela **Dados locais** usa o Storage Access Framework do Android, sem pedir permissão ampla de armazenamento. A pessoa escolhe o arquivo ou destino. Seleções canceladas não gravam dados. Arquivos importados são copiados para uma área temporária privada e removidos ao terminar a preparação. O limite de entrada é 20 MB.

| Arquivo | Exportação | Entrada no mobile |
| --- | --- | --- |
| CSV | Mês por vencimento ou todos os lançamentos, com as mesmas onze colunas, UTF-8 BOM, vírgula e aspas do desktop | Importação aditiva de lançamentos; aceita também ponto e vírgula e decimal com vírgula |
| JSON Mobile | Envelope `version: 1`, `platform: mobile`, `schemaVersion`, `exportedAt` e registros das dez tabelas | Restauração completa, com revisão e confirmação de substituição |
| JSON desktop | Usa o arquivo completo já exportado pelo desktop | Importação aditiva, traduzindo nomes de colunas de centavos e referências de cadastros sem sobrescrever IDs existentes |
| SQLite Mobile | `VACUUM INTO` gera arquivo independente, consistente, incluindo registros, prioridades, séries e exclusões | Restauração completa de backup válido v1, v2, v3 ou v4 |
| XLSX | — | Modelo financeiro do desktop: Config, Fixas, Objetivos e abas Jan–Dez, com categorias, pagamentos, cartões, recorrências, objetivos e lançamentos |

CSV não contém séries, prioridades, exclusões nem a data de realização. Ao importar pagos/recebidos, sua coluna `data` é usada como data de realização. Para recuperar o banco fielmente, use JSON Mobile ou SQLite. CSV/XLSX criam origem `imported`; JSON conserva a origem e os IDs dos registros. Um backup SQLite do desktop não é um banco mobile: use seu JSON para importar.

Importações CSV/XLSX são ensaiadas em um banco temporário com os dados atuais antes de apresentar a quantidade de novos registros e repetidos. Gravação, cadastros e marcadores de importação usam uma única transação. Reimportar a mesma linha CSV do mesmo arquivo ou a mesma aba/linha XLSX não sobrescreve o lançamento existente, mesmo se ele tiver sido excluído. Recorrências e objetivos já cadastrados são ignorados. Um JSON com IDs divergentes interrompe a importação; os registros existentes permanecem. Cadastros equivalentes são reutilizados, preservando a configuração móvel.

O [bloco de paridade funcional](mobile-functional-parity.md) passa a aceitar **planejado zero** em lançamentos/recorrências e alvo zero em objetivos. Parcelas permanecem positivas, conforme o desktop. Realizado zero continua válido.

## Proteção e versões do banco

A migration 4 é exclusivamente aditiva: cria `recurring_transaction_priorities`, `transaction_priority_order` e `local_import_records`. As migrations 1–3 e as tabelas financeiras existentes não são recriadas nem alteradas.

Antes de uma restauração ou importação, uma cópia SQLite consistente dos dados atuais é salva em `files/backups`. Se salvar a cópia falhar, a operação é interrompida. As cópias aparecem na própria tela e podem ser revisadas/restauradas ou salvas fora do aplicativo. Uma cópia manual também pode ser criada no aparelho. Desinstalar ou limpar o armazenamento remove as cópias privadas; arquivos exportados no destino escolhido continuam sob controle da pessoa.

Para restaurar, o aplicativo:

1. abre apenas a cópia temporária e verifica versão, tabelas/colunas esperadas, integridade e referências; rejeita triggers, estruturas incompatíveis e versões futuras;
2. aplica as migrations pendentes nessa cópia, sem modificar o arquivo escolhido ou o banco atual;
3. apresenta nome, contagens e versões de origem/atual, além da confirmação clara de que lançamentos, cadastros, séries, objetivos e prioridades serão substituídos;
4. cria a recuperação dos dados atuais e substitui os registros em uma única transação SQLite, com rollback em caso de falha.

O handle e o schema do banco principal permanecem atuais. Portanto, restaurar v1/v2/v3 não deixa o app usando colunas antigas, conexões fechadas ou uma versão antiga de `user_version`. Reabrir executa a inicialização normal sobre a versão 4. Não há troca insegura de um arquivo aberto nem cópia direta do banco em uso; backups usam `VACUUM INTO`. Os callbacks transacionais usam somente `tx`, inclusive durante importação e restauração.

## Verificações

Em 29/09/2026:

- `npm test`: **166 testes** — 55 core, 53 desktop e 58 mobile.
- `npm run typecheck` e `npm run lint`: aprovados.
- `npm run mobile:build:android` e `npm run mobile:build:android:release`: aprovados nas quatro arquiteturas configuradas. Release inclui JavaScript/Hermes e mantém a assinatura de desenvolvimento já configurada no projeto.
- Testes com SQLite real cobrem preservação de todas as tabelas, tombstones, zero realizado, reabertura em disco, restauração v1/v2/v3, migrations de JSON antigo, versão futura, schema incompatível, referências inválidas, falha da cópia de recuperação, rollback tardio de restauração/prioridade/importação, repetição de CSV/XLSX e JSON completo do desktop.
- Comparação direta de filtros, prioridades recorrentes e doze totais anuais com o banco desktop; os 53 testes anteriores do desktop permanecem aprovados.
- Decodificação de XLSX binário com strings compartilhadas, inline, fórmulas em cache e arquivo inválido; CSV com BOM, aspas, linhas múltiplas, decimal com vírgula, zero realizado e estrutura inválida.

### Roteiro do emulador

Use **LionPocket_API_36**, release e modo avião. Instale por atualização (`adb install -r`); não limpe o armazenamento.

1. Abra um banco v3 e compare as colunas de todos os registros anteriores após a migration 4. Confira o saldo mensal anterior e a integridade SQLite.
2. Combine busca sem acentos, pagamento e origem; confira consulta vazia e limpeza dos filtros. Confirme que os totais mensais não mudam ao filtrar.
3. Priorize uma recorrência e um manual, esconda um deles com filtros e mude a ordem. Confira as posições persistidas e a herança futura. Ordene os demais por valor.
4. No lançamento novo, escolha o tipo correto, digite uma descrição histórica e aplique a sugestão; confira os campos e feche sem salvar um duplicado.
5. Abra o painel anual, confira os totais e categorias e use o atalho de um mês.
6. Exporte JSON e SQLite pelo seletor nativo, crie uma cópia no aparelho e compare registros dos arquivos exportados.
7. Adicione um lançamento após o backup. Revise o arquivo exportado, cancele a confirmação e confira que o registro permanece. Confirme a restauração; compare todas as tabelas com o arquivo exportado e confira que a cópia de recuperação conserva o registro posterior.
8. Revise/restaure um backup v3 e confirme que a cópia é migrada antes da troca. Restaure novamente o backup atual. Importe CSV e XLSX; repita a importação e confirme que não duplica nem substitui registros anteriores.
9. Force o fechamento e reabra offline. Compare novamente as dez tabelas, a versão 4, `integrity_check` e `foreign_key_check`.

### Resultado observado no emulador

O release foi validado em modo avião sobre o banco v3 da validação anterior do planejamento. Seus 15 registros de lançamentos, 9 categorias, 7 pagamentos, 1 cartão, 2 recorrências, 1 compra parcelada e 1 objetivo foram preservados. Busca por “Compra cartao”, filtros de pagamento/origem, consulta vazia, limpeza, fixação de recorrência, prioridade manual, mudança de ordem com prioridade oculta, ordenação por valor e aplicação da sugestão de salário passaram pela interface. O painel anual mostrou entradas realizadas de R$ 5.510,00, saídas de R$ 639,90 e saldo de R$ 4.870,10.

JSON e SQLite exportados pelo seletor nativo continham exatamente os mesmos registros nas dez tabelas, incluindo as duas posições mensais e a prioridade da recorrência. Depois de adicionar “Depois do backup QA” (R$ 17,25), a confirmação de restauração foi cancelada e depois confirmada. O banco restaurado voltou exatamente às dez tabelas exportadas; a cópia de recuperação manteve os 16 lançamentos, incluindo o registro posterior.

XLSX importou o registro de R$ 42,25 e um cadastro, preservando todos os registros anteriores. Repetir a importação mostrou zero novos lançamentos e um item ignorado, com apenas um registro e um marcador de origem no SQLite. CSV exportou/importou os 14 lançamentos ativos com as onze colunas do desktop. Os dados de teste importados foram retirados ao restaurar o backup SQLite exportado, e suas versões anteriores à troca ficaram nas cópias automáticas.

A restauração do arquivo v3 pela interface mostrou a migração para v4; as sete tabelas anteriores ficaram exatamente iguais ao arquivo de origem, e esse arquivo permaneceu v3 e idêntico byte a byte. A revisão de uma cópia privada no aparelho também passou, com descarte da seleção.

Após restaurar novamente o backup atual, forçar o fechamento e reabrir ainda offline, as **dez tabelas permaneceram exatamente iguais ao JSON/SQLite exportados**. O saldo realizado mensal permaneceu R$ 3.370,10; `user_version` foi 4, `integrity_check` retornou `ok` e `foreign_key_check` ficou vazio. A área temporária de arquivos ficou vazia ao final.
