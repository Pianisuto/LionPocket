# LionPocket em servidor próprio

O LionPocket funciona inteiramente no SQLite deste aparelho. Sincronização é opcional: desligar o servidor não impede consultar dados, salvar lançamentos ou usar planejamento. Desktop e Android enviam conteúdo financeiro cifrado ponta a ponta ao mesmo Sync Server. Uma instalação pessoal não depende do LionPocket Cloud ou de contas oficiais.

## Instalação pessoal: caminho recomendado

1. Separe uma máquina Linux com Docker Engine, Compose **2.24.4 ou posterior** (o ensaio usa `!reset`), Python **3.11 ou posterior**, Git e acesso à internet para baixar dependências. Reserve inicialmente 2 CPUs e 4 GB de RAM; ajuste ao uso. A distribuição compila a imagem do servidor no host; o **aplicativo instalado não precisa ser recompilado**.
2. Crie dois nomes DNS apontando para essa máquina: `sync.meudominio.com` e `auth.meudominio.com`. No caminho Caddy, libere TCP 80/443 e, opcionalmente, UDP 443; não publique PostgreSQL, API interna ou o painel administrativo do Keycloak. Os dois nomes precisam estar acessíveis aos aparelhos.
3. Obtenha o repositório e prepare a configuração:

   ```sh
   git clone https://github.com/Pianisuto/LionPocket.git
   cd LionPocket/deploy/self-hosted
   cp .env.example .env
   ```

4. Edite **somente `.env`**. Troque `SYNC_HOST` e `AUTH_HOST` pelos seus nomes DNS, sem `https://`, caminhos ou portas. Mantenha `REVERSE_PROXY=caddy`. O exemplo guarda os quatro segredos em **`~/.local/share/lionpocket-sync/secrets`**, realmente fora do checkout. Você também pode escolher caminhos absolutos externos, como `/srv/lionpocket/secrets/postgres`, `sync`, `auth`, `admin`. `lpctl` expande `~`, resolve symlinks e fornece caminhos absolutos ao Docker Compose; recusa qualquer segredo cujo destino fique dentro do checkout. `.env.example` não contém senhas ou contas; os hosts de exemplo são recusados pela ferramenta.
5. Gere os segredos e suba os serviços:

   ```sh
   ./lpctl init
   ./lpctl up
   ./lpctl status
   ```

   `init` cria senhas aleatórias externas e privadas (diretório 700/arquivos 600), sem substituir arquivos existentes. O diretório de código pode ser substituído/reclonado **sem perder esses segredos**. Preserve também uma cópia da configuração `.env` fora do checkout (ou indique esse arquivo externo por `LP_ENV_FILE`) e mantenha o mesmo nome Compose/volumes ao trocar código. `up` valida a configuração, compila localmente a API e espera PostgreSQL/Keycloak/API ficarem saudáveis. Caddy obtém e renova certificados públicos automaticamente. A primeira emissão pode levar alguns instantes: repita `status` se necessário.
6. Crie sua conta:

   ```sh
   ./lpctl user create seuusuario
   ```

   Digite e confirme uma senha com pelo menos 12 caracteres. A senha não aparece na tela nem nos argumentos do processo. Cadastro público permanece fechado. Não edite JSON de realm, SQL, URLs de callback ou IDs de clients. A conta administrativa é interna; o aplicativo usa a conta que você acabou de criar.
