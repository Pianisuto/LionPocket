# Spike criptográfico delimitado — Etapa 0

Data: 30/09/2026. Resultado: **PASS de vetores entre Node/Linux e libsodium C; INCONCLUSIVO Android↔desktop real**. Não existe criptografia de sync nos apps e nenhuma dependência crypto foi adicionada a seus manifests/lockfile. Não autoriza transportar dados reais.

## Pergunta e recorte

A suite candidata da [proposta](local-first-sync-proposal.md) consegue reproduzir bytes canônicos, ciphertext/tag e assinatura; abrir sealed boxes de outra implementação; e recusar adulteração? O recorte é exclusivamente esse, com chaves públicas de teste e uma revisão manual contendo centavos `1234`, realizado `0`, campos NULL, Unicode e int64 textual acima de `Number.MAX_SAFE_INTEGER`.

Fora do spike: integração JSI/Hermes ou cofre, instalação de binding no Android, login/pairing, servidor, recovery, rotação, implementação própria de primitivas, UI ou dados de usuário. O processo nativo é libsodium já disponível no Linux; o wrapper JS foi instalado em diretório temporário separado, com versão exata e scripts npm desativados.

## Artefatos fixos e resultado observado

| Evidência | Resultado |
| --- | --- |
| [`serialization.json`](../packages/sync-protocol/fixtures/serialization.json) | String canônica, hex UTF-8 e SHA-256 fixos; zero/NULL, decimal textual, escapes, acento composto/decomposto e ordenação UTF-16 de chaves Unicode. Testado pelo pacote portável no Node. |
| [`crypto-input.json`](../packages/sync-protocol/fixtures/crypto-input.json) | Entrada explícita para regeneração controlada. Ciphertext vazio é placeholder do gerador, **não envelope válido para transporte**. |
| [`crypto.json`](../packages/sync-protocol/fixtures/crypto.json) | Plaintext/AAD/signing input exatos, chaves/nonce de teste, ciphertext combinado, assinatura detached, SHA-256 completo, chave X25519 e sealed box fixa para abertura. |
| `crypto-native.py` | libsodium **1.0.18**, Linux via ctypes/C ABI. AEAD e Ed25519 reproduzem os bytes fixos; ciphertext/AAD/nonce/chave adulterados são recusados. Sealed box alterada/destinatário errado são recusados. |
| `crypto-desktop.cjs` | Node **v24.21.0**, `libsodium-wrappers-sumo` **0.8.4**, libsodium **1.0.22**. Mesmos bytes/hash; verifica serialização/AAD/assinatura com o pacote. Abre sealed box C e recusa mudanças/chave errada. |
| Troca no sentido inverso | Wrapper gera nova sealed box aleatória em arquivo temporário; C ABI abre e compara bundle completo. AEAD e assinatura do wrapper também coincidem com o vetor nativo. Sealed boxes são aleatórias: abertura, não igualdade entre duas cifragens, é o teste correto. |
| Testes padrão do contrato | OpenSSL de `node:crypto` verifica assinatura Ed25519 do vetor nativo e reprova alteração do cabeçalho. Nenhuma dependência sodium necessária ao `npm test`. |
| Electron main empacotado | **Não comprovado.** Binário de desenvolvimento de Electron ausente em `node_modules/electron/dist`. Tentativa com executável instalado 43.4.0 abriu a UI, pois o pacote tem `RunAsNode=false`; processo encerrado sem ações financeiras. Não contou como execução dos vetores. |
| Android/Hermes | **Não executado.** `adb devices` não tinha dispositivo/emulador conectado; o app não tem binding sodium. Suíte Node de repositório mobile usa SQLite do Node, não prova interoperabilidade crypto nativa. |

Só os vetores do **commit de revisão** e do **bundle de entrega de chave** foram exercitados. Não há vetor nem validação de registry/trust/recovery/HTTP signatures. AAD/signing input são congelados no [contrato](local-first-sync-contracts.md); qualquer mudança exige versão/revisão de vetores antes de integração.

## Construções e compatibilidade examinada

