# Beta privada de sincronização financeira

A beta usa `com.lionpocketmobile.beta` no Android e o perfil `LionPocket Beta` no desktop (`--private-beta`). O pacote e o perfil normais continuam separados. O uso local funciona sem conta. Categorias, formas de pagamento, cartões, lançamentos, recorrências, compras parceladas, objetivos e as duas listas de prioridades usam o mesmo protocolo no ambiente local e no LionsLab.

## Sincronização automática com o app ativo

A evolução após o PR #5 solicita sync ao abrir/retomar a beta e 2 segundos após a última escrita sincronizável confirmada no SQLite. **Sincronizar agora** permanece e antecipa essa espera. Debounce/coalescing controla o transporte, sem compactar commits. Offline não bloqueia uso nem salvamento financeiro. O automático nunca abre login: após reiniciar o processo ou expirar a sessão, use o botão para entrar conscientemente.

Android fechado não tem garantia de transporte; não há background service, WorkManager, push ou polling. Background sync continua futuro. Veja [arquitetura, status, lifecycle e validação do foreground](local-first-sync-foreground.md). A entrega e as evidências manuais do PR #5 abaixo são históricas.

## Instalar e conectar

1. Instale o APK arm64 da entrega no Galaxy S23. Abra **LionPocket Beta**. Não desinstale nem limpe o LionPocket normal.
2. Extraia o desktop, entre na pasta `LionPocket-linux-x64` e execute `./LionPocket-Beta.sh`. No Linux, o cofre do sistema precisa estar disponível; a beta recusa armazenamento de chaves em `basic_text`.
3. Em **Dados locais** no Android ou **Configurações** no desktop, abra **Sincronização · Beta privada**. O endpoint é `https://sync-beta.lionslab.dev`. Confira a base e autorize sua cópia anterior à vinculação. Entre com a conta privada fornecida fora do Git.
4. Crie o cofre em um aparelho. No outro, cole o convite público e confira o código da autoridade na tela do primeiro. Entre e envie o pedido. No fundador, busque pedidos e digite o código mostrado no outro aparelho. Aprove e entregue a chave. No outro, receba a chave aprovada.
5. Sincronize primeiro para receber a base. Se houver cadastros de mesmo nome, confira a lista e conserve ambos com nomes locais distintos. Isso preserva suas identidades e referências. Confirme a combinação das bases somente após revisar a quarentena; então sincronize novamente para enviar a base local.

O convite e os fingerprints são públicos. Senhas, código de recovery, chaves e tokens não devem ir a issues, capturas públicas ou logs.

## Testar pelos apps

- Crie um lançamento com categoria, cartão ou forma de pagamento. Sincronize os dois aparelhos; confira referências, centavos e totais. Faça uma alteração no segundo e sincronize novamente em ambos.
- Trabalhe offline, feche/reabra o app e confira os registros. **Pausar mantendo pendências** suspende o transporte; as escritas locais continuam na outbox.
- Gere a mesma competência de uma recorrência nos dois aparelhos offline. Os slots compartilham identidade; seus caches locais não se tornam novos lançamentos independentes. Aliases de slots pertencem ao agregado da série. Confira também ciclo de cartão e parcelas.
- Faça duas edições offline incompatíveis, depois sincronize. A tela conserva os ramos e oferece a escolha de uma versão completa. Campos compatíveis usam merge por grupos; realização e ciclo de cartão não são separados. Uma resolução obsoleta é conservada como rascunho recusado.
- Excluir e editar offline não ressuscita o original. A recuperação de um ramo excluído cria um novo registro com referência ao original.
- Importar o mesmo arquivo XLSX renomeado identifica repetições por arquivo/aba/linha. Nomes iguais de séries ou objetivos não provam repetição. A confirmação da importação expõe a associação dos cadastros por nome. Arquivos distintos continuam distintos.
- Séries e importações antigas sem proveniência ficam em revisão. Informe as identidades originais dos slots após conferir o histórico. Não use a data editada como evidência de uma data original. A conversão explícita de importação antiga para manual conserva o conteúdo anterior na auditoria.

## Recovery, revogação e restore

No aparelho com autoridade, gere o código de recovery, guarde-o fora do app e digite novamente para confirmar a posse. Só então o envelope cifrado é publicado. A rotação atualiza o mesmo recovery confirmado com as chaves históricas. Em nova instalação separada, confira o convite/autoridade, entre com a mesma conta e use o código guardado para recuperar. Revogue o aparelho perdido pelo ID; a revogação bloqueia commits imediatamente até a rotação terminar. A tela permite retomar essa operação se houver interrupção.

Os backups locais conservam sidecars, história, cursores, pendências e bytes já preparados. Restaurar desabilita o transporte. Reconectar exige o mesmo aparelho, cofre e epoch, salva nova cópia e prepara diferenças como ramos locais. Receba e revise o remoto antes de liberar envio. Uma cópia de outro aparelho exige recovery/pareamento em instalação separada; copiar wrappers do cofre não é um caminho de migração.

Para retornar ao estado normal, feche a beta e abra o LionPocket original. Não é necessário restaurar o original quando só a instalação separada foi usada. Guarde os backups antes de remover a beta: suas chaves locais não pertencem ao export financeiro.

## Decisões de identidade da beta

PKs e FKs locais permanecem opacas e inalteradas. Identidades comuns e legadas recebem UUIDv4 em sidecars. Importações comprovadas usam hash dos bytes do arquivo e coordenadas de aba/linha, com UUIDv5 dentro do vault; renomear o arquivo não muda essa proveniência. Valor, descrição ou nome iguais não estabelecem identidade.

