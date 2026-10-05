# Tema de autenticação LionPocket

O tema Juba usa a paleta, as fontes Inter/Bricolage Grotesque e o ícone do aplicativo. Fontes e licenças estão incluídas: o login não depende de um serviço externo de fontes. Os temas claro e escuro seguem a preferência do sistema.

`login/login.ftl` deriva do formulário `keycloak.v2` do **Keycloak 26.7.4**, versão fixada no deployment. As macros de campos, botões, provedores e passkeys continuam herdadas; o formulário conserva action, campos, autocomplete, erros e controle de envio do upstream. A personalização acrescenta apenas a introdução e a informação de privacidade. Ao atualizar Keycloak, compare esse template com o upstream e confira também as páginas herdadas.

A cópia em `tools/sync-beta/keycloak-theme/lionpocket` deve permanecer idêntica a esta. Inclua a pasta completa ao atualizar o runtime, incluindo templates, mensagens e fontes. Os comandos operacionais do PR aplicam `loginTheme=lionpocket` também ao realm já existente.

Validação visual: login claro/escuro, foco por teclado, mostrar/ocultar senha, credenciais inválidas, idiomas e viewport estreita. Essas verificações usam o Keycloak local descartável; não exigem dados financeiros nem contas pessoais.
