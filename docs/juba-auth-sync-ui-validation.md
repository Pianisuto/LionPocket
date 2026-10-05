# Login e sincronização no tema Juba — PR #14

## Organização das telas

O painel de sincronização reutiliza o cabeçalho, superfícies, campos, ícones e botões de Configurações. O estado e as ações de sincronizar/pausar aparecem juntos; servidor e última sincronização ficam em uma linha de informações. Convites, recuperação e dispositivos têm grupos expansíveis, enquanto erros, conflitos e revisões continuam visíveis. O onboarding apresenta servidor, modo de conexão e confirmação, com o consentimento junto da ação que vincula a base. Privacidade local passa a apresentar três informações separadas: armazenamento no aparelho, conteúdo cifrado no envio e proteção do banco/backups locais.

O login usa as fontes e o ícone do app, cartão e campos arredondados e a paleta ameixa/rosa nos temas claro/escuro. O CSS substitui também a faixa do cabeçalho e os pseudo-elementos de foco do PatternFly, que conservavam azul. Fontes são servidas pelo próprio Keycloak, com licenças no tema; não há chamada a provedores de fontes. O formulário continua usando as macros de autenticação do Keycloak 26.7.4. Consulte o README do tema ao atualizar esse runtime.

## Verificação local em 05/10/2026

- Desktop: **19 arquivos / 254 testes passaram**; typecheck passou; lint terminou sem erros, com 151 avisos. Build de produção do renderer passou (aviso de tamanho de chunk).
- Preview: componentes reais de Configurações e SyncPanel com fixture sintética, sem acesso à base pessoal. Conferidos estados local, conectado, pendente, pausado, offline, pairing, preparação/recuperação, revisão e conflito nos temas claro/escuro; viewport estreita sem overflow horizontal.
- Fluxos da fixture: criar exige consentimento; confirmação do recovery exige o código correto; pareamento exige a comparação do fingerprint; recuperação do servidor conserva preparação, confirmação e ativação explícita. A fixture valida apresentação, habilitação e ligação dos botões, não substitui integração E2EE ou login nativo dos apps.
- Login: Keycloak local descartável, servindo o tema real por HTTP. Conferidos claro/escuro, foco, mostrar/ocultar senha e resposta real a credenciais inválidas. Inspeção das cores computadas de elementos e pseudo-elementos não encontrou azul no login; templates e recursos self-hosted/beta são idênticos.
- Capturas PNG feitas diretamente do browser com escala **2×**, com imagens completas e recortes dos cartões, sem redimensionar o arquivo original. A revisão do layout foi feita sobre essas capturas.

O protocolo, storage, criptografia e comandos do backend não foram alterados nesta refatoração. O teste visual de login usa credenciais inválidas de fixture; não alega concluir uma autenticação real desktop/Android nem implantar no servidor do usuário.
