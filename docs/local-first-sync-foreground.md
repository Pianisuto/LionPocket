# Beta privada — sincronização automática em foreground

01/10/2026. Evolução sobre `main` após o PR #5 (`7ca214516eb5a9202a19085dd9baee810fe9d6ac`). Implementa o incremento de foreground/debounce previsto na [proposta](local-first-sync-proposal.md#54-idempotência-log-e-cursores), preservando os [contratos](local-first-sync-contracts.md), E2EE e as fronteiras da [revisão de segurança](local-first-sync-private-beta-security.md). Não altera decisões do vault `Visão e Decisões.md`.

## Uso

A sincronização é solicitada ao abrir/retomar a beta com binding ativo, após uma escrita sincronizável confirmada no SQLite e pelo botão **Sincronizar agora**. O aplicativo precisa estar ativo. No Android, o gatilho é `AppState` do React Native; no desktop, o foco real da janela Electron. Os listeners são removidos ao desmontar/sair. O perfil/app normal continua funcionando sem conta, internet ou servidor.

As alterações financeiras são sempre salvas localmente primeiro, incluindo revisão e outbox na mesma transação existente. A notificação ocorre **depois** do COMMIT. Não aguarda rede; falha do transporte ou do observador não muda o resultado do salvamento. Aplicação remota usa o mecanismo existente de inbox/`applying`, sem notificação de escrita local e sem loop de transporte.

O debounce interno padrão é **2 segundos após a última escrita**, configurável no coordenador. É um intervalo conservador para reunir edição, novo salvamento, prioridade e realização rápidas. Controla somente quando transportar: não compacta, reescreve nem elimina commits já confirmados. A formação de um commit indivisível dentro de uma transação continua sendo a do PR #5.

O botão manual antecipa o debounce. Se já houver um ciclo, os pedidos manuais coalescem em uma passagem posterior; uma escrita durante o ciclo também pede nova passagem. Focos próximos são absorvidos, inclusive na janela de 2 segundos após o início do ciclo. Não há polling: uma alteração feita em outro aparelho será recebida no próximo gatilho local/foreground/manual.

## Coordenação e transporte

`bankSyncCoordinator` em `@lionpocket/sync-local` mantém um coordenador por adapter de banco; o desktop conserva um adapter estável e ambos os apps conservam um único controller. A reserva de execução acontece antes de qualquer `await`, incluindo elegibilidade e sessão. Pedidos recebidos durante esses awaits pertencem à próxima passagem. Timer, pedido pendente e waiters manuais compartilham o mesmo estado, sem caminhos distintos para desktop e Android.

Cada passagem verifica binding financeiro ativo e pausa, negocia/valida ambiente e sessão, e reutiliza o motor existente: **pull → aplicar/reconciliar → push da outbox na ordem existente → pull final**. ACK de push continua sem avançar cursor de recepção. Não há migration ou alteração do formato wire, suite criptográfica, causalidade, regras de conflito ou retenção.

Ao deixar o foreground, o timer é suspenso e o `AbortController` cancela a requisição em curso. O motor verifica cancelamento antes de cada nova chamada. Respostas já recebidas podem terminar sua persistência local; não dependemos de o Android continuar executando para conservar pendências. Retornar solicita outra passagem. Um login iniciado conscientemente pelo botão pode abrir browser/Custom Tab e tirar o foco: o pedido manual permanece aguardando a retomada, sem transportar no estado inativo.

As requisições de sync têm deadline de **15 segundos**, incluindo leitura do body. Falhas automáticas são best-effort, sem retry contínuo ou login espontâneo. Nova escrita, retomada, despausa ou botão permitem tentar novamente. Outbox preparada/retry conserva os mesmos bytes; bloqueios permanentes e quarentena continuam preservados.

## Sessão e status

Sessões OIDC validadas são reutilizadas **somente em memória**, até 30 segundos antes da expiração do access token. Issuer/subject e servidor/epoch são conferidos. Não há novo armazenamento de credenciais ou refresh token. Após encerrar/reabrir o processo ou expirar a sessão, o automático indica ação necessária; a pessoa usa **Sincronizar agora** para entrar novamente. Revogação/negação de autenticação invalidam a sessão em memória. Conta/chaves indisponíveis nunca impedem uso financeiro local.

O status combina execução/erro transitórios com estruturas duráveis: outbox, bloqueios, pausa, revisão do bootstrap/restore, conflitos e quarentena. “Sincronizado” exige uma passagem concluída e ausência de pendências/revisões. A hora do último sync concluído só aparece quando conhecida pelo controller desta execução; não é inventada a partir de cursor/ACK nem persistida como estado financeiro. Os apps recebem notificações de status/conclusão para atualizar telas sem polling.

## Correção de validação encontrada

