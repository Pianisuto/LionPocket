# Validation and GitHub Actions

- GitHub Actions is disabled by the owner to avoid spending the account's quota. Do not enable it, dispatch workflows or rerun jobs unless the user explicitly changes this decision.
- Run `npm run validate:local` before commit/push. Install the repository hooks with `npm run hooks:install`; `npm ci` also installs them. Do not bypass the hooks unless the user explicitly authorizes it.
- A successful local receipt can be reused only for identical source content and runtime, within 24 hours. The hooks check this before commit and push; changed source requires validation again.
- The full Linux pipeline includes shared tests/types/lint, PostgreSQL/Keycloak integration, self-hosted, actual installed Linux packages in disposable containers, and Android builds/update/deep-link/native-storage checks in a newly created disposable emulator. Never use a personal Android device or existing emulator for these destructive fixture tests.
- Native Windows installation/protocol checks need a disposable Windows host. Do not claim they ran locally on Linux. See `docs/local-validation.md` for prerequisites and coverage.