7. Abra o **LionPocket normal** no primeiro aparelho: **Configurações (Preferências no Android) → Sincronização → Configurar sincronização**. Informe `https://sync.meudominio.com` e toque **Conectar**. O aplicativo descobre e valida o servidor, abre o login OIDC e cria o cofre, com backup local e primeiro sync automáticos.
8. A sincronização já funciona. O alerta **Proteja seu cofre** lembra de guardar e confirmar o código **e o pacote de recuperação** fora do aplicativo, por exemplo em um gerenciador de senhas. Faça isso para poder recuperar os dados caso perca todos os aparelhos; a confirmação não bloqueia o pareamento normal.
9. No aparelho que criou o cofre, abra **Adicionar aparelho**. **Desktop → Mobile:** escaneie o QR no celular. **Mobile → Desktop:** compartilhe/copie o link no celular e abra no computador com LionPocket instalado. O deep link abre diretamente a confirmação; confira o domínio e toque **Conectar**. Se o link não abrir, use **Copiar convite / Colar convite**. Confira o mesmo código curto nos dois aparelhos e toque **Aprovar aparelho** no autorizado. Chave e primeiro sync chegam automaticamente; o novo aparelho não precisa de OIDC, câmera no Desktop ou digitação de códigos.

O convite LPV2 expira em 15 minutos, só aceita um aparelho e pode ser cancelado. Ele permite somente solicitar entrada; aprovação, grant e chave selada continuam obrigatórios. Servidor e aplicativos precisam do contrato atual. A instalação cria diretamente o schema atual; não migra servidores anteriores. Consulte o [pareamento](device-pairing-lpv2.md) e a [recuperação independente](recovery.md).

“Sincronizado” exige ciclo concluído, nenhuma pendência, quarentena ou revisão bloqueante. “Offline”, “Alterações pendentes” ou “É necessário entrar novamente” não impedem uso local. A sincronização automática acontece com o aplicativo aberto/ativo; Android não executa sync em background.

## Configuração e serviços

`deploy/self-hosted` é a distribuição oficial; `tools/self-hosted` contém apenas fixtures de teste. Os serviços são API, PostgreSQL (bancos/roles separados para sync e IdP), Keycloak/OIDC e reverse proxy. A API é a mesma aplicação reutilizável por um futuro Cloud; não existe motor financeiro reduzido ou modo plaintext self-hosted.

| Variável | Significado |
| --- | --- |
| `SYNC_HOST`, `AUTH_HOST` | Nomes DNS HTTPS distintos, sem caminhos/portas |
| `COMPOSE_PROJECT_NAME` | Nome estável e único do projeto Docker; identifica volumes |
| `REVERSE_PROXY` | `caddy` ou `existing` |
| `POSTGRES_PASSWORD_FILE` | Arquivo externo de senha administrativa PostgreSQL |
| `SYNC_DB_PASSWORD_FILE` | Arquivo externo da role `sync_api` |
| `AUTH_DB_PASSWORD_FILE` | Arquivo externo da role `keycloak` |
| `KEYCLOAK_ADMIN_PASSWORD_FILE` | Arquivo externo do administrador interno |
| `HOMELAB_CA_FILE` | Opcional: raiz pública PEM de CA privada explicitamente confiável, para API/operação |
| `LP_UID` | Opcional: UID proprietário dos segredos; `lpctl` usa `id -u` automaticamente |

Os serviços sem privilégios usam o UID do operador para ler arquivos privados montados por Compose. Para usar Compose diretamente, substitua `~` por caminhos absolutos externos no `.env`, defina `LP_UID` com o valor de `id -u` e execute `docker compose --profile https up -d --build --wait --wait-timeout 300`. A validação de `lpctl` deve ser executada antes; `.gitignore` não é a proteção contra perder segredos ao substituir o checkout. O PostgreSQL lê seus arquivos como root antes de baixar privilégios. Não coloque senhas em `.env`, linha de comando ou no Git. Senhas dos bancos são definidas na primeira inicialização; mudar um arquivo depois não é rotação automática de credenciais.

O realm `lionpocket` e os public clients são importados automaticamente; não contêm URLs do homelab. O hostname configurado determina o issuer. Desktop usa callback loopback `http://127.0.0.1:18761/callback`; Android normal usa `com.lionpocketmobile:/callback`. Authorization Code, PKCE S256, state/nonce, issuer/audience e assinatura JWT são validados. Não há client secret no aplicativo. Não altere `applicationId` ou a assinatura Android para instalar um servidor.