O validador antigo de recibos exigia UUIDv4 em `heads.objectId`, enquanto envelopes e identidades da beta já permitem UUIDv5 (prioridades, slots e importação comprovada). Isso fazia uma prioridade aceita permanecer em retry e impedia enviar seus descendentes. A correção aceita o **mesmo conjunto UUIDv4/UUIDv5 já previsto para objectId**, conservando UUIDv4 para commit/device/revision IDs e as demais verificações de recibo/digest. Não muda bytes, protocolo, derivação de identidade ou decisão de produto. Há regressão específica e cenário financeiro de edição/prioridade/realização.

## Limites

Android fechado **não possui garantia de transporte**. Não há service, WorkManager, push, websocket, polling contínuo ou processo mantido vivo. Background sync permanece uma etapa futura. Desktop sem janela ativa também suspende novos transportes. Sessão interativa necessária, timeout, offline, servidor indisponível, DEK bloqueada, dispositivo revogado e revisão pendente conservam o banco local e a outbox. O ensaio físico destrutivo do PR #5 não é repetido por este incremento; testes de lifecycle e adapters não são apresentados como ensaio de Custom Tab/aparelho físico.

## Validação

Os testes determinísticos usam relógio controlado, promises de rede suspensas, SQLite real nos dois adapters e envelopes realmente cifrados/assinados. Cobrem coalescing, pedidos durante execução/elegibilidade, manual antecipando debounce, foco próximo, pausa, cancelamento/resume, escrita durante espera de rede, timeout, login exclusivamente manual, retry com bytes idênticos, outbox após reabertura, aplicação remota sem eco e cleanup de listeners.

| Verificação | Resultado |
| --- | --- |
| `LIONPOCKET_SYNC_INTEGRATION=1 npm test` | **351 aprovados**, zero skipped: core 61, desktop 98, Android adapter/lifecycle 86, protocolo 39, sync-local 14, servidor 53. PostgreSQL/Keycloak reais disponíveis; inclui transporte automático de quatro commits financeiros rápidos, preservados byte a byte. |
| Vitest desktop com `ELECTRON_RUN_AS_NODE=1` no Electron 43.4.0 | **98 aprovados** |
| `npm run typecheck` | Aprovado em todos os workspaces e no client de desenvolvimento |
| `npm run lint` | Zero erros, **73 avisos** (inclui avisos históricos e assertions nas fixtures de teste) |
| `npm run package` | Desktop Linux x64 empacotado |
| `:app:assembleDebug :app:assembleRelease -PprivateBeta=true -PreactNativeArchitectures=arm64-v8a` | APKs debug e release da beta aprovados; assinatura de desenvolvimento existente |
| `git diff --check` | Aprovado |

Build Android usou Temurin **21.0.12.1+1**, isolado em `/tmp`, com archive SHA-256 `ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94`, SDK existente e `--no-daemon --max-workers=2 -Dorg.gradle.vfs.watch=false`. O JRE do sistema não tem `javac`; a primeira tentativa com ele foi recusada antes da compilação, e o build com JDK completo passou. Nenhuma configuração Java global foi alterada. Gradle conserva seus avisos de depreciação existentes.

Artefatos locais em `apps/mobile/android/app/build/outputs/apk/` e `apps/desktop/out/`, sem inclusão de binários no Git. SHA-256 Android debug: `890572d518cb9fee77849984dacfbe0db99a7f9ea1500cb388db61619e9082fe`; release: `b683b427bb0c72bd3344b59aacd66893f0707da749dd0aa283663768ba309f54`.

| Critério obrigatório | Evidência determinística |
| --- | --- |
| 1, 2, 4, 5 — debounce, escrita durante ciclo, foco próximo, manual | `coordinator.test.ts`, `foregroundSync.test.ts` e `foregroundWrites.test.ts`; escrita real enquanto push aguarda rede |
| 3, 7 — foreground elegível e pausa | Coordenador, lifecycle Electron/RN e adapters financeiros |
| 6 — inbox sem loop | Aplicação de envelope cifrado/assinado real nos dois adapters; zero notificações locais/outbox nova |
| 8, 10 — falha não bloqueia escrita, pending conservado | SQLite real, erro offline e resposta 503; retry reutiliza o envelope preparado |
| 9 — interação somente consciente | Sem chamada de login em automático; expiração e reabertura; pedido manual preservado durante blur do browser |
| 11 — fechar/reabrir e tentar no próximo foreground | Reabertura do mesmo arquivo SQLite/outbox com controller novo, sem restaurar sessão |
| 12 — nenhum requisito de execução Android inativo | Timer suspenso, abort, retomada e cleanup; inicialização tardia não revive listener desmontado |

Nenhum teste destrutivo, reinstalação ou acesso ao banco pessoal foi feito neste incremento. A validação física anterior não é reclassificada como teste deste PR.
