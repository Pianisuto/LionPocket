<p align="center">
  <img src="apps/desktop/assets/icon.png" alt="Ícone do LionPocket" width="112" height="112">
</p>

<h1 align="center">LionPocket</h1>

<p align="center">
  Finanças pessoais simples, locais e bonitas.
</p>

<p align="center">
  <a href="https://github.com/Pianisuto/LionPocket/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Pianisuto/LionPocket?display_name=tag&sort=semver"></a>
  <a href="LICENSE"><img alt="Licença AGPLv3" src="https://img.shields.io/badge/licen%C3%A7a-AGPLv3-f05a9d"></a>
  <img alt="Linux e Windows" src="https://img.shields.io/badge/plataformas-Linux%20%7C%20Windows-6f5af0">
  <img alt="Dados locais" src="https://img.shields.io/badge/dados-100%25%20locais-35b779">
</p>

O **LionPocket** é um aplicativo desktop de finanças pessoais para Linux e Windows. Ele funciona sem conta, sem assinatura e sem depender de internet: seus lançamentos ficam em um banco SQLite no próprio computador.

## Recursos

- painel mensal com resumo anual, saldo projetado e saldo realizado;
- entradas e saídas planejadas, pagas ou recebidas;
- preenchimento automático para lançamentos de meses anteriores;
- sincronização entre valor planejado e valor real durante o backfill;
- sugestões baseadas em lançamentos anteriores;
- conclusão em lote de pendências de meses encerrados;
- despesas fixas geradas automaticamente a cada mês;
- recorrências no cartão calculadas pelo dia mensal da cobrança e pelo fechamento da fatura;
- acompanhamento de compras parceladas e objetivos financeiros;
- categorias, formas de pagamento e cartões personalizáveis;
- ciclo do cartão com fechamento e vencimento, calculando a fatura pela data da compra;
- importação de planilha e exportação em CSV ou JSON;
- cópia de segurança local do banco de dados.

## Instalação

