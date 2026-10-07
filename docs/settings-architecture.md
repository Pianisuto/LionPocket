# Configurações

Desktop e Mobile usam as mesmas quatro áreas: Geral, Cadastros, Dados e backup
e Sincronização. A apresentação pertence a cada plataforma; operações financeiras,
persistência e comandos de sincronização continuam nos serviços existentes.

## Páginas e navegação

- Desktop: `apps/desktop/src/ui/settings/SettingsScreen.tsx` monta a navegação
  lateral a partir de `sections.tsx`. Para adicionar uma área, crie a página e
  registre título, descrição, ícone e renderização nesse arquivo. O App guarda
  a área selecionada, enquanto preferências e catálogos usam os callbacks existentes.
  A navegação ocupa uma faixa lateral integrada e o conteúdo tem rolagem própria;
  trocar de área começa no topo. Em janelas compactas, as áreas ficam numa faixa
  horizontal. A largura do conteúdo é fluida. Container queries usam o espaço
  disponível na página para organizar Geral, Dados e Cadastros em colunas.
  Cadastros mantém categorias à esquerda e pagamentos/cartões à direita quando
  há espaço; listas e formulários de cartões se adaptam à própria coluna.
- Mobile: `apps/mobile/src/ui/settings/SettingsScreen.tsx` abre uma lista de áreas
  e navega para páginas dentro da mesma tela modal. Voltar retorna à lista; fechar
  encerra Configurações. Cadastros usam um editor próprio por registro. O fluxo
  de convite recebido por deep link continua separado e abre diretamente o pareamento.
- `SettingsKit.tsx` contém os elementos de apresentação de cada plataforma.
  Cadastros separam entradas e saídas e mostram fechamento e vencimento dos cartões.
  Edição e exclusão seguem as capacidades das APIs de cada plataforma.

## Sincronização

Cada pasta `settings/sync` compõe visão geral, configuração, pareamento, aparelhos,
proteção, recuperação do servidor, servidor recriado e revisões. `SyncPanel` decide
quais responsabilidades aparecem em cada estado; os componentes executam comandos
pela sessão, sem manter cópias independentes de status, erro ou busy.

`useSyncSession` centraliza assinatura, atualização e execução de operações em cada
plataforma. Bloqueia operações simultâneas, descarta respostas antigas e remove a
assinatura ao sair. `packages/sync-local/src/sync-presentation.ts` compartilha apenas
derivações de estado e textos; nenhum layout ou regra de negócio foi movido para ele.
O fluxo de servidor recriado fica em um expander recolhido por padrão, no mesmo
estilo de Recuperação e proteção. Mantém escolha explícita, aceite invalidado
ao mudar de opção e continuação baseada na intenção persistida. Recolher o
expander preserva os campos sem executar nenhuma operação.

## Regressões

`apps/sync-server/src/settings.ui.test.ts` cobre as páginas, preferências,
cadastros e arquivos nas duas plataformas. `syncSettings.ui.test.ts` cobre os
comandos principais, consentimento de reconexão, recuperação e concorrência.
`serverReset.ui.test.ts` mantém as regressões de servidor recriado. Esses testes
de UI usam o harness React existente, sem dispositivo ou infraestrutura, e fazem
parte de `npm run validate:local`. Não substituem ensaios de instalação nativa.