## Usar reverse proxy existente

Configure `REVERSE_PROXY=existing` antes de `./lpctl up`. A ferramenta carrega `compose.proxy.yml`: API em `127.0.0.1:18789` e Keycloak em `127.0.0.1:18089`, somente no host. Seu Nginx/Traefik/Caddy termina HTTPS para ambos os nomes e encaminha para essas portas. Se o proxy estiver em outro container, conecte-o explicitamente à rede Compose e use `api:8787`/`keycloak:8080`, sem expor essas portas remotamente.

Exemplo Caddy **já instalado no host**, com seus nomes reais:

```caddyfile
sync.meudominio.com {
    reverse_proxy 127.0.0.1:18789
}
auth.meudominio.com {
    @public path /realms/lionpocket/* /resources/* /robots.txt
    handle @public {
        reverse_proxy 127.0.0.1:18089
    }
    handle {
        respond 404
    }
}
```

O proxy deve substituir `X-Forwarded-Proto`/`Host`/`Port` pelos valores HTTPS confiáveis. Bloqueie `/admin`, `/realms/master` e health/management na interface pública. Não habilite access logs de corpos ou cabeçalhos Authorization/proof. Logs de caminhos de login com query string também podem expor códigos; redija-os ou não os registre. Cloudflare não é necessário.

CA privada com proxy próprio: use `REVERSE_PROXY=existing`, configure certificados válidos no seu proxy e informe `HOMELAB_CA_FILE=/caminho/absoluto/raiz-publica.pem` no `.env`. `lpctl` carrega `compose.ca.yml` e confia explicitamente nessa raiz na API/ferramenta; esse arquivo não pode conter chave privada. Para Compose direto, adicione `-f compose.yml -f compose.proxy.yml -f compose.ca.yml`. Instale a raiz confiável em **todos** os dispositivos e no ambiente que executa `lpctl status`; use certificados para os nomes DNS corretos. Android confia nas CAs do sistema e nas CAs instaladas explicitamente pelo usuário nas configurações de segurança do dispositivo. Instale apenas a raiz da sua CA confiável; certificados autoassinados não confiáveis continuam recusados. O LionPocket recusa certificado inválido, não possui opção “ignorar certificado”, fallback HTTP remoto ou bypass TLS. HTTP loopback permanece limitado aos harnesses sintéticos de desenvolvimento existentes.

## Operação e usuários

```sh
./lpctl status
./lpctl user create outro_usuario
./lpctl user disable outro_usuario
./lpctl restart
./lpctl logs
```

Desabilitar usuário bloqueia imediatamente a API (inclusive JWT previamente emitido), desabilita a conta no IdP e encerra sessões. Não apaga cofres ou ciphertext. Repetir é seguro. Em automação controlada, `user create nome` aceita a senha por stdin; nunca a forneça como argumento ou a grave em scripts/repositório. Não existe registro público opt-in neste PR.

## Backup completo e ensaio

Escolha um caminho privado **fora do Git**, em disco persistente:

```sh
./lpctl backup /srv/backups/lionpocket/2026-10-01
./lpctl verify-backup /srv/backups/lionpocket/2026-10-01
```

Backup interrompe brevemente API e Keycloak para obter um snapshot consistente dos dois bancos e retoma somente os serviços que estavam rodando. Inclui identidade/epoch, owners/memberships, dispositivos/pedidos/grants, envelopes/checkpoints/recovery cifrado, commits/log/receipts/cursors/nonces, revogações de conta e banco completo do IdP (usuários, senhas **hasheadas**, configurações e chaves de assinatura). Inclui também a raiz pública configurada em `HOMELAB_CA_FILE`, `.env` e arquivos de segredos externos para reconstruir a operação. Portanto **o backup é sensível mesmo que as finanças sejam ciphertext**: proteja permissões, cifre seu armazenamento de backup e mantenha cópia fora da máquina. Não contém DEKs ou recovery em claro de clientes.

