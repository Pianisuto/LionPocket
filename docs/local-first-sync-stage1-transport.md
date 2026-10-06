# Transporte financeiro entre dispositivos

Aparelhos aprovados por [LPV2](device-pairing-lpv2.md) usam exclusivamente `POST /v2/devices/vaults/:vault/:action`, com grant ativo e prova assinada da identidade do aparelho. Não dependem de bearer token de conta. O protocolo financeiro, envelopes e domain schema continuam versão 1.

## Garantias

- Revisões são cifradas por XChaCha20-Poly1305 com nonce e associated data de escopo/operação. O commit é assinado por Ed25519. Envelope, digest, proveniência e deviceSeq são persistidos juntos e imutáveis após preparação; retry conserva bytes e renova somente a prova HTTP.
- PostgreSQL publica commit, operações, heads, recibo e posição em uma transação com lock do cofre. Repetição idêntica retorna o mesmo recibo; reutilização conflitante de IDs/seq é rejeitada. Registry, revogação, epoch, chave, assinatura e pais são verificados antes do append.
- Pull fixa horizonte e cursores por server/epoch/vault/binding/aparelho. A inbox é durável antes de avançar received_cursor; applied_cursor atravessa apenas posições aplicadas contíguas.
- SQLite valida/cifra/aplica revisões, heads, tombstones, conflitos e projeção em transação. Commit próprio não produz eco. Envelope inválido permanece em quarentena; falha de rede/cofre conserva pendências.
- Conflitos conservam ramos e base comum. Resolução referencia heads revisados. Delete/edit não ressuscita o original; recuperação financeira cria identidade nova com proveniência.
- Backup/restore local preserva finanças e sidecars, com sync desativado para revisão. Essas migrations e formatos de dados locais são preservados independentemente do contrato de convite.

`ManualSync` é o motor compartilhado de sync financeiro, acionado automaticamente pelo `SyncController` e pelo coordenador de foreground. O harness `manualTransaction` exercita o wire financeiro atual com fixtures reduzidas; não é outro fluxo de onboarding.

## Validação

```sh
npm run sync:dev:up
npm run sync:dev:test
npm test
npm run typecheck
npm run lint
npm run sync:dev:down
```

`transport.test.ts` usa PostgreSQL/Keycloak, adapters Desktop/Android, LPV2 para preparar os dispositivos e transporte assinado para commits. Cobre concorrência, retry, replay, restart, scopes, receipts, pagination, pais, conflitos, zero/NULL, atomicidade, backup e revogação. `pairing.integration.test.ts` cobre o produto completo, incluindo QR/deep link e primeiro sync; os smokes instalados verificam protocolo do SO e instância única.
