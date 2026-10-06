# Provisioning e identidade dos dispositivos

O contrato de produto é [LPV2](device-pairing-lpv2.md). O fundador autentica a conta por Authorization Code/PKCE e cria autoridade, identidade de escrita, identidade X25519 e chave financeira independentes. Um aparelho adicional cria sua identidade e solicita aprovação com a capability LPV2, sem OIDC.

`DeviceProvisioning` implementa as primitivas criptográficas compartilhadas: pedido com prova de posse, grant assinado pela autoridade, registry encadeado e delivery sealed-box ao destinatário. O fingerprint é parte do transcript assinado; a comparação humana usa o SAS visual. O transporte HTTP é exclusivamente o modelo de dispositivo com grant ativo e prova assinada. Recovery tem [contrato LPR1 próprio](recovery.md).

## Validadores e testes

As suites de segurança verificam escopo, assinatura, autoridade, chave derivada, ordering, fork, rollback, revogação, limites de dispositivos, recipient, bundle e colisão de chave. `receive` em `DeviceProvisioning` é a abertura/validação criptográfica interna da delivery, executada automaticamente pelo controlador; não é uma ação pública de onboarding.

Os vetores públicos em `packages/sync-protocol/fixtures/provisioning.json` usam requests, grants e proofs do protocolo criptográfico atual. Formato 1 dessas primitivas não significa outro formato de convite. `tools/sync-dev/native-checks.cjs` conserva as verificações de crypto e cofre nos adapters nativos.

Para executar testes reais com PostgreSQL/Keycloak e ambos os bancos SQLite, usando somente fixtures sintéticas:

```sh
npm ci
npm run sync:dev:up
npm run sync:dev:test
npm test
npm run typecheck
npm run lint
npm run sync:dev:down
```

Os testes criam/removem seus próprios bancos PostgreSQL. Nenhuma base pessoal é aberta. Credenciais em `tools/sync-dev/realm.json` pertencem somente ao ambiente sintético. O produto instalado usa a configuração HTTPS/OIDC descoberta no endpoint próprio.