O manifesto v5 registra checksums, serverId/epoch, contagens e compromissos paginados do ledger, gerações/archives, staging, transitions e activations. A verificação criptográfica em bancos temporários confere geração selecionada, cadeia de transitions, ciphertext promovido, receipts, grafo, registry, Recovery e key state; também admite commits normais posteriores à baseline. **`verify-backup` nunca modifica a instalação ativa:** não escreve `.env`, arquivos de segredo/CA, configuração ou bancos ativos, não muda serverId/serverEpoch e não para, reinicia ou recria serviços/volumes ativos. Checksums são conferidos antes de criar recursos temporários. Verificação restaura ambos os dumps exclusivamente em bancos temporários isolados, confere identidade/contagens/realm, ensaia mudança de epoch somente nesses bancos e os remove inclusive em caso de erro. Uma senha administrativa diferente no backup não substitui a atual. A ferramenta falha explicitamente se a remoção dos bancos temporários não puder ser concluída.

Certificados públicos podem ser reemitidos pelo proxy; para uma CA privada preserve separadamente a configuração e as chaves da CA. Nenhum certificado privado é versionado. O SQLite/backups e segredo de recovery dos clientes também precisam de proteção própria.

## Restore operacional e `serverEpoch`

Em uma instalação com os **mesmos hosts**, copie também `trust-ca.pem` do backup para o caminho externo `HOMELAB_CA_FILE` se usa CA privada. Primeiro suba a infraestrutura, guarde um backup do estado atual e ensaie o backup que deseja restaurar:

```sh
./lpctl verify-backup /srv/backups/lionpocket/2026-10-01
./lpctl restore /srv/backups/lionpocket/2026-10-01 --confirm-new-epoch
./lpctl status
```

**`restore` é uma ação destrutiva explícita**, autorizada apenas por `--confirm-new-epoch`, que substitui **ambos os bancos**. Mantém serverId, restaura o segredo administrativo correspondente ao IdP do backup e gera **um novo serverEpoch obrigatoriamente**, mesmo se o operador acredita que o snapshot é completo. As senhas das roles de banco permanecem as da instalação corrente. A troca do arquivo administrativo é atômica; os writers são recriados para atualizar os mounts e a autenticação administrativa é conferida antes de declarar sucesso. Não apresenta log truncado como o histórico anterior.

Se a restauração dos bancos, a escrita do segredo, a inicialização ou a autenticação falhar, a ferramenta mantém API/IdP parados e informa que o estado pode estar parcialmente restaurado. Não execute `up`/`restart` para contornar essa falha: corrija a causa e repita o restore confirmado com o backup válido e o segredo correspondente. Se Docker não permitir confirmar a parada, a mensagem exige parada manual imediata. Não apague o backup ou o SQLite dos aparelhos. Essa operação é diferente de `verify-backup`, que nunca troca o segredo ativo.

`restore` registra cada restauração e os cofres pendentes de forma durável, sem migrá-los. Preserva os registros anteriores inclusive quando o backup é mais antigo, usando um journal externo junto do arquivo do segredo administrativo antes de substituir o banco. Preserve esse journal durante reparação de um restore interrompido. `status` mostra cofres ainda aguardando recuperação, autorizações aguardando baseline e cofres recuperados no epoch atual. O operador não pode forçar a autorização criptográfica.

Depois do restore, os aparelhos detectam o servidor restaurado, pausam o transporte e preservam SQLite/outbox. No aparelho proprietário que possui o histórico completo, escolha **Preparar recuperação**. A preparação conserva um backup consistente, archive e plano causal; ainda não troca a base selecionada no servidor. Quando aparecer **Pronto para ativar**, revise os dados e escolha **Ativar sincronização recuperada**. Essa ação explícita promove atomicamente os envelopes preparados, instala a nova identidade de sincronização neste aparelho e executa o primeiro pull normal. Login sozinho e o operador `lpctl` não ativam um cofre.