Para novas parcelas, a definição publicada inclui reservas completas dos slots: `slotId` usa UUIDv5 no namespace da compra e índice original, e o objeto deriva desse slot imutável. Isso torna a reserva determinística entre duas gerações offline. A numeração exibida é atributo corrigível e não muda o slot. É uma extensão explícita da regra de `slotId` UUIDv4 do documento da Etapa 0; dados legados continuam com identidades aleatórias e revisão, sem derivar prova da numeração/data editadas. Aliases de recorrências recebidos prevalecem sobre novas derivações; caches não são publicados como lançamentos financeiros independentes.

Pendências antigas reemitidas após rotação continuam arquivadas com bytes e proveniência. O contador de pendentes omite esse histórico já substituído, mas mantém bloqueios que exigem decisão. Não são marcadas como ACK falso.

## LionsLab: operação isolada

`tools/sync-beta/compose.yml` usa o projeto `lionpocket-beta`, PostgreSQL e Keycloak próprios e um túnel dedicado, sem publicar portas no host. Os arquivos privados estão em `~/apps/lionpocket-beta/runtime`; os backups, em `~/apps/lionpocket-beta/backups`. `.env`, credenciais do túnel, usuários privados e bancos não fazem parte do checkout. O realm público define PKCE/S256 e redirects explícitos.

Para atualizar, envie somente a fonte pública necessária ao Dockerfile, construa uma nova tag imutável e execute no LionsLab:

```sh
LION_BETA_RUNTIME="$HOME/apps/lionpocket-beta/runtime" ./operate.sh backup
./operate.sh verify-backup ../backups/SEU_BACKUP
./operate.sh deploy lionpocket-beta:SUA_TAG
```

Copie `operate.sh` da fonte para o diretório de operação antes de usá-lo. Para rollback de código, use `./operate.sh rollback lionpocket-beta:TAG_ANTERIOR`; não faça rollback dos bancos. Para reiniciar, use `./operate.sh restart` e confira `/v1/environment` e o discovery OIDC por HTTPS. O Keycloak pode precisar de alguns segundos para voltar.

Um restore remoto com perda de história exige um novo `serverEpoch` e reconciliação explícita nos clientes. Não reutilize o epoch antigo para aparentar continuidade de um log truncado. O ensaio usa bancos temporários separados e não restaura por cima do serviço ativo. PostgreSQL/Keycloak/túnel/API existentes de outros projetos ficam fora desse namespace.

## Limites da entrega

- É uma beta privada, sem auditoria independente de criptografia. A revisão de código e os testes desta entrega não equivalem a essa auditoria. Prefira fixtures e cópias isoladas durante a avaliação.
- Conteúdo financeiro remoto é cifrado. SQLite, JSON, CSV e backups locais permanecem em claro. JavaScript cria algumas representações de segredos em strings que não permitem limpeza garantida de memória; buffers de chaves são apagados também em caminhos de erro.
- O transporte ocorre automaticamente somente em foreground, com botão manual disponível; não há push, sync em background ou serviço Cloud público. Logs/receipts preservam metadados públicos de identidade, causalidade, volume e tempo.
- Um lote financeiro com mais de 100 operações é conservado e bloqueado com `batch_too_large`; não é fragmentado silenciosamente. Use lotes menores. Baseline é retomável em commits individuais.
- A revisão de cadastros oferece conservar ambos separadamente. A fusão arbitrária de duas identidades globais de catálogo já publicadas não está habilitada; aliases implementados nesta beta são os de slots e os recebidos na linhagem existente.
- Restore com remoção física de registros exige confirmação explícita das exclusões encontradas. Diferenças de prioridades também são preparadas como ramos e ficam sujeitas à revisão da base remota.
- O APK de teste usa assinatura de desenvolvimento. Distribuição de produção e política de retenção/purge remota ainda precisam ser definidas antes de lançamento público.

Veja os resultados e hashes em `docs/fixtures/local-first/private-beta-results.json`. Os critérios de teste nativo devem ser registrados como executados somente após o respectivo ensaio; testes de repositório e o driver HTML OIDC de integração não substituem o Custom Tab/aplicativo físico.

## Evidências da entrega

A suíte reúne 322 testes aprovados com a integração habilitada: core 61, desktop 88, mobile 81, protocolo 38, motor local 2 e servidor 52. O desktop também passou os 88 testes no Node do Electron. Lint passou com zero erros e 59 avisos existentes/novos; typecheck e os dois builds passaram.

O teste nativo usou Galaxy S23 SM-S911B / Android 16, Custom Tab e Electron 43.4.0 no Linux, com duas sessões reais OIDC. Criamos, pareamos com convite e aprovação, recebemos a chave v2, enviamos os cadastros, revisamos nomes iguais preservando ambas as bases, criamos uma saída de R$ 12,34 / realizado zero no desktop e recebemos no celular; a realização no celular voltou ao desktop com categoria e data preservadas. Os 60 commits ficaram aplicados sem quarentena. Testes de planejamento/importação/conflitos/recovery adicionais são de repositório e integração, não todos repetidos manualmente no aparelho.

Os originais ficaram separados. As nove tabelas financeiras do desktop original continuam iguais ao snapshot inicial, com integridade/FKs válidas. O Android original mantém APK, versão e atualização; seu banco privado release não foi extraído nem alterado. O export suportado anterior e o APK guardados fora do Git são referências privadas, não uma alegação de snapshot atual desse SQLite. Veja a [revisão de segurança](local-first-sync-private-beta-security.md) e os [resultados estruturados](fixtures/local-first/private-beta-results.json).