Baixe a versão mais recente na página de [Releases](https://github.com/Pianisuto/LionPocket/releases):

- **Windows:** use `LionPocket-Instalador.exe` para receber atualizações automáticas; o ZIP é portátil e deve ser atualizado manualmente;
- **Linux (Debian/Ubuntu):** use o pacote `.deb`;
- **Linux portátil:** extraia o ZIP e execute `lionpocket`.

> O projeto ainda não possui assinatura de código. Por isso, Windows ou Linux podem pedir uma confirmação extra antes da primeira execução.

As atualizações automáticas do Windows usam o serviço público e gratuito `update.electronjs.org`. O aplicativo verifica novas versões em segundo plano, baixa a atualização e pede para reiniciar quando ela estiver pronta. O Linux continua sendo atualizado pelo pacote `.deb` ou pela versão portátil.

## Privacidade

O LionPocket não envia seus dados financeiros para servidores externos. O banco e os backups permanecem no seu computador. Ainda assim, mantenha cópias de segurança periódicas, especialmente antes de atualizar ou trocar de máquina.

## Desenvolvimento

O repositório usa npm workspaces. A aplicação Electron está em `apps/desktop` e o domínio compartilhável em `packages/core`; a raiz contém o lockfile único e os comandos de desenvolvimento. O core reúne tipos de domínio, datas e cálculos financeiros, regras de cartão, competência mensal e prioridades de lançamentos. Sua API pública é exposta por `@lionpocket/core` e pelos subcaminhos `/types`, `/finance`, `/credit-cards` e `/transactions`.

Os contratos de janela, atualização, IPC e importação de planilhas, assim como o SQLite e a interface, permanecem em `apps/desktop`. Os comandos da raiz compilam o core antes de iniciar, testar ou empacotar o desktop; `npm run build:core` também permite compilá-lo separadamente.

### Android

O app bare React Native está em `apps/mobile`. Ele salva lançamentos em `lionpocket.sqlite` dentro do armazenamento privado do Android. O schema e as migrations versionadas estão em `apps/mobile/src/db`; essa persistência é separada do SQLite do Electron. O painel mensal apresenta entradas e saídas planejadas e realizadas, saldo projetado e saldo realizado. É possível criar, editar, excluir com confirmação e pagar/receber lançamentos; filtrar por tipo e situação; associar e gerenciar categorias, formas de pagamento e cartões. O planejamento inclui recorrências de entradas e saídas (únicas, semanais, mensais, personalizadas e por meses escolhidos), compras parceladas com correção da série e progresso, objetivos financeiros e conclusão de lançamentos/faturas em lote. O mobile usa `@lionpocket/core` para validações, competência mensal, cálculos em centavos, ciclo do cartão, geração de recorrências, correção de parcelas e progresso de objetivos. Continua funcionando offline, sem conta ou servidor.

Pré-requisitos: Node.js 22.13+ (Node 24 também funciona), JDK 21 completo (com javac) e Android Studio com SDK Platform 37, Build Tools 37.0.0, NDK 27.1.12297006 e um emulador ou aparelho com depuração USB. Configure `ANDROID_HOME` para o diretório do SDK. O projeto Android usa Gradle Wrapper; não é necessário instalar Gradle globalmente.

```bash
npm ci
npm run mobile:start         # terminal 1: Metro
npm run mobile:android       # terminal 2: compila, instala e abre no aparelho

# APK de desenvolvimento sem precisar de aparelho
npm run mobile:build:android
# APK descartável de desenvolvimento com JS embutido, sem Metro:
apps/mobile/android/gradlew -p apps/mobile/android assembleRelease -PdevelopmentSigning=true
# Futura release normal: exige assinatura externa configurada:
npm run mobile:build:android:release

# Verificações do workspace mobile
npm run build:core
npm run typecheck --workspace @lionpocket/mobile
npm run lint --workspace @lionpocket/mobile
npm run test --workspace @lionpocket/mobile
```

O APK release inclui o JavaScript e fica em `apps/mobile/android/app/build/outputs/apk/release/`. A build normal release exige assinatura externa com pin do certificado. A opção explícita `-PdevelopmentSigning=true` e a beta privada usam a chave pública de desenvolvimento para ensaios. As instalações antigas não podem simplesmente trocar para outra assinatura; consulte a [auditoria e o procedimento de release readiness](docs/local-first-sync-release-readiness.md). O APK de debug fica em `apps/mobile/android/app/build/outputs/apk/debug/`. Após alterar `packages/core`, rode `npm run build:core` e recarregue o Metro. O Metro observa a raiz do monorepo para encontrar o workspace e as dependências instaladas pelo npm na raiz. O módulo nativo `react-native-nitro-sqlite` é conectado automaticamente pelo React Native CLI; mudanças em dependências nativas exigem novo build Android.

As migrations são aditivas e transacionais: a versão 2 acrescenta cadastros e vínculos opcionais; a versão 3 acrescenta planejamento e identidade de ocorrências sem recriar a tabela de lançamentos. Os registros da base anterior permanecem disponíveis. Exclusões são lógicas; consultas e totais ignoram registros excluídos. Os testes mobile usam o SQLite nativo do Node (`node:sqlite`), inclusive para atualizar um banco da versão 1 e verificar rollback. Use Node 22.13+ ou 24 para essas verificações.

Consulte [o roteiro de uso diário](docs/mobile-daily-finance.md) e [as regras e a validação do planejamento](docs/mobile-planning.md). O botão **Hoje** retorna ao mês atual; deslizar a lista para baixo atualiza os dados locais. Datas são preenchidas no formato `AAAA-MM-DD` e valores aceitam vírgula ou ponto decimal (ex.: `125,50`).

A [proposta de sincronização local-first](docs/local-first-sync-proposal.md) registra o desenho para desktop/mobile, self-hosted e Lion Pocket Cloud. A [Etapa 0](docs/local-first-sync-stage0.md), a fundação local e o provisioning evoluíram para o [fluxo manual desktop ↔ Android da Etapa 1](docs/local-first-sync-stage1-transport.md), restrito a bancos sintéticos e opt-in de desenvolvimento. A sincronização continua desativada por padrão.

Requisitos:

- Node.js 24 ou mais recente;
- npm;
- dependências nativas de compilação exigidas pelo Electron no sistema utilizado.

```bash
git clone https://github.com/Pianisuto/LionPocket.git
cd LionPocket
npm ci
npm start
```

Verificações do projeto:

```bash
npm test
npm run typecheck
npm run lint
```

Empacotamento:

```bash
# Instalador .deb e ZIP portátil Linux
npm run make:linux

# Artefatos suportados pelo sistema atual
npm run make
```

Os artefatos gerados localmente ficam em `apps/desktop/out/` e não fazem parte do repositório. O workflow [`release.yml`](.github/workflows/release.yml) compila as versões para Windows e Linux.

### Candidatos de release

O workflow [`release.yml`](.github/workflows/release.yml) verifica PR/main/tag ou execução manual: testes, tipos, lint, integração PostgreSQL/Keycloak, Linux/Windows normal e beta, Android e atualização de fixtures. Gera checksums SHA-256 e confere versão/tag. **Não publica GitHub Release, não envia binários para artefatos públicos e não adota uma chave permanente.**

A versão de distribuição e o versionCode Android estão em `tools/release/version.json`; a versão desktop e o lockfile devem coincidir. Antes de uma próxima versão, incrementar também o versionCode além de qualquer instalação suportada, rodar `npm run release:validate` e seguir o [guia de release readiness](docs/local-first-sync-release-readiness.md). A escolha da assinatura definitiva e a publicação exigem uma decisão posterior.

Squirrel continua gerando `RELEASES` e `.nupkg` para o atualizador Windows normal. A beta tem identidade própria e não usa esse feed. As releases históricas já publicadas e o comportamento de atualização normal permanecem; este pipeline prepara candidatos para revisão.

## Tecnologias

- Electron e Electron Forge;
- React e TypeScript;
- SQLite;
- Vite e Vitest.

## Inspiração visual

A interface foi inspirada na clareza, velocidade e linguagem visual do [t3.chat](https://t3.chat/), adaptadas para uma experiência local de finanças pessoais. LionPocket é um projeto independente e não possui afiliação, patrocínio ou endosso do t3.chat ou de seus criadores.

## Licença

Distribuído sob a [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Copyright © 2026 Leonardo Vulczak.


O ambiente com Keycloak/PostgreSQL e pareamento está no [guia de provisioning](docs/local-first-sync-stage1-provisioning.md). O [guia de transporte manual](docs/local-first-sync-stage1-transport.md) descreve envio cifrado idempotente, inbox/outbox duráveis, conflitos, backups e reprodução nativa. Somente `manualTransaction` pode ser anunciado no opt-in sintético; dados pessoais e demais entidades permanecem fora do piloto.

### Sincronização opcional em servidor próprio

O LionPocket normal continua local-first e oferece sincronização E2EE por uma única URL HTTPS em Configurações → Sincronização. Veja o [guia de instalação e operação self-hosted](docs/self-hosting.md).