Depois dessa confirmação não há retorno automático ao histórico anterior. Um restart ou resposta perdida retoma a mesma activation durável; se faltar autenticação ou algum artifact, aparece **Continuar finalização** / **Ação necessária**, com sync pausado. Os dados continuam locais. Não edite pins, recrie profiles, apague secrets ou tente reativar a geração arquivada. Se editar o banco antigo depois da preparação, a validação rejeita a instalação divergente em vez de descartar essas alterações.

**O segundo aparelho ainda precisa ser reconectado após a recuperação do servidor.** Este fluxo somente recupera o aparelho âncora. Outros aparelhos conservam seus dados e outbox e recebem `epoch_changed`; suas alterações offline não são migradas neste incremento. Recovery com perda de todos os aparelhos usa pacote e código próprios; reconexão de outro aparelho após restore operacional, Cloud público e background sync Android permanecem fluxos separados. Veja [contrato de activation e evidências](self-hosted-anchor-activation-validation.md) e [modelo da recuperação](self-hosted-epoch-recovery.md).

## Atualizações, domínio e diagnóstico

Antes de atualizar, faça e verifique backup. Leia as notas da versão aprovada, obtenha esse commit/tag no repositório e execute `./lpctl up`. A imagem é recompilada localmente; este PR não publica imagem ou release nem oferece `lpctl update` que baixa código sem revisão. Mantenha o nome Compose, hosts, volumes e arquivos externos. Realm importado não substitui realms existentes; alterações futuras precisam de migração explícita. Não faça `down --volumes` em produção.

Endpoint é preferência por aparelho e não sincroniza. Uma base vinculada não troca operador editando URL, nem envia outbox a servidor B automaticamente. Para abandonar um remoto e publicar os dados locais em uma instalação limpa, use exclusivamente o fluxo explícito de servidor recriado abaixo. Ele não recupera o remoto anterior nem move automaticamente ciphertext entre servidores.

- `status` não passa: confira DNS, portas, cadeia TLS, permissões/UID dos arquivos e saúde dos serviços. Use `lpctl logs`; não publique dumps, tokens, proofs ou recuperação em chamados.
- Login: conta criada no seu servidor, callback loopback desktop livre, navegador padrão disponível; Android normal e beta têm redirects/pacotes isolados. Criação inicial e recuperação exigem login; aparelhos aprovados no novo fluxo sincronizam por grant/prova sem repetir OIDC. Salvamentos permanecem locais.
- Servidor indisponível: use localmente e mantenha a outbox. Não remova SQLite, credenciais locais ou binding para “consertar rede”.
- Estado de revisão/quarentena/conflito: examine as ações do aplicativo antes de liberar envio. Não há resolução financeira automática no servidor.
- Cofre do sistema bloqueado/indisponível: o aplicativo continua local; sync exige o armazenamento seguro da plataforma. Nunca há fallback de chaves privadas em arquivo claro.

## Contrato, beta e evidência

`protocolVersion=1`, `domainSchema=1`, `lp-sodium-v1`, E2EE, assinatura de commit/HTTP proof, DAG, causalidade, tombstones, idempotência e checkpoints são preservados. `/v1/environment` continua disponível; `/.well-known/lionpocket` é um alias aditivo. Escopo completo genérico cobre categorias, formas de pagamento, cartões, lançamentos, recorrências, parcelas, objetivos e prioridades recorrentes/mensais. Servidor só valida protocolo/autorização e conserva ciphertext.

O controle atual exige **controlVersion 2**. Discovery ou requisições incompatíveis são bloqueados antes de modificar dados. O protocolo financeiro e suas migrations locais continuam preservados. O schema inicial self-hosted é atual; uma instalação anterior não é migrada.

