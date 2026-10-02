# Recuperação após restore do mesmo servidor

## Estado desta implementação

Este recorte entrega **registro operacional e autorização criptográfica de preparação**. Não entrega retomada da sincronização entre epochs. Nenhuma autorização desta versão ativa uma geração, muda TrustPin/binding, entrega chave nova ou libera a outbox. Os aplicativos continuam em `epoch_changed`, com uso financeiro local disponível. A extensão anuncia explicitamente `activationAvailable: false`; não existe botão de recuperação funcional na interface nativa.

O critério de conclusão da recuperação completa **não está atendido**. Esta implementação é base revisável, destinada a PR draft, conforme o recorte seguro permitido pela especificação. As limitações abaixo são bloqueios de implementação, não verificações que possam ser removidas.

## Fronteira de segurança

Um restore pode perder commits aceitos, revogações, cursores, nonces e checkpoints. `serverEpoch` impede que clientes interpretem esse rollback como continuação do mesmo histórico. Trocar epoch em SQLite, pin, grants ou envelopes antigos destrói essa fronteira. Mesmo `serverId` não prova continuidade; um operador pode mudar valores de configuração, mas não possui a authority private key.

A continuidade futura precisa de uma autorização do proprietário e de uma prova final verificável que comprometa a geração nova inteira. A autorização de preparação implementada aqui **não é essa prova final** e jamais deve ser aceita por um segundo aparelho para reconectar.

## Autorização de preparação v1

`EpochRecoveryChallenge` tem exatamente estes campos:

| Campo | Formato e significado |
| --- | --- |
| `formatVersion` | Inteiro `1` |
| `serverId`, `vaultId` | UUID v4 canônico do escopo antigo |
| `fromEpoch`, `toEpoch` | UUID v4 canônicos distintos, origem e destino |
| `authorityPublicKey` | Chave Ed25519 antiga, base64url canônico, 32 bytes |
| `restoreId`, `challengeId` | UUID v4 canônicos do restore e desafio |
| `nonce` | 32 bytes aleatórios, base64url canônico |
| `restoredRegistry` | `{version, sha256}` do registry restaurado |
| `restoredStateSha256` | Compromisso SHA-256 do estado restaurado, base64url, 32 bytes |
| `expiresAt` | Inteiro seguro, deadline em milissegundos definido pelo servidor |

`EpochRecoveryAuthorization` acrescenta `intent: "prepare-recovery"`, `knownRegistry: {version, sha256}` e `signature`. Versões de registry são strings decimais positivas de 64 bits, nunca números JavaScript. Assinatura Ed25519 destacada tem 64 bytes base64url.

Os bytes assinados são UTF-8 do JSON canônico existente no protocolo:

```json
{"authorization":{...todos os campos exceto signature...},"context":"LionPocket/epoch-recovery-authorization/v1"}
```

Não há prehash Ed25519, campos opcionais, reutilização de domínio HTTP/grant/recovery nem mutação de assinaturas antigas. O vetor `packages/sync-protocol/fixtures/epoch-recovery.json` contém seed **pública somente de teste**, challenge, autorização, bytes hex e SHA-256. `tools/epoch-recovery/generate-vector.cjs` reproduz a assinatura com Node/OpenSSL; os testes verificam os bytes e a assinatura com essa implementação independente. Inclui versão maior que o inteiro seguro JavaScript.

### Compromisso do estado restaurado

`crypto.hash` é SHA-256 dos bytes UTF-8 canônicos, codificado base64url. O acumulador começa em `{context:"LionPocket/restored-log/v1",pin}`. Cada posição contígua, em ordem numérica, acrescenta `{context:"LionPocket/restored-log-entry/v1",previousSha256,position,envelopeSha256,receipt}`. `envelopeSha256` deve corresponder aos bytes imutáveis `envelope_text`; a última posição deve corresponder ao contador do cofre. A leitura usa páginas limitadas a 100 envelopes.

