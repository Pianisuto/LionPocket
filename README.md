<p align="center">
  <img src="assets/icon.png" alt="Ícone do LionPocket" width="112" height="112">
</p>

<h1 align="center">LionPocket</h1>

<p align="center">
  Finanças pessoais simples, locais e bonitas.
</p>

<p align="center">
  <a href="https://github.com/Pianisuto/LionPocket/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Pianisuto/LionPocket?display_name=tag&sort=semver"></a>
  <a href="LICENSE"><img alt="Licença MIT" src="https://img.shields.io/badge/licen%C3%A7a-MIT-f05a9d"></a>
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

- **Windows:** use `LionPocket-Instalador.exe` ou a versão portátil em ZIP;
- **Linux (Debian/Ubuntu):** use o pacote `.deb`;
- **Linux portátil:** extraia o ZIP e execute `lionpocket`.

> O projeto ainda não possui assinatura de código. Por isso, Windows ou Linux podem pedir uma confirmação extra antes da primeira execução.

## Privacidade

O LionPocket não envia seus dados financeiros para servidores externos. O banco e os backups permanecem no seu computador. Ainda assim, mantenha cópias de segurança periódicas, especialmente antes de atualizar ou trocar de máquina.

## Desenvolvimento

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
# Instalador .deb e aplicativo Linux
npm run make:linux

# Artefatos suportados pelo sistema atual
npm run make
```

O instalador do Windows é criado em um runner Windows pelo workflow [`build-windows.yml`](.github/workflows/build-windows.yml). Os artefatos gerados localmente ficam em `out/` e não fazem parte do repositório.

## Tecnologias

- Electron e Electron Forge;
- React e TypeScript;
- SQLite;
- Vite e Vitest.

## Inspiração visual

A interface foi inspirada na clareza, velocidade e linguagem visual do [t3.chat](https://t3.chat/), adaptadas para uma experiência local de finanças pessoais. LionPocket é um projeto independente e não possui afiliação, patrocínio ou endosso do t3.chat ou de seus criadores.

## Licença

Distribuído sob a [licença MIT](LICENSE). Copyright © 2026 Leonardo Vulczak.
