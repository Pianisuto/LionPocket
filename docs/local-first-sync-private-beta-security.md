# Revisão de segurança da beta privada

Revisão interna de código e ensaios concluídos em 01/10/2026. Não é auditoria independente. O uso de teste mantém aplicação/perfil separados e backups privados fora do Git. A beta habilita nove entidades financeiras; não altera o opt-in sintético do piloto anterior.

## Fronteiras revisadas

- OIDC usa Authorization Code, PKCE/S256, state e nonce. Desktop recebe callback loopback; Android usa Custom Tab com scheme exclusivo da beta. Issuer, subject e audience são conferidos. As duas experiências foram executadas com sessões reais no Galaxy S23 e no Electron. Tokens não são persistidos nos perfis públicos.
- Convite fixa servidor, epoch, vault e autoridade. Aprovação compara fingerprint do pedido assinado. As provas HTTP vinculam método, target, origin, token, bytes e nonce; o servidor mantém isolamento de conta/vault e recusa replay, assinatura adulterada e dispositivo revogado.
- O cofre nativo guarda seeds e DEKs com escopo de instalação/dispositivo/vault/epoch/finalidade. Electron recusa `basic_text`; Android usa Keystore. Indisponibilidade conserva pendências e bloqueia o transporte, com uso local disponível.
- Conteúdo financeiro usa o envelope AEAD/assinatura do piloto. O servidor conserva ciphertext e causalidade pública. O ensaio HTTPS publicou 60 commits; o texto da fixture não apareceu em `sync_commits.envelope_text` nem nos logs da API. Essa busca é um canário, complementado pela revisão dos handlers que não registram payloads/tokens; não é uma prova formal de ausência de qualquer vazamento.
- Checkpoints de DEK são assinados pela autoridade, encadeados por hash e vinculados à versão do registry. Destinatários devem corresponder exatamente aos dispositivos ativos naquele ponto. As chaves históricas continuam disponíveis aos destinatários aprovados. Checkpoint atrasado é recusado.
- Revogação exige autoridade, conserva o registry e bloqueia novos commits até completar rotação. Pendências preparadas mantêm seus bytes arquivados; reemissão usa novos IDs e auditoria. Propostas condicionais exigem revisão. Recovery usa código aleatório independente, KDF com contexto e envelope assinado/cifrado; publicação exige redigitação. Rotação atualiza o recovery confirmado.
- Restore preserva DAG, outbox e bytes preparados, desabilita transporte e exige mesmo vínculo. Reconexão faz backup, recebe remoto e exige revisão antes de enviar diferenças. Ausência física de registro produz revisão explícita, nunca exclusão automática. Mudança de epoch interrompe transporte; migração automática entre epochs/servidores não faz parte desta beta.

## Ensaios e preservação

A suíte inclui adulteração de assinatura/cipher/scope, replay, conta/vault diferentes, revogação, rotação, recovery em nova instalação, rollback de checkpoint, cofre indisponível, crash/rollback SQLite, resposta perdida e retry, restore e epoch diferente. Integração usa PostgreSQL e Keycloak reais em namespace local isolado. O driver HTML desses testes não substitui o teste nativo, registrado separadamente em [resultados](fixtures/local-first/private-beta-results.json).

No LionsLab, PostgreSQL, Keycloak, API e túnel pertencem ao projeto `lionpocket-beta`, sem portas publicadas no host. Secrets ficam em arquivos privados externos ao Git. Deploy, restart, rollback de imagem e restauração de dumps em bancos temporários foram executados. Nenhum dump foi restaurado sobre o serviço ativo ou sobre workloads anteriores.

As nove tabelas financeiras do desktop original foram comparadas linha por linha ao snapshot consistente inicial: iguais, integridade `ok`, zero violações de FKs. A migração também foi ensaiada sobre uma cópia, preservando essas linhas. No Android, pacote original, versão, horário de atualização e SHA-256 do APK permaneceram iguais. O SQLite privado do APK original não foi extraído: a cópia financeira disponível é um export suportado anterior, não um snapshot atualizado do banco privado. O original não foi aberto para escrita, limpo, desinstalado ou atualizado pelo ensaio.

## Limites para a avaliação

SQLite, exports e backups locais permanecem em claro. O servidor aprende metadados de tempo/volume/causalidade. Strings JavaScript de alguns segredos não permitem limpeza garantida; buffers temporários são limpos nos caminhos de sucesso e erro. A assinatura do APK é de desenvolvimento. Não há política final de retenção/purge, distribuição pública, sync em background ou auditoria criptográfica independente.

A revisão de cadastros conserva ambas as identidades com nomes distintos. A fusão arbitrária de identidades globais já publicadas está fora da beta. Lotes acima de 100 operações ficam conservados e bloqueados. Recovery não apaga cópias já recebidas por aparelho posteriormente revogado. Prefira fixtures e cópias separadas durante a avaliação; os limites não justificam anunciar proteção criptográfica do banco local.