O digest final é hash de `{context:"LionPocket/restored-state/v1",pin,registry,keyCheckpoints,recovery,logPosition,logSha256}`. Registry e checkpoints antigos são verificados antes de emitir o desafio. Recovery permanece ciphertext assinado do epoch antigo. O hash identifica o estado que o servidor apresenta; **não prova sozinho que esse estado é completo ou honesto**. Esta versão não oferece download/validação financeira do arquivo antigo para reconstruir baseline. A futura ativação exige essa validação pelo cliente e um manifesto separado da nova geração.

### Rotas e identidade

`POST /v1/vaults/:vaultId/epoch-recovery-challenge`, corpo `{fromEpoch,authorityPublicKey}`, exige OIDC válido da conta proprietária exata (`issuer` e `subject`), conta habilitada, vault dessa conta e registro durável de restore para o epoch corrente. Retorna challenge, pin/grants/checkpoints antigos e recovery cifrado. Não retorna plaintext financeiro, DEKs, authority seed ou commits financeiros. Não requer HTTP proof antigo, que pertence ao epoch anterior.

`POST /v1/vaults/:vaultId/epoch-recovery-authorize`, corpo `{authorization,knownGrants}`, exige a mesma conta e assinatura da authority antiga. O servidor valida todo o registry conhecido pelo proprietário, incluindo a história restaurada como prefixo exato. Revogações assinadas posteriores ao backup permanecem em `known_grants`; não se tornam grants novos nem são descartadas.

Cada desafio tem nonce aleatório, prazo de cinco minutos decidido pelo relógio PostgreSQL, escopo exato e consumo transacional único. São permitidos no máximo cinco desafios por cofre/restauração na janela consultada (deadline posterior a cinco minutos atrás). Assinatura válida sem desafio correspondente, conta diferente, outros epochs/vault/authority/restauração e ausência de registro operacional falham. O cliente não decide validade pelo seu relógio.

A primeira autorização consome o desafio, grava a prova e muda apenas o estado público para `authorized_awaiting_baseline`, na mesma transação. Falha reverte também o consumo. Repetição **byte a byte canônica** da mesma autorização/registry retorna o resultado durável, inclusive depois de expirar, sem aceitar outra operação. Outra autorização não substitui a primeira. A resposta sempre informa `activationAvailable:false`.

### Authority existente e recovery

`authorizeEpochRecovery` exige confirmação explícita, TrustPin antigo e authority seed do armazenamento seguro. Aparelho apenas pareado não possui essa authority. A helper não grava perfil, secret, SQLite ou outbox.

`authorizeEpochRecoveryWithCode` usa o código antigo para abrir e validar o recovery envelope do epoch A contra a authority do convite/pin confiável anterior. Verifica assinatura, AEAD, escopo e derivação da authority; assina a preparação e apaga os buffers temporários. Não instala esses secrets, não cria um aparelho operacional em B e não gera recovery B. Login ou chave do aparelho não substituem o código/authority. O convite confiável precisa existir fora do servidor; não se adota authority apenas porque o servidor a informou.

Sem aparelhos antigos, esta versão permite provar a authority com código válido, mas **não reconstruir o cofre nem retomar sync**. Reconstrução a partir de ciphertext restaurado, nova identidade, registry, chave e recovery B continuam pendentes. Dados posteriores ao backup ausentes de todos os aparelhos/backups são fisicamente irrecuperáveis. A interface futura precisa informar essa perda possível antes de escolher o estado restaurado como referência.

## Registro operacional, schema e backups

Quatro tabelas aditivas guardam somente metadados públicos/cifrados:

| Tabela | Invariante |
| --- | --- |
| `sync_restores` | Identificador único, serverId, origem do snapshot, destino único, epoch deslocado, instante PostgreSQL e SHA-256 do manifesto |
| `sync_restore_vaults` | Um estado por restore/cofre; `source_epoch` preserva o epoch do pin restaurado |
| `sync_epoch_challenges` | Desafios vinculados a restore/cofre/owner, prazo e consumo |
| `sync_epoch_authorizations` | Uma autorização imutável pela API por restore/cofre e challenge único, com registry conhecido |

O estado `recovered` está reservado; nenhuma rota desta versão o produz. Não são tabelas de gerações financeiras. As tabelas/envelopes financeiros antigos permanecem intactos, sem reescrita ou ativação no novo epoch. Continuam recuperáveis operacionalmente no snapshot e no banco restaurado; ainda não existe arquivo lógico separado consultável pelo cliente.

