# Próximo PR — sincronização financeira para beta privada

## Pedido e resultado esperado

O usuário autorizou, em 30/09/2026, um próximo PR com escopo grande para poder testar desktop e Android. Também autorizou acessar e configurar o LionsLab por SSH para testar o servidor. O trabalho começa após o merge do piloto da Etapa 1, em **um novo thread** e uma nova branch. Este documento é o brief de continuidade; a implementação abaixo ainda não foi iniciada.

Entregar um fluxo testável pelas telas dos dois apps, com servidor de teste acessível pelo celular, onboarding revisado de bases preenchidas e sincronização dos principais dados financeiros. Reunir Etapas 2 e 3 da proposta e os requisitos de operação necessários para essa beta privada em um PR coerente, com commits internos por bloco e validação contínua. O pedido por velocidade não elimina os critérios de preservação dos dados.


## Escopo

1. **Conexão e dispositivos pelas telas:** configurar endpoint self-hosted, login OIDC/PKCE no browser do sistema/Custom Tab, criar vault, conferir convite e autoridade, registrar pedido, aprovar por fingerprint ou QR, entregar chave e listar/revogar dispositivos. Conservar uso local sem conta. Remover a dependência de copiar JSON pelo CLI para o fluxo principal de teste. Mostrar estado, erros, pendências e quarentena de forma compreensível.
2. **Bases preenchidas:** snapshot consistente, backup anterior à vinculação, revisão de elegibilidade, baseline durável cifrado e retomável, identidade global em sidecars sem trocar PK/FK locais. Revisão explícita para combinar dois bancos já preenchidos, nomes iguais, duplicatas e aliases. Nenhuma igualdade de valor/descrição prova identidade. Preservar escritas durante desligamento e reconectar com outbox intacta.
3. **Cadastros e lançamentos completos:** categorias, formas de pagamento, cartões e lançamentos com referências. Validar dependências, ordem de aplicação, exclusão/aliases e tombstones. Cobrir criar/editar/realizar/excluir e lotes. Capability só anuncia entidades efetivamente implementadas e testadas.
4. **Planejamento:** recorrências/slots/epoch, projeções mensais, compras parceladas, objetivos e prioridades como agregados. Não sincronizar caches locais como novas entidades financeiras. Não inferir identidade histórica ambígua; exibir revisão e bloquear somente o envio afetado. Verificar duas gerações offline da mesma competência, ciclo de cartão, renumeração de parcelas e recorrência ancorada no realizado.
5. **Importação, backup e conflitos:** fechar a proveniência/deduplicação de importações; adaptar todos os writers, migrations e validators antes de habilitar o schema novo. Restore/staging conserva história e pendências e exige reconexão segura, sem rollback remoto. Acrescentar busca de pais faltantes, preservação de desconhecidos, merge dos grupos de campos compatíveis e revisão explícita dos conflitos restantes. Heads obsoletos conservam o rascunho recusado. Delete/edit não ressuscita o original.
6. **Recuperação e privacidade para o teste:** concluir o fluxo do código de recovery e rotação da DEK após revogação, reemissão de pendências com proveniência e nova identidade quando necessário. Testar perda de dispositivo, cofre indisponível, recuperação e alteração de epoch. Conteúdo financeiro remoto permanece cifrado; não anunciar SQLite/export local cifrado. Registrar revisão de segurança e quaisquer limites que impeçam habilitar dados reais.
7. **Servidor de teste no LionsLab:** descobrir o alias SSH configurado e inspecionar serviços, portas e armazenamento existentes antes de escrever. Implantar em namespace próprio, com PostgreSQL/Keycloak/API, HTTPS, redirects explícitos para desktop/Android, configuração de origens coerente com a prova HTTP, secrets externos ao Git, logs sem payload/token e backups com ensaio de restauração. Não substituir workloads ou abrir portas indiscriminadamente. Registrar deploy, atualização e rollback reproduzíveis. Usar o mesmo protocolo do ambiente local.
8. **Entrega para teste:** produzir APK de teste e desktop compatíveis, com instruções curtas de instalar, parear, sincronizar, trabalhar offline, resolver conflito, recuperar e retornar ao estado anterior. Mostrar claramente qualquer entidade ainda fora do escopo. Push, Open Finance, cobrança e lançamento público do Cloud continuam incrementos posteriores do vault.

