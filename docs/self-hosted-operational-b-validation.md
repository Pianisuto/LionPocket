# Evidência: preparação operacional B (draft)

Base exata: `cbd7067644c63e6c09802b208731b43d239c0031`. Fixtures sintéticas; nenhum dado/cofre de usuário, Vault ou geração ativa foi migrado.

## Limitação que impede ready-for-review

A API SecretStore atual não oferece uma reserva atômica recuperável de múltiplos secrets. O journal público é persistido antes das writes e compromete os artifacts/material esperado. Crash antes de persistir todos os seeds/DEK/master aleatórios deixa material reservado ausente, impossível de reconstruir sem derivar chaves ou guardar material privado fora do SecretStore. O domínio bloqueia com `secret_reservation_incomplete` e preserva A/tentativa. Esses faults **não convergem** automaticamente; foram testados como bloqueio seguro. Não se anuncia que o critério completo de término do pedido foi atendido.

Uma write atômica de múltiplos secrets, sozinha, também não resolve crash entre reserva pública fixa e primeira persistência. Resolver essa janela exige um contrato de durabilidade/protocolo que torne os bytes aleatórios reservados recuperáveis; não afirmamos que adicionar apenas um método batch ao SecretStore basta.

O recorte não escolhe uma nova decisão do Vault nem tenta corrigir a limitação com seeds derivados da authority, DEK derivada de A, secret em SQLite, reset de keyVersion ou nova identidade durante retry. PR deve permanecer draft.

## Casos comprovados

| Área | Evidência executável |
| --- | --- |
| Base 1/4/20, rotações N+1/N+2, pairing após rotação, recovery só deste epoch | `apps/desktop/src/main/sync/epochKeyBase.test.ts` |
| Parsing recovery legacy/v2 estrito, recoveryVersion acima de MAX_SAFE_INTEGER | mesma suíte e vetor `fixtures/epoch-staging.json` |
| Genesis separado e digest chains determinísticos, Ed25519 independente | `packages/sync-protocol/src/epoch-staging.test.ts` |
| Identidade B nova, installation preservada, mesma authority, DEK nova/scopes distintos | `epochPreparation.test.ts` (desktop e adapter SQLite Android) |
| Master confirmado A reutilizado, mesmo LP1, ciphertext novo; master novo/redigitação; instalação limpa | mesma suíte |
| Reserva antes de secrets, faults parciais bloqueados, todos os secrets duráveis permitem resume | mesma suíte, faults identity/signing/box/data/authority/master/recovery |
| Envelopes persistidos uma vez, retries após begin/envelope/batch/manifest/validate/transition/remote prepared | mesma suíte |
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

Resultados finais e CI são registrados no PR. A evidência não antecipa verde remoto. Foram executadas suítes de protocolo/local/server/desktop/mobile, typecheck/lint, integrações PostgreSQL/Keycloak, cliente anterior, self-hosted e diff check. Windows/Android readiness dependem dos workflows, sem alegação de execução nativa local nessas plataformas.

## Limites adicionais

- Stress remoto desta evidência usa C1+C2; 107 operações/batching/decrypt são testados no domínio local, além do stress causal de PR #11. Não alegamos milhares de uploads PostgreSQL nesta suíte.
- Canary checks cobrem tabelas públicas locais/staging PostgreSQL; API sanitiza erros e não registra bodies. Não há nova instrumentação que registre tokens/secrets/plaintext.
- Recovery confirmation é validação local; o servidor verifica a declaração assinada, ciphertext e signature, sem conseguir verificar redigitação/DEK.
- Backup smoke cobre backup v4 da instalação normal; snapshots não vazios de staging usam pg_dump/pg_restore e o mesmo auditor criptográfico em bancos isolados.
- Scope B existe antes da ativação, mas o profile ativo/financeiro/outbox/binding A e C3 são preservados. Não existe activation transaction, sync B normal ou recuperação do segundo aparelho.
- `activationAvailable:false` permanece. Nenhuma decisão do Vault mudou.
