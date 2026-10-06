# Recuperar o cofre

Pareamento e recuperação têm contratos separados. Adicionar aparelho usa um convite LPV2 temporário e aprovação. Recuperar após perder todos os aparelhos usa **Pacote de recuperação + Código de recuperação**, guardados juntos fora do aplicativo.

Em **Recuperação e proteção**, Desktop e Android geram esses dois materiais e pedem a confirmação do código guardado. Somente a confirmação publica o envelope cifrado no servidor e torna o novo código ativo. Gerar um código sem confirmar não substitui a recuperação já confirmada.

## Pacote público LPR1

`LPR1.<base64url-canônico>` contém somente versão, purpose `vault-recovery`, endpoint, TrustPin, versão mínima de recovery, checkpoint mínimo de registry, versão mínima de chave e assinatura da autoridade. Não contém seed, chave privada, código secreto, capability ou expiração. A assinatura cobre todos esses campos com separação de domínio `LionPocket/recovery-package/v1`.

Guarde o pacote autêntico junto do código. Um pacote adulterado é rejeitado antes de configurar o servidor. TrustPin identifica autoridade, cofre e epoch; discovery precisa confirmar servidor/epoch. As versões mínimas impedem que o servidor apresente estado anterior ao pacote guardado. Atualizações assinadas posteriores continuam recuperáveis com o mesmo material secreto; o pacote não fixa o hash de um envelope que será atualizado pela rotação.

## Código secreto e envelope

O código `LP1.<segredo>` é material criptográfico de recovery, distinto de qualquer convite. O servidor guarda somente o envelope cifrado e assinado. O cliente mantém assinatura da autoridade, KDF, AEAD XChaCha20-Poly1305, associated data de escopo/versão e validação da autoridade derivada da seed recuperada. Código incorreto, autoridade/TrustPin divergentes, assinatura inválida, rollback de registry/recovery e checkpoints inconsistentes são rejeitados antes de instalar chaves recuperadas.

Em uma instalação nova, escolha **Recuperar um cofre existente**, informe pacote e código e autentique a conta proprietária. O cliente verifica os materiais, obtém o envelope, prepara identidade própria, emite o grant com a autoridade recuperada, atualiza checkpoints/recovery e faz o primeiro sync pelo transporte assinado de dispositivos.

## Servidor restaurado e epoch recovery

Restaurar um backup operacional do servidor é diferente de criar uma instalação vazia. O [recovery de epoch](self-hosted-epoch-recovery.md) mantém autorização da autoridade e do proprietário, registro de restore, escrow, Recovery B, checkpoint de chaves, staging, ativação e finalização retomável. Ao ativar uma geração recuperada, o aplicativo assina um pacote atualizado para a nova autoridade/epoch. Guarde esse pacote atual junto do código confirmado; ele fica disponível em Recuperação e proteção. O pacote público não substitui essas garantias nem autoriza mover dados entre epochs automaticamente.

Para abandonar o remoto anterior e usar o banco local como fonte de verdade, siga [Servidor recriado e rebaseline](self-hosting.md#servidor-recriado-e-base-local-como-fonte-de-verdade). O aplicativo cria backup antes de desvincular, preserva as tabelas financeiras e inicia um novo cofre. Nunca apague o banco financeiro local para corrigir um vínculo de sync.