`lpctl restore` captura o ledger público da instalação antes de substituir os dumps. Persiste um journal privado ao lado do arquivo externo do segredo administrativo (`.restore-ledger.json` como sufixo), com escrita/rename/fsync, antes de qualquer drop de banco. Retry após perda do processo usa esse journal mesmo se o banco corrente ficou ausente. O journal é removido somente depois de serviços e autenticação administrativa confirmados; não o apague durante reparação. Depois do restore, mescla esse ledger com o do backup, recusando divergências de registros imutáveis. Estado/consumo são monotônicos. Registra o novo restore e os cofres pendentes **na mesma transação da geração do novo epoch**. Não modifica pins, grants, recovery, ciphertext ou outbox. Não há comando administrativo de ativação criptográfica.

`from_epoch` é o epoch do snapshot; `displaced_epoch` é o epoch da instalação substituída. Eles podem diferir quando um backup mais antigo é restaurado. O ledger não é uma cadeia de transições assinadas: registra fatos operacionais. Preservar o ledger evita esquecer restores anteriores ao restaurar snapshot antigo. Se o backup contém servidor em B mas um cofre ainda em A, o desafio em C falha `epoch_recovery_chain_required`; não fabrica A→C nem presume que B foi autorizado.

Manifesto de backup v2 inclui `restoreLedgerSha256`, digest hex do JSON público ordenado (tabelas, campos e linhas por chave primária). `verify-backup` restaura os dumps em bancos temporários, confere integridade estrutural, referências e digest, sem alterar a instalação. Não verifica criptograficamente as assinaturas: essas são verificadas na API/cliente. Manifestos v1 continuam aceitos; backup legado sem ledger não fornece evidência de restore anterior. SHA-256 não substitui autenticidade externa do backup.

`lpctl status` mostra quantos cofres ainda aguardam recuperação, quantos deles já possuem autorização aguardando baseline e quantos estão recuperados no epoch corrente, com aviso explícito de indisponibilidade de ativação. Não promete que a autorização devolveu sync.

## Bloqueios para a recuperação completa

O bootstrap atual publica diretamente no log ativo. Não há staging isolado, manifesto completo ou ativação atômica. O SQLite usa um único grafo de revisões/heads, posições de inbox e binding; a validação de backup associa a inbox a esse binding. A reemissão existente conserva parents/dependencies antigos e não serve como rebase entre epochs. Usar esses caminhos para ativar B quebraria os invariantes de causalidade, assinatura ou crash safety.

São necessárias as seguintes extensões, **ainda não implementadas**:

1. Gerações arquivadas/ativas distintas, restrições de unicidade e normal sync limitado à ativa; preservar todo o histórico A.
2. Staging com lotes limitados, hashes/manifesto, validação de assinaturas/grafo/escopo e ativação atômica idempotente.
3. Prova final `EpochTransition` em domínio próprio (por exemplo `LionPocket/epoch-transition/v1`) comprometendo a autorização, geração/manifesto, registry/checkpoint/recovery B, chave pública da authority e transição final anterior. Preparação não pode substituí-la.
4. Revisão explícita dos aparelhos, novos grants B assinados, nova data key/checkpoint e deliveries apenas para ativos. Preservar chaves antigas; nunca reativar revogados conhecidos. Não há como deduzir uma revogação pós-backup se sua única evidência foi perdida.
5. Recovery B: reembrulhar com recoveryMaster confirmado quando disponível; caso contrário novo código com confirmação antes de ativar. O código antigo nesta versão recupera somente o bundle antigo.
6. Backup SQLite consistente antes de qualquer mutação; arquivo/mapeamento durável de binding, outbox e revisões antigas; instalação transacional do binding B e estratégia recuperável para secrets fora do SQLite.
7. UX explícita de aparelho âncora, estados duráveis de preparação/upload/ativação/revisão e ingresso dos demais aparelhos. Foreground jamais inicia essa transição automaticamente.

### Baseline, causalidade e outbox: contrato da etapa pendente

