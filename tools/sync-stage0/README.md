# Ferramentas de preparação offline

Estes scripts operam somente em fixtures/bases temporárias e chaves públicas de teste. Nenhum deles é migration de produção, sync engine ou utilitário para bases pessoais.

- `create-database-fixtures.ts`: regeneração explícita de SQL histórico/sintético; [procedência](../../docs/fixtures/local-first/README.md).
- `database-manifest.cjs`: captura schema, versões, contagens, valores e SHA-256, com projeção das colunas antigas para os testes.
- `catalog-rebuild.cjs`: ensaio descartável de rebuild do grafo financeiro com FKs ligadas e índices de nomes ativos; fault injection após cópia. Não executá-lo no app.
- `create-protocol-vectors.ts`: entrada/string/UTF-8/hash canônicos de teste.
- `crypto-native.py` e `crypto-desktop.cjs`: validação independente de vetores sodium C/JS, [comandos e limites](../../docs/local-first-sync-crypto-spike.md).

Os `.d.cts` fornecem tipos aos testes dos apps sem mudar o `rootDir` mobile. Scripts crypto ficam fora dos comandos de produto e não adicionam sodium ao lockfile do monorepo.
