# Evidência: preparação operacional B crash-safe

Base exata: `cbd7067644c63e6c09802b208731b43d239c0031`. Fixtures sintéticas; nenhum dado/cofre de usuário, Vault ou geração ativa foi migrado.

## Durabilidade e cancelamento

Follow-up sobre `f8bc3bb97407fe040314334b3af7dc7dba219fa3`, na mesma branch/PR #12. O único artifact aleatório irreproduzível agora é o preparation bundle formatVersion 1, privado e imutável no SecretStore. Releitura/validação precedem a reserva SQLite `preparation_format=2`. Não exige transação multi-secret; materializações parciais convergem nos bytes originais. Bundle ausente/inválido, mismatch privado/público ou secrets presentes diferentes falham duramente. Rows do draft anterior migram como formato 1/legacy blocked.

Cancelamento antes de publicação significa pausa da mesma tentativa, com fase de retomada preservada e `resumeOperationalB` explícito. Mantém archive, plano, bundle, identidade e recovery. Depois de remote_started recusa cancelamento. Não há ativação nem cleanup do bundle: este só poderá ser removido após futura ativação/instalação local completamente finalizada e crash-safe.

## Casos comprovados

| Área | Evidência executável |
| --- | --- |
| Base 1/4/20, rotações N+1/N+2, pairing após rotação, recovery só deste epoch | `apps/desktop/src/main/sync/epochKeyBase.test.ts` |
| Parsing recovery legacy/v2 estrito, recoveryVersion acima de MAX_SAFE_INTEGER | mesma suíte e vetor `fixtures/epoch-staging.json` |
| Genesis separado e digest chains determinísticos, Ed25519 independente | `packages/sync-protocol/src/epoch-staging.test.ts` |
| Identidade B nova, installation preservada, mesma authority, DEK nova/scopes distintos | `epochPreparation.test.ts` (desktop e adapter SQLite Android) |
| Master confirmado A reutilizado, mesmo LP1, ciphertext novo; master novo/redigitação; instalação limpa | mesma suíte |
| Bundle antes da reserva; restart real SQLite/adapters conserva deviceId, keys, DEK/master/code, pin/registry/key-base | `epochPreparation.test.ts`: before bundle, ambiguous store não durável/durável, after store/read, identity, signing/box/data/authority/master, secrets prepared, recovery before/save/confirmation |
| Parsing privado estrito, canários em erros, digest/reserva/present-secret mismatch, legacy blocked e metadata imutável | mesma suíte |
| LP1/artifact estáveis após restart; pausa explícita em identity/pending/confirmed; plano reutilizável | mesma suíte |
| Desktop safeStorage real empacotado, scope privado variável/releitura/immutability/plaintext canary ou basic_text refusal | `releaseSmoke.ts` nos jobs Linux/Windows |
| Android JS adapter variável/domínio/erros, AndroidKeyStore real/AtomicFile, novas instâncias, tamper/key loss, operação v1 preservada | `secretStore.test.ts`, `SyncSecretStorageTest.kt` (4 testes no emulador readiness) |
| TestSecrets reserva imutável e scope exato | `apps/sync-server/src/testSupport.test.ts` |
| Envelopes persistidos uma vez, restart SQLite/adapters após begin/envelope/batch/manifest/validate/transition/remote prepared | mesma suíte |
| 107 operações em batches 100+7, decrypt → importer/projeção normal | mesma suíte |
| C1+C2, Z→X/Y/common base/conflito, delete/edit/tombstone, sem automerge/ressurreição | mesma suíte usa oracle normal `verifyBaselineReplay` após decrypt |
| Owner OIDC real, B signing proof, concorrência begin, perda após commit PG, rollback no meio do batch, payload oversized, mismatch, parents/key/registry/signature inválidos | `apps/sync-server/src/epochRecovery.integration.test.ts` |
| Manifest fields adulterados, immutable staging/transitions, A remote/local igual, B não ativa, sem plaintext/code em staging | mesma integração |
| pg_dump/pg_restore isolado de staging uploading e prepared, bump operacional do epoch e resume da mesma B, sem ativação; signature/graph audit em READ ONLY | mesma integração e `stagingBackup.ts` |
| Digest backup v4 paginado, ciphertext/transition/fase comprometidos | `tools/self-hosted/test_staging_backup.py` |
| Instalação self-hosted limpa, TLS/contas, backup v4/verify/restore, read-only da instalação | `tools/self-hosted/smoke.py` |
| Cliente anterior real com seu próprio protocolo antigo | `tools/release/version-skew.cjs`, commits `8de0087cdbcdcc670ec2073ba3f4ea51932072b4` e `cbd7067644c63e6c09802b208731b43d239c0031` |
| Readiness Android: reconexão limitada de ADB/root antes dos fixtures, launch único aguardado e logs do UID do app; nenhum restart/reinstall/clear para passar o check | `tools/release/test_android_readiness.py`; processo/banco aberto/schema 8 continuam obrigatórios |

## Verificações locais

Resultados finais e CI são registrados no PR. A evidência não antecipa verde remoto. Foram executadas suítes de protocolo/local/server/desktop/mobile, typecheck/lint, integrações PostgreSQL/Keycloak, cliente anterior, self-hosted e diff check. Windows readiness e Android nativo dependem dos workflows; compilação Kotlin/Android instrumentation também verificada localmente. Resultados finais referem-se ao novo HEAD informado no PR.

## Limites adicionais

- Stress remoto desta evidência usa C1+C2; 107 operações/batching/decrypt são testados no domínio local, além do stress causal de PR #11. Não alegamos milhares de uploads PostgreSQL nesta suíte.
- Canary checks cobrem tabelas públicas locais/staging PostgreSQL; API sanitiza erros e não registra bodies. Não há nova instrumentação que registre tokens/secrets/plaintext.
- Recovery confirmation é validação local; o servidor verifica a declaração assinada, ciphertext e signature, sem conseguir verificar redigitação/DEK.
- Backup smoke cobre backup v4 da instalação normal; snapshots não vazios de staging usam pg_dump/pg_restore e o mesmo auditor criptográfico em bancos isolados.
- Scope B existe antes da ativação, mas o profile ativo/financeiro/outbox/binding A e C3 são preservados. Não existe activation transaction, sync B normal ou recuperação do segundo aparelho.
- `activationAvailable:false` permanece. Nenhuma decisão do Vault mudou.