O AEAD combinado de [libsodium XChaCha20-Poly1305](https://libsodium.gitbook.io/doc/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction) usa nonce de 24 bytes e anexa tag de 16 ao ciphertext; o binding precisa concordar com essa disposição. [Sealed boxes](https://libsodium.gitbook.io/doc/public-key_cryptography/sealed_boxes) usam X25519 com **XSalsa20-Poly1305**, não XChaCha; autenticam a integridade e o destinatário, não o remetente. A autoria de entrega depende de assinatura externa. Os vetores e testes seguem as APIs publicadas; não há primitives próprias.

O [wrapper oficial libsodium.js](https://github.com/jedisct1/libsodium.js) forneceu candidato JS isolado. O candidato [react-native-libsodium](https://github.com/serenity-kit/react-native-libsodium/tree/052cb17825b2b24e7d616a0264ef339b0e3667f3), snapshot `052cb17825b2b24e7d616a0264ef339b0e3667f3`, declara versão 1.7.0 e exporta AEAD XChaCha, sign detached/seed keypair, box seal/open e randombytes em [`src/lib.ts`](https://github.com/serenity-kit/react-native-libsodium/blob/052cb17825b2b24e7d616a0264ef339b0e3667f3/src/lib.ts). Seu [`package.json`](https://github.com/serenity-kit/react-native-libsodium/blob/052cb17825b2b24e7d616a0264ef339b0e3667f3/package.json) usa RN 0.83.1 em desenvolvimento; LionPocket usa RN 0.87.1/Nitro/Hermes. A presença das APIs no código é evidência de **candidato**, não prova de ABI, CSPRNG, UTF-8 ou funcionamento na arquitetura atual.

Não selecionar definitivamente o binding com base em peerDependencies `*` ou na equivalência dos nomes de função. A suite de bytes mostrou convergência de libsodium 1.0.18/1.0.22 no recorte, mas não é auditoria de dependências, prova de armazenamento de segredos ou E2EE pronta.

## Reprodução sem mudar os apps

Da raiz do repositório, com Node e libsodium do sistema disponíveis:

```bash
npm run build:contracts
npm run test --workspace @lionpocket/sync-protocol
python3 tools/sync-stage0/crypto-native.py
sync_spike_dir=$(mktemp -d /tmp/lionpocket-sync-crypto.XXXXXX)
npm install --prefix "$sync_spike_dir" --ignore-scripts --no-audit --no-fund libsodium-wrappers-sumo@0.8.4
node tools/sync-stage0/crypto-desktop.cjs "$sync_spike_dir" "$sync_spike_dir/sealed-exchange.json"
python3 tools/sync-stage0/crypto-native.py --sealed-input "$sync_spike_dir/sealed-exchange.json"
```

Os runners verificam arquivos **fixos** por padrão. Regeneração é explícita: `npx tsx tools/sync-stage0/create-protocol-vectors.ts` seguido de `python3 tools/sync-stage0/crypto-native.py --generate`. Revisar diff de input/AAD/ciphertext/assinatura/hash; não regenerar para esconder uma falha. A sealed box do gerador terá bytes diferentes, por usar randomness nativa. Em produção não usar seed/nonce determinísticos, Python/ctypes, este runner ou qualquer chave da fixture.

## Próximo experimento obrigatório

Instalar/pinar o binding em ambiente descartável de desenvolvimento, sem bases pessoais, e executar os **mesmos arquivos fixos** em Android físico/emulador, build debug e release, com RN 0.87.1/Hermes/arquitetura atual. Executar também no Electron main de desenvolvimento; usar harness próprio separado do executável instalado, respeitando seus fuses.

Conferir hex UTF-8 incluindo chaves Unicode fora do BMP; AEAD/Ed25519 nos dois sentidos e byte a byte; sealed box bidirecional; validação negativa de todas as mudanças de AAD/nonce/ciphertext/signature, truncamento e destinatário errado; formatos de chaves/ArrayBuffer/Uint8Array e RNG nativo. Depois validar wrapping Keystore/cofre, assinatura de registro e entrega, código de recovery/rotação com vetores próprios. Registrar versões nativas/ABIs e revisão independente. Se falhar, mudar suite/binding e **versionar** o contrato antes de implementar o transporte; não oferecer fallback plaintext.