## Dados atuais e celular conectado

O usuário autorizou usar seus bancos desktop/mobile e informou que o celular físico está conectado com depuração USB e versão antiga do app contendo dados. A condição explícita é **restaurar os dados como estavam antes depois do teste**.

Começar com fixtures preenchidas. Ao usar dados do usuário, obter backup consistente e verificável por exportação suportada; guardar cópia privada fora do Git e dos relatórios públicos. Preferir cópias dos bancos e um applicationId/perfil separado. Não desinstalar nem limpar o pacote original. Não instalar por cima dele apenas para facilitar a extração do banco.

Um ensaio de atualização da instalação original exige caminho de retorno já preparado: versão instalada/APK compatível, conteúdo e schema anteriores, integridade/FKs, todas as tabelas financeiras e preferências comparadas, e restauração demonstrada. Encerrar o ensaio comparando o estado restaurado com o snapshot inicial. Se não houver acesso suportado ao backup ou reversão verificável, manter o teste na instalação separada e explicar o bloqueio; não presumir acesso a SQLite privado de APK release.

## Critérios de aceite

- Instalações vazias e preenchidas conseguem conectar, parear e sincronizar pelas telas, incluindo Android físico com login Custom Tab e desktop. Usar duas sessões OIDC reais e aparelho identificado, sem broker de tokens substituindo a experiência final.
- Dados e totais convergem nos dois sentidos: cadastros, manuais, referências, recorrências, parcelas, objetivos, prioridades e operações em lote. Preservar centavos, zero, NULL, Unicode e auditoria/proveniência.
- Bases antigas migram com cópia anterior, preservação de PK/FK e rollback. Baseline e envio não duplicam dados em retry após perda de resposta, crash, reinício ou interrupção.
- Duas bases preenchidas e importações repetidas apresentam revisão antes de combinar dados; exclusões offline, edição concorrente e resolução obsoleta preservam todos os ramos.
- Cofre e E2EE funcionam no desktop e no Android físico. Validar isolamento de conta/vault/dispositivo, assinatura adulterada, replay, revogação/rotação, recovery e restore/epoch.
- O mesmo contrato passa localmente e no LionsLab; testar HTTPS, reinício, backup/restauração, ausência de plaintext financeiro em banco/log remoto e uso offline após desconectar servidor/conta.
- Os testes apropriados, lint/typecheck e builds passam. Documentar contagens, runtimes, limitações e hashes dos artefatos. Revisar o código antes do merge; autorização para merge do piloto anterior não é autorização implícita para merge desta nova implementação.
- Dados originais do usuário permanecem intactos ou são restaurados com comparação comprovada. A entrega final inclui como instalar/testar e qual estado foi preservado/restaurado.

## Prompt para o novo thread

> Implemente `docs/local-first-sync-next-pr.md` a partir da main após o merge do piloto. Faça um PR amplo e testável de sincronização financeira para beta privada, cobrindo bases preenchidas, cadastros, planejamento, telas de onboarding/pareamento/conflitos, recovery/rotação e servidor de teste no LionsLab por SSH. O usuário autorizou usar cópias de seus bancos atuais e o celular conectado por USB; se os originais forem usados em um ensaio, restaure e comprove os dados anteriores ao terminar. Preserve o uso local sem conta e os dados existentes. Execute a implementação até entregar os artefatos e as instruções de teste; não encerre apenas com um plano. Não faça merge do novo PR sem nova autorização. Consulte o vault e os contratos, registre decisões, validações e limites no repositório, e vincule o PR ao novo thread do T3 imediatamente ao criá-lo.
