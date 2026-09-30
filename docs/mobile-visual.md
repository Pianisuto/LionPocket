# Identidade visual do mobile

> Estado atualizado: [paridade funcional local](mobile-functional-parity.md). O novo bloco completa os fluxos restantes, adiciona preferências e migração v5 com suporte a valores zero.


O Android agora segue o sistema **Juba** do desktop, com layout próprio para celular. As regras financeiras e o banco local continuam iguais.

## Identidade

- Fundo ameixa `#140d13`, superfícies `#1d1420` e `#271a29`, rosa principal `#ff4d9d` e destaque `#ff8fc2`.
- Entradas verdes `#56d7ab`, saídas coral `#ff8a6b`, alertas `#ff5d7e`. Os tokens estão em `apps/mobile/src/ui/theme.ts`, alinhados ao tema escuro de `apps/desktop/src/index.css`.
- Marca, ícone adaptativo do launcher e splash com o leão existente do desktop; Inter na interface e Bricolage Grotesque nos títulos. Fontes, imagens e ícones ficam no APK e funcionam offline.
- Os ícones Lucide são gerados a partir da dependência já usada no desktop, sem adicionar módulos nativos. As licenças das fontes e dos ícones estão em `apps/mobile/src/ui/assets`.
- Os scripts `apps/mobile/scripts/generate-ui-icons.cjs` e `generate-ui-fonts.py` reproduzem os assets. Execute da raiz; o script Python precisa de `fonttools` e `brotli`.

## Organização

- Navegação inferior: Mês, Planejar, Ano e Mais. Planejar reúne recorrências, parcelamentos e objetivos; Mais reúne cadastros e dados locais.
- Tela mensal com saldo realizado em destaque, projeção, entradas e saídas em cartões separados e navegação compacta entre meses.
- Lançamentos mostram descrição, valor, categoria, data, situação e indicação de prioridade. Toque no lançamento para abrir detalhes, conclusão, edição, seleção, prioridade, ordenação de prioridades e exclusão.
- Filtros e ordenação abrem em painel inferior. O botão de voltar aos resultados permanece visível; a seleção de pendentes fica no mesmo painel, com conclusão em lote na lista.
- Painel anual com resumo, gráfico das entradas e saídas previstas e meses expansíveis com categorias. Barras sem valor têm altura zero.
- Formulários com cabeçalhos consistentes; os editores de lançamento e planejamento mantêm Salvar fixo. Tipo e situação do lançamento usam escolhas diretas; o valor planejado tem destaque.
- Seletores abrem painéis inferiores, com opção selecionada indicada por cor e marca. Controles comuns têm área de toque mínima de 48 dp, rótulos de acessibilidade e estados de seleção.

## Verificação

- Testes do monorepo: 166 passaram (55 core, 53 desktop, 58 mobile).
- Typecheck, lint e builds Android debug e release passaram.
- Conferência visual no emulador API 36, em modo avião, usando o APK release: mês, filtros combinados e busca, detalhes/prioridades, edição, planejamento, cadastros, dados locais e painel anual.
- Conferência adicional a 360 dp de largura e fonte em 130%, incluindo formulários e filtros. Configurações do emulador restauradas ao terminar.
- Comparação das dez tabelas antes/depois da navegação: dados locais preservados.

O desktop não foi alterado. Não há nova migration nem mudança nos formatos de importação/exportação nesta revisão visual.
