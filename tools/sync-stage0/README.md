# Ferramentas de preparação offline

Estes scripts operam somente em fixtures/bases temporárias e chaves públicas de teste. Nenhum deles é migration de produção, sync engine ou utilitário para bases pessoais.

- `create-database-fixtures.ts`: regeneração explícita de SQL histórico/sintético; [procedência](../../docs/fixtures/local-first/README.md).
- `database-manifest.cjs`: captura schema, versões, contagens, valores e SHA-256, com projeção das colunas antigas para os testes.
- `catalog-rebuild.cjs`: ensaio descartável de rebuild do grafo financeiro com FKs ligadas e índices de nomes ativos; fault injection após cópia. Não executá-lo no app.
- `create-protocol-vectors.ts`: entrada/string/UTF-8/hash canônicos de teste.
- `crypto-native.py` e `crypto-desktop.cjs`: validação independente de vetores sodium C/JS, [comandos e limites](../../docs/local-first-sync-crypto-spike.md).

Os `.d.cts` fornecem tipos aos testes dos apps sem mudar o `rootDir` mobile. Scripts crypto ficam fora dos comandos de produto e não adicionam sodium ao lockfile do monorepo.


Complemento nativo:

- `crypto-checks.cjs`: mesmos 103 checks puros (104 com peer) no main Electron e JSI; sem filesystem/rede.
- `crypto-electron.cjs`: runner separado do app instalado, userData temporário, relatório e troca bidirecional.
- `create-control-vectors.py`: verifica o golden control com sodium C por padrão; `--generate` é explícito.
- `prepare-native-harness.cjs`: copia o template para projeto identificado sob `/tmp`, troca applicationId, embute vetores/fontes reais das migrations e gera manifests das fixtures confiáveis. Não modifica manifests dos apps financeiros. Precisa de `build:contracts` e Node 24.
- `native-harness`: teste offline Hermes/JSI, migrations/backup/rollback de fixtures e wrapping Keystore efêmero; nunca abre `lionpocket.sqlite`.
- `collect-native-report.py`: coleta somente log do pacote de spike/PID atual, incluindo release; falha se não houver PASS em 30 segundos.

[Receita completa, JDK, versões e limites](../../docs/local-first-sync-crypto-spike.md); [decisões e entrada na Etapa 1](../../docs/local-first-sync-stage1-readiness.md). Os reports comprometidos contêm apenas fixtures públicas e não precisam coincidir byte a byte com um novo ensaio de sealed boxes aleatórias.