A baseline futura deve incluir estado sincronizável completo: categorias, pagamentos, cartões, transações, recorrências, parcelas, objetivos, prioridades, slots, aliases, séries, proveniência, dependências, tombstones e múltiplos heads. Global object IDs e identidades financeiras comprovadas permanecem; commit/op/revision IDs, binding, sequence, cursor, receipt e nonces de transporte são novos. Nunca reutilizar um commit/op ID com bytes diferentes.

Cada revisão antiga relevante precisa de snapshot validado e revisão nova, com parents exclusivamente no DAG B e rastreabilidade `restoredFrom` quando comprovada. Conflito antigo mantém múltiplos heads novos. Exclusão mantém tombstone. A outbox A nunca é transmitida em B; seus bytes ficam arquivados. Somente após ativação confirmada, efeitos comprovadamente incluídos podem ser marcados superseded pela migração. Escolhas não projetadas ou efeitos sem evidência ficam em revisão.

No cenário C1 no backup, C2 aceito depois do backup no desktop e C3 offline no Android, C2/C3 sobrevivem localmente nesta versão; **não são reconciliados em B**. A etapa futura compara DAGs locais com o estado restaurado e mapeamentos de snapshots. Equivalência comprovada não produz commits financeiros redundantes no segundo aparelho. Causalidade comprovada produz parents B correspondentes; concorrência, edição versus exclusão e evidência insuficiente exigem conflitos/revisão. Nunca há last-write-wins por horário. Tombstone exclusivo deve ser reemitido para impedir ressurreição silenciosa.

O segundo aparelho só reconecta depois de verificar a **prova final** pela authority já confiável, inclusão ativa no registry B, grant B e delivery novo. Deve fazer backup antes de baixar/comparar baseline, preservando dados locais exclusivos. Aparelho não autorizado permanece local e não recebe chave nova. Estas ações não estão disponíveis nesta versão.

## Validação e limites da evidência

Os testes de protocolo cobrem vetor determinístico, domínio próprio, campos exatos, chave/escopo externo e alterações de todos os compromissos. A integração descartável PostgreSQL/Keycloak usa adapters SQLite reais desktop/mobile e comprova bloqueio sem alterar tabelas sync, C2/C3 locais, conta errada, servidor sem ledger, assinatura ausente/de outra authority, vault/epochs/restore/nonce incorretos, expiração no servidor e autorização por recovery em contexto limpo.

Fault injection entregue: abandono após challenge/assinatura; exceção PostgreSQL depois do consumo e antes de gravar autorização (rollback); perda de resposta simulada com retry após restart e expiração; perda do processo de restore depois do drop de banco, preservando o ledger no journal externo. A autorização tem uma única linha durável. Canários financeiros/recovery são procurados no PostgreSQL e logs da implantação sintética. Não há dados pessoais nos fixtures.

O ensaio oficial `lpctl` usa clean-install, TLS confiável, backup/verify/restore duas vezes e prova **ledger operacional E1→E2→E3**. O teste de controle recusa salto de um cofre A ainda não recuperado para C. Isso **não é** recuperação financeira completa A→B→C. Não foram implementadas nem certificadas falhas no staging/ativação/binding/secrets/rebase ou convergência de tombstones/conflitos entre epochs. Clientes anteriores continuam no bloqueio seguro.

Limites adicionais: os controles mantêm o limite existente de 64 KiB por pedido e 4 MiB por resposta. Registry maior que esses limites falha sem mutação; paginação/prova compacta de registry é trabalho futuro. Hash do log é paginado, mas a emissão do challenge ainda mantém lock do cofre durante a leitura. O ledger não constitui auditoria independente nem altera a confiança no operador.

`protocolVersion=1`, `domainSchema=1` e wire financeiro permanecem iguais. Discovery adiciona somente `epochRecovery:{formatVersion:1,authorizationAvailable:true,activationAvailable:false}`. Fora de escopo: outro serverId/issuer/domínio, Cloud, background Android, GC e funcionalidades financeiras. As decisões do Vault/Visão e Decisões não foram alteradas: local-first, causalidade sem relógio, revisão explícita e autoridade do usuário continuam necessárias.
