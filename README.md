# LionPocket

Aplicativo desktop de finanças pessoais para Linux e Windows. Funciona sem internet e mantém os dados em um banco SQLite no próprio computador.

## O que já está incluído

- painel mensal e visão anual;
- entradas e saídas planejadas ou realizadas;
- despesas fixas criadas automaticamente por mês;
- compras parceladas;
- objetivos de compra e reserva;
- categorias, formas de pagamento e cartões personalizáveis;
- importação da planilha de planejamento financeiro;
- cópia de segurança e exportação em CSV ou JSON.

## Desenvolvimento

Requer Node.js 24 ou mais recente.

```bash
npm install
npm start
```

Verificações:

```bash
npm run typecheck
npm test
npm run make
```

No Linux, `npm run make:linux` gera um instalador `.deb`. Abra esse arquivo com dois cliques, instale e procure por **LionPocket** no menu de aplicativos.

O comando `npm run make` também gera a versão portátil em ZIP. No Windows, ele gera o instalador e uma versão portátil. O instalador do Windows deve ser criado e testado no próprio Windows.

Os dados usados durante o desenvolvimento ficam na pasta de dados do Electron e não fazem parte do repositório.
