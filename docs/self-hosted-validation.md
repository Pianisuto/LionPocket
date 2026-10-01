# Evidência do self-hosted genérico

Base: `main` em `73ce2ced49e93c087636e0f4d125baa5278ba326`. Nenhuma decisão de `Vault/Visão e Decisões` foi alterada. Nenhuma conta/dado pessoal, servidor beta real, imagem pública ou release foi usado/publicado no ensaio.

## Matriz executada

| Camada | Comando/evidência | Resultado |
| --- | --- | --- |
| Configuração oficial | `npm run sync:self-hosted:validate` | Compose Caddy/proxy existente/addon CA válidos, segredos externos de fixture |
| Suítes sem stack | `npm test` | Core 61, desktop 110, Android 90, protocolo 39, sync-local 25, servidor 29, release 2 passaram; 25 casos de integração são condicionais |
| PostgreSQL/Keycloak existentes, sintéticos | `npm run sync:dev:test` | 53 passaram; 1 teste condicionado à implementação antiga executado separadamente abaixo |
| Cliente anterior v1 | `node tools/release/version-skew.cjs` | 3 passaram; motor/controller anterior de `8de0087cdbcdcc670ec2073ba3f4ea51932072b4` contra servidor atual |
| Instalação limpa oficial | `npm run sync:self-hosted:test` | API/PostgreSQL/Keycloak/Caddy descartáveis; 12 fases de contrato normal passaram |
| Tipagem | `npm run typecheck` | Todos os workspaces, harnesses existentes e self-hosted passaram |
| Lint | `npm run lint` | Sem erros; há avisos de estilo/non-null |
| Electron Linux normal/beta | `npm run package` e `LIONPOCKET_BUILD_CHANNEL=private-beta npm run package`; smoke em Xvfb | Ambos empacotam/abrem; SQLite legado preservado, integridade OK, perfis separados; backend inseguro `basic_text` recusado, uso local continua |
| Android normal | Gradle `assembleDebug` e `assembleRelease -PdevelopmentSigning=true -PreactNativeArchitectures=x86_64` | Compilação nativa/JS passou; assinatura de desenvolvimento explicitamente descartável |
| Android beta | Gradle `assembleRelease -PprivateBeta=true -PreactNativeArchitectures=x86_64` | Compilação passou; pacote/redirect beta preservados |
| Revisão de UI | `tools/self-hosted/ui-preview.html` com componente desktop real e somente status simulados | Local-only → uma URL → servidor/login apresentados → criar → recovery e confirmação → ações bound; detalhes técnicos recolhidos |
| Harness Android legado | Geração descartável Stage 1, parse do manifest e compilação Kotlin | Pacote `cryptospike`, callback `syncdev` e HTTP estritamente loopback preservados somente no harness; normal usa callback estável |
| Higiene | `git diff --check`, compilação Python e inspeção de arquivos novos | Sem whitespace inválido, secrets externos/backup/pycache ignorados |

A integração começa somente com repositório e `.env` gerado de fixture. Usa `lpctl init/up` (a mesma função Compose oficial), `user create`, `status`, discovery nos dois aliases, autenticação Authorization Code + PKCE S256, cofre, recovery, aprovação do segundo aparelho, baseline, alterações em ambas as direções e restart persistente. **Não há `privateBeta=true` ou flag de desenvolvimento nos controladores de aceitação**. São os adapters SQLite reais desktop/Android, com o controller genérico e defaults de produção. Desktop usa o adapter OIDC de produção/loopback real; o runner dirige apenas o formulário do IdP em vez de abrir o navegador do sistema. Android usa contrato OIDC equivalente no harness; teste separado comprova public client normal/redirect/AppAuth/code exchange seguro. Não se afirma login visual real em Android físico.

## Falhas e segurança

