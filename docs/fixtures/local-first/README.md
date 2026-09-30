# Fixtures SQLite da Etapa 0

Estas são representações SQL legíveis de bancos SQLite com **dados fictícios**, sem dados de usuário. Testes as carregam em SQLite real temporário; elas não são executadas em bases ativas.

- `mobile-v1.sql` a `mobile-v4.sql`: DDL histórico real de `apps/mobile/src/db/migrations.ts` na base `276b304`, mais registros sintéticos compatíveis. Dados incluem realizado zero, ausência NULL, Unicode/newline, referências a cadastro próprio, tombstone, ocorrência com vencimento editado e data original preservada, parcela realizada, objetivo excluído, posições não contíguas e ledger de importação, conforme a versão permite.
- `desktop-v10.sql`: **reconstrução** do schema anterior à migration 11: schema desktop de `276b304`, sem coluna `pinned_from_month` e sem marcador 11, seguindo o ALTER aditivo conhecido. Demais marcadores/timestamps são determinísticos. Não é captura de uma instalação v10 real; não cobre todas as migrations 1–9.

Gerador explícito: `npx tsx tools/sync-stage0/create-database-fixtures.ts`, da raiz. Nunca regenerar fixtures automaticamente para fazer um teste passar. Revisar diff de DDL/dados e atualizar procedência ao mudar a base histórica.

`tools/sync-stage0/database-manifest.cjs` registra schema/índices, versões, contagens, valores e digest SHA-256 por tabela. Os testes comparam **todas as colunas antigas**, inclusive linhas excluídas, antes/depois; novos campos não podem justificar alterações nos anteriores. Recovery WAL, falha tardia, integridade/FKs, reabertura e restore JSON/SQLite são verificados nas suítes das duas plataformas. O rebuild de cadastros está separado em um ensaio descartável; não é uma migration de produção.

Próximas evidências antes de release: fixtures de outras gerações desktop, dados maiores/adversariais e execução nos drivers SQLite reais do Android/Electron. Qualquer captura de banco de pessoa deve ser anonimizada com autorização e sem exportar segredos; esta entrega não precisou capturar uma base pessoal.
