# Evidência do recorte de preparação de recuperação

Execução local em 2026-10-01, branch `codex/restore-epoch-continuity`, base `546a0754bd52a1fc28c6fdcc94f5b69d9af9c095`. Somente bancos/contas/SQLite sintéticos e ambientes descartáveis. A evidência histórica de `self-hosted-validation.md` permanece inalterada.

| Verificação | Resultado local |
| --- | --- |
| `npm test` | 360 testes passaram; 31 testes de integração condicionais não executados nessa chamada |
| `npm run typecheck` | Passou |
| `npm run lint` | Passou; 0 erros, 42 warnings |
| `git diff --check` | Passou |
| `npm run release:validate` | Passou, versão 0.3.10 / Android versionCode 3 |
| `npm run sync:dev:test` | PostgreSQL/Keycloak: 59 passaram, 1 condicional de cliente anterior não executado |
| `node tools/release/version-skew.cjs` | 3 passaram; cliente de `8de0087cdbcdcc670ec2073ba3f4ea51932072b4` compilado sem alterar seu engine/controller; interoperabilidade e bloqueio após restore |
| `npm run sync:self-hosted:unit` | 17 passaram, incluindo rollback operacional e journal após perda do processo/banco |
| `npm run sync:self-hosted:validate` | Compose Caddy/proxy próprio/CA validados com secrets externos sintéticos |
| `npm run sync:self-hosted:test` | Clean-install, OIDC/PKCE, adapters SQLite desktop/mobile, restart, falhas de serviços/TLS, privacidade e backup/verify/restore passaram |
| Operação E1→E2→E3 | Dois restores oficiais `lpctl`, novo epoch em ambos e ledger anterior preservado; verify-backup não modifica instalação ativa |
| Linux normal/beta | `npm run package` nos dois canais passou |
| Android debug/normal/beta | Gradle `assembleDebug`, `assembleRelease -PdevelopmentSigning=true` e `assembleRelease -PprivateBeta=true`, x86_64, JDK 21: passaram |

Os seis testes novos de controle usam adapters reais e demonstram C1 no snapshot, C2 local aceito após o backup e C3 offline conservados sem mutações durante `epoch_changed`/preparação. Comprovam owner OIDC, authority existente e recovery code em contexto limpo, rejeição de campos/assinaturas/conta incorretos, ausência de ledger, expiração por tempo do servidor, replay para outro restore, downgrade, rejeição de salto A→C e retenção da revogação conhecida pós-backup.

Falhas injetadas: abandono após challenge/assinatura, exceção PostgreSQL entre consumo do challenge e gravação da autorização, resposta perdida com restart/retry após expiração, journal de restore após perda do processo/banco. Há uma única autorização durável; SQLite/outbox/binding permanecem intactos. Canários financeiros e código de recuperação não aparecem nas tabelas do PostgreSQL; implantação self-hosted também verifica ambos os bancos e logs.

**Não comprovado nem implementado:** geração financeira B ativa, baseline/staging/ativação, nova chave/registry/recovery B, secrets/binding B transacionais, rebase de outbox, ingresso do segundo aparelho, convergência pós-restore e tombstones/conflitos entre epochs. E1→E2→E3 nesta evidência é operacional, não migração financeira.

Windows normal/beta, smoke do Electron instalado/empacotado e instalação/upgrade Android em emulador pertencem aos workflows de readiness do PR. Os builds Android locais usam assinatura de desenvolvimento/teste, não credenciais de produção. Os resultados de CI devem ser consultados no próprio PR; esta evidência local não afirma que jobs remotos passaram.

O [modelo e os bloqueios](self-hosted-epoch-recovery.md) descrevem o restante necessário. Nenhuma decisão do Vault/Visão e Decisões foi alterada. Este recorte não satisfaz o critério de recuperação completa e deve continuar explicitamente identificado como preparação.