O canal privado em `tools/sync-beta` usa a mesma API e motor, com hostname/realm/client/redirect e perfil/pacote próprios. Os contextos criptográficos que contêm `beta` permanecem byte a byte iguais; são separação de domínio de assinaturas atuais, sem outro caminho de pairing ou transporte.

Ensaio automatizado, somente fixtures:

```sh
npm ci
npm run sync:self-hosted:validate
npm run sync:self-hosted:test
```

Sobe projeto descartável, TLS com CA de teste **explicitamente confiável**, contas pela ferramenta, login Authorization Code/PKCE, controladores normais sem `privateBeta=true`, SQLite real desktop/mobile, recovery, pareamento, sync bidirecional, restart, falhas, canários, backup/restore e epoch. O harness é evidência de contrato e adapters; não equivale a uma sessão visual real de Custom Tab/Android. As suítes existentes cobrem issuer/audience, replay, assinatura/ciphertext alterado e revogação. Essa implantação limpa também integra o [pipeline local obrigatório](local-validation.md), sem GitHub Actions. Isso **não substitui auditoria criptográfica independente**.

## Servidor recriado e base local como fonte de verdade

Esta atualização exige uma instalação self-hosted nova. Clientes anteriores não são suportados. O reset será feito pelo operador depois do merge; o aplicativo nunca destrói automaticamente o servidor ou o banco financeiro local.

1. Escolha **um** aparelho cuja base financeira local será a fonte de verdade. Confira lançamentos, catálogos, recorrências, parcelas, metas e prioridades. Resolva conflitos/revisões pendentes antes de desvincular.
2. Faça um backup/exportação da base local e preserve também os arquivos privados de chaves para restauração da instalação local, conforme o procedimento de backup do aplicativo. Guarde uma cópia fora do aparelho. Não desinstale o app apagando seus dados.
3. Desligue a instalação self-hosted anterior. Preserve um backup operacional se desejar arquivá-la. Recrie os serviços em um **novo projeto Compose/volumes vazios**, usando a instalação limpa documentada acima. Não execute migração nem restaure o banco anterior no novo servidor. Configure DNS/HTTPS/OIDC e crie sua conta.
4. Atualize Desktop e Android mantendo o mesmo banco local e a mesma assinatura/applicationId. O aplicativo continua funcionando localmente enquanto o servidor estiver indisponível.
5. No aparelho escolhido, abra **Sincronização → Servidor de sincronização recriado** (no Android, em detalhes avançados). Informe o endpoint novo, confirme que o remoto anterior não será recuperado e que os dados deste aparelho são a fonte de verdade. **Preservar backup e preparar novo sync** cria outra cópia SQLite completa antes de remover qualquer vínculo.
6. O app limpa o vínculo, grants e histórico de transporte; conserva todas as linhas, identidades financeiras locais, aliases, slots de agenda e proveniência de importação, e mostra o caminho do backup. **Criar novo sync com meus dados locais** autentica a conta, cria o novo cofre e publica um baseline dos dados existentes. Não exige editar SQLite. Uma interrupção após o backup retoma a desvinculação autorizada no startup.
7. Nos demais aparelhos, preserve suas bases/backup antes de substituir o vínculo. Revise se contêm alterações que precisam entrar na fonte de verdade. Use o mesmo fluxo explícito para remover o vínculo antigo, **sem criar outro cofre**; em seguida conecte pelo LPV2 gerado no fundador. QR é recomendado de Desktop para celular; link/deep link de celular para Desktop. Dados idênticos conservados localmente passam pela adoção/deduplicação normal do primeiro sync.
8. Confira o primeiro sync e o novo pacote/código de recuperação. Mantenha os backups anteriores até verificar os dados em todos os aparelhos.

A desvinculação é bloqueada enquanto houver revisão/conflito local não resolvido ou ativação de recovery incompleta. Falha no backup não remove vínculo nem dados. A cópia anterior contém as filas e o vínculo anteriores; o rebaseline usa identidades e contadores novos, com recibos de importação preservados para evitar duplicação.
