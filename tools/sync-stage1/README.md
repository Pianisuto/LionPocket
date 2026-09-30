# Ensaios da fundação local

Usam exclusivamente bases sintéticas vazias e fixtures públicas, com código real dos adapters/repositórios dos apps. Não abrir o app financeiro instalado. [Decisões, comandos e limites](../../docs/local-first-sync-stage1-local-foundation.md).

- `manual-checks.cjs`: mesmo cenário no desktop e Android; snapshots completos e 12 triggers SQL de fault injection após escritas.
- `build-electron.cjs` / `electron.ts`: bundle de teste separado, userData e banco em `/tmp`, main real, cofre real e troca de sealed boxes. O bundle fica em `.vite/stage1`, não no produto.
- `prepare-android.cjs` / `android-index.js`: reutilizam o preparador isolado da Etapa 0, copiam fontes reais e executam crypto/SQLite/cofre em Hermes; debug/release com JS embutido.
- `SecretStoreProbeModule.kt`: somente harness descartável; adultera/copia wrapper e apaga sua chave efêmera para verificar falhas do adapter real. Não é registrado no APK financeiro.

Bindings seguem o lockfile; não há patches de vendor ou regeneração automática de goldens. Os reports comprometidos contêm somente fixtures públicas, checks e IDs de bancos sintéticos.