| Cenário | Evidência |
| --- | --- |
| DNS indisponível | Falha DNS injetada no transporte da fixture; ambos continuam lendo/escrevendo/planejando e mantêm outbox |
| Login expirado | Interação exigida injetada no provider; nenhuma escrita depende de login/rede |
| Certificado recusado | CA privada de fixture removida da confiança do runtime; HTTPS falha sem fallback |
| API/Keycloak/PostgreSQL fora | Cada container parado individualmente, depois stack inteira; novas escritas duráveis nos dois SQLite, retomada drena outbox |
| Conta desabilitada | `lpctl user disable` real; JWT anteriormente emitido com prova válida recusado; leitura/escrita continuam locais |
| Conta A versus cofre de B | Credencial de outro usuário com device/proof do cofre recusada |
| Device pendente/revogado | Pareamento não aprovado não recebe chave; suítes existentes recusam leitura/envio por device revogado e exigem rotação |
| Token sem prova/replay | JWT isolado recusado; proof reapresentado recusado |
| Issuer/audience/azp/state/nonce | JWTs com assinatura real e claims erradas recusados; callbacks forjados/duplicados recusados; produção aceita apenas clients do channel configurado |
| Assinatura/ciphertext alterados | Suítes de protocolo/servidor/transporte verificam recusa/quarentena sem projeção financeira indevida |
| Redirect de transporte | Endpoint de fixture responde 307 para origem diferente com JSON válido; envio com token/proof falha antes de seguir redirect. Android tem transporte nativo com `instanceFollowRedirects=false`, confiança TLS da plataforma e deadline/cancelamento |
| Discovery incompatível | Protocol/schema/capability desconhecida recusados antes de login/POST/baseline; dados/outbox preservados |
| Privacy canaries | Descrição/nota/valores de fixture ausentes dos **dois** dumps lógicos PostgreSQL; descrição/nota/recovery/tokens/JWT ausentes dos logs de toda a stack |

As falhas DNS/expiração são simulações explícitas; as interrupções dos containers, TLS, revogação administrativa, login OIDC, SQLite e backup/restore são reais no projeto descartável. Não há evidência alegada de operação em um homelab com DNS público/Let's Encrypt real. O ensaio confia explicitamente na CA interna de teste; nenhum certificado privado entra no repositório. Isto não substitui auditoria criptográfica independente.

## Backup e restore

`lpctl backup` conserva ambos os bancos, identidade, memberships/devices/grants/deliveries, security checkpoints/recovery cifrado, commits/receipts/log/cursors e IdP/usuários/chaves, configuração e segredos operacionais. Writers parados durante snapshot. `verify-backup` valida checksums e restaura em bancos separados, compara identidade/contagens/realm e ensaia novo epoch. Corrupção de dump é recusada antes de restore.

O restore real na stack descartável manteve serverId, gerou novo serverEpoch e permitiu criar outra conta pela ferramenta oficial (administrador/configuração restaurados). Cliente detectou epoch diferente **antes de envio**, conservando SQLite e a outbox byte a byte. A infraestrutura permaneceu saudável após o restore.

**Bloqueio preservado:** a retomada de cofres existentes entre epochs exige migração/reconciliação revisada ainda não implementada. Pins/envelopes/grants antigos permanecem assinados no epoch anterior; não são reescritos nem expostos como histórico atual. Restore operacional é restaurável/ensaiável, mas não é retomada automática dos cofres antigos. Mesma limitação para troca de operador/domínio. Veja [o guia](self-hosting.md#restore-operacional-e-serverepoch).

## Limites desta entrega

- Sem LionPocket Cloud público, billing, background/push Android, QR, migração automática ou purge/GC.
- Não muda applicationId/identidade de assinatura normal. APK normal local é candidato de desenvolvimento; assinatura pública continua sendo a decisão pendente já documentada em release readiness.
- Builds Windows/AVD permanecem no CI de readiness existente; nesta máquina a execução nativa foi Linux e compilação Android x86_64, não Android físico.
- Nome/realm/redirect/default endpoint/perfil/pacote e instalador diferem por channel; protocolo, segurança e escopo financeiro são os mesmos. A beta real não foi alterada no homelab.
- Aliases temporários `BetaSync`, `Beta*`, `beta-security`, `betaControl`, módulos/UI antigos preservam compatibilidade de código. Contextos assinados contendo `beta` e nomes históricos `ManualSync`/`DevelopmentSyncActions` conservados deliberadamente; não existe segundo motor nem gate beta para capacidades completas.
