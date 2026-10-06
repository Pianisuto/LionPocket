# Validation and GitHub Actions

- GitHub Actions is disabled by the owner to avoid spending the account's quota. Do not enable it, dispatch workflows or rerun jobs unless the user explicitly changes this decision.
- Commit/push hooks and `npm run validate:local` run ONLY quick checks (offline tests, types, lint, metadata and whitespace), with a 55-second deadline. Install hooks with `npm run hooks:install`; `npm ci` also installs them. Never start Docker, emulators, packaging or the full pipeline from a hook, including after failure/timeout. Do not bypass hooks unless explicitly authorized.
- A quick receipt can be reused for identical source content and Node runtime within 24 hours. Changed source requires quick validation again. Quick approval does not claim native/infrastructure coverage.
- `npm run validate:full` explicitly runs the full Linux/Android pipeline. Run it when relevant to native packaging/protocols, infrastructure or release verification; it is NOT required for every commit/push. Never use a personal Android device or existing emulator for destructive fixture tests.
- Native Windows installation/protocol checks need a disposable Windows host. Do not claim they ran locally on Linux. See `docs/local-validation.md` for prerequisites and coverage.
