# Adoção automática de uma base financeira local

A ativação parte do estado atual do banco, sem exigir reconstrução do histórico
anterior ao sync. O backup automático continua ocorrendo antes da vinculação.
A captura e as novas identidades são gravadas na mesma transação; uma falha
reverte a ativação, sem modificar as linhas financeiras existentes.

## Identidades e histórico

- Identidades previamente atribuídas são preservadas. Para dados sem identidade,
  a adoção deriva o UUID do vault, tipo e ID local existente. Cópias dos mesmos
  registros dentro do mesmo vault recebem a mesma identidade; vaults diferentes
  permanecem isolados. Não se deduplicam lançamentos por descrição, valor ou data.
- Ocorrências recorrentes antigas usam `legacy:<objectId>` e conservam a data atual
  disponível como associação na sidecar. Não afirmam uma data histórica original.
  Todas são publicadas, incluindo planejados, cancelados, pagamentos zero e
  exclusões. Os aliases do agregado preservam a associação aos lançamentos.
- Parcelas antigas recebem um UUID de slot derivado da identidade do próprio
  lançamento. O índice interno usa a numeração atual relativa ao início disponível;
  posições anteriores ao início recebem um índice determinístico fora do intervalo
  atual. Números repetidos permanecem em registros distintos. A numeração financeira
  não é alterada. A relação entre UUIDs identifica slots históricos sem novos campos.
- O epoch inicial deriva da identidade da série e da estrutura atual, com o formato
  de UUID já aceito pelo protocolo. Alterações posteriores de estrutura continuam
  criando um novo epoch. Ocorrências novas usam slots da agenda atual. Previsões
  custom ancoradas
  incluem a data pretendida além do predecessor, distinguindo várias previsões
  após o mesmo pagamento; slots existentes continuam estáveis ao editar.
- Todas as frequências consultam os aliases históricos, inclusive os de registros
  excluídos. O intervalo até o maior mês entre as ocorrências legadas e a captura
  de adoção fica consolidado, inclusive lacunas: a agenda atual não retropreenche
  o histórico mensal, semanal, custom ou manual. A captura de restore conserva
  essa proteção. Períodos posteriores continuam gerando normalmente.
  Agregados parcelados adotados não sintetizam lacunas históricas a partir da
  numeração atual, nem recriam parcelas antigas ao receber uma edição de notas.

## Imports, exclusões e dependências

Imports com proveniência já registrada mantêm a regra existente. Imports sem essa
informação recebem um digest sintético com contexto separado, vault e ID local.
Esse digest identifica a linha adotada; não prova a origem de um arquivo perdido.
`sync_import_provenance.legacy_key` conserva a origem anterior. A linha principal
mantém `source_type`, `source_id`, valores e datas. No receptor, a origem permanece
importada, com a representação canônica do protocolo.

Linhas já excluídas são capturadas como snapshots históricos e depois como
exclusões `legacy_unknown`. As datas antigas ficam na proveniência. A projeção
inicial já respeita `legacyDeletedAt`: uma interrupção entre os snapshots e os
tombstones não faz registros excluídos reaparecerem. Exclusões legadas de agregados
não implicam novas exclusões em cascata: cada filho conserva seu próprio estado
atual. Exclusões novas continuam seguindo a regra normal do produto.

Identidades e slots são preparados antes dos snapshots; revisões seguem a ordem de
catálogos, séries, lançamentos e prioridades. Dependências identificam revisões já
capturadas. A adoção é enviada em commits de até 100 operações, sem mudar o limite
remoto. Retomadas com apenas `dependency_review_required` em linhas ainda não
publicadas também são adoção e recebem esse particionamento. Reviews de linhas
com revisions reais preservam a captura normal. Mutações reais do usuário mantêm
sua fronteira de atomicidade.

## Catálogos e versões reais

Na primeira adoção, catálogos com snapshots financeiros exatamente iguais recebem
a mesma identidade no vault: categoria inclui nome, kind e cor; forma de pagamento
inclui nome; cartão inclui nome e dias de fechamento/vencimento. A equivalência é
conservadora: normalizar apenas o nome poderia descartar cor, calendário ou grafia
que realmente diferem. Roots de adoção com o mesmo conteúdo são reconhecidos como
equivalentes, sem exigir decisão humana. O DAG conserva a proveniência de ambos.

Cadastros distintos com nomes iguais e propriedades ou históricos diferentes
permanecem distintos. A projeção do cadastro recebido usa um sufixo legível quando
necessário para atender à unicidade local. Não renomeia o cadastro preexistente.
O nome assinado continua no DAG e uma auditoria local da projeção evita publicar o
sufixo como se fosse uma edição do usuário. Não se fundem dois históricos
independentes nem se descarta uma propriedade para obter uma equivalência por nome.

Revisões já produzidas por clientes anteriores para séries, imports, exclusões e
ordem de dependências são retomadas automaticamente a partir das linhas atuais.
Identidades existentes, DAG, outbox e tombstones não são reinicializados. Uma
sidecar órfã/corrompida, sem dados que permitam reconstrução, não é confundida com
uma série legada presente.

## Interação que permanece necessária

A confirmação genérica de combinação e o bloqueio `joining_review` foram removidos.
O estado capturado e o caminho do backup permanecem como metadata de bootstrap.
Uma decisão específica pendente não impede registros independentes de sincronizar.
As telas e APIs de revisão de séries e imports e os formulários de renomeação em
lote foram removidos. Vincular dados não exige marcar que o histórico foi revisado.

Continuam explícitos conflitos reais entre versões, recuperação de registros
excluídos, aprovação de aparelhos, comparação de fingerprints, recovery code,
rotações/revogações e recuperação após alteração de servidor/epoch. Registros
fisicamente ausentes de uma cópia restaurada continuam produzindo
`restored_missing_record`; sua ausência não vira uma exclusão automática.

E2EE, assinaturas, grants, device registry, OIDC, controle de replay, validação de
dependências, autorização e isolamento entre vaults mantêm suas validações.
Auditorias de projeção e recibos históricos não se tornam decisões de recuperação.

## Compatibilidade e regressões

Não há mudança do envelope financeiro, domain schema ou tabelas SQL existentes.
São utilizados slots, aliases, proveniência e `legacy_unknown` já permitidos.
A camada de controle passa a **controlVersion 2**. O cliente novo exige um servidor
v2 antes de login, vinculação, captura ou envio: um servidor v1 não consegue excluir
pares antigos incompatíveis. O v0.3.11 já rejeita discovery com controlVersion 2.
O servidor também exige `X-LionPocket-Control-Version: 2` em todas as rotas protegidas
(controle, transporte e recuperação), retornando HTTP 426 `client_upgrade_required`
antes de autenticação, consumo do proof ou mutação. Isso cobre sessões em cache,
envelopes preparados e requisições atravessando a atualização do servidor. O header
é compatibilidade, não autorização: OIDC, proofs e grants seguem obrigatórios.

A implantação atualiza o servidor primeiro, em todas as réplicas. Aparelhos antigos
pausam sync conservando dados e pendências; cada aparelho retoma quando seu app é
atualizado. Não é preciso atualizar desktop e celular simultaneamente. Cliente novo
com servidor antigo também para com “Atualização necessária”. Nenhuma conversão de
ciphertexts, schema SQL, chaves ou backup é necessária. O servidor exige nova versão
da aplicação; isso substitui a recomendação informal anterior de atualizar ambos.

`tools/release/version-skew.cjs`, executado pelo CI de release, compila o código
original do v0.3.11 (commit fixo) com seu próprio protocolo. A integração comprova
recusa no discovery, preservação byte a byte das sidecars/outbox com envelope
preparado, recusa do transporte antigo, proof não consumido e retomada pelo cliente
atual. `clientVersion.test.ts` verifica a barreira em todas as famílias de endpoints
sem permitir acesso ao banco ou autenticação; foreground verifica recusa de servidor
v1 sem login/POST e sem alterar dados locais.

`legacyBaseline.test.ts` usa SQLite real nos adaptadores Desktop e Android:
4.118 lançamentos, 11 séries, oito mensais com 240 ocorrências cada, semanais,
custom ancoradas, manuais, quatro compras parcialmente pagas com índices repetidos
ou anteriores ao início, 300 imports sem proveniência, manuais, cancelamentos,
pagamentos zero, exclusões (inclusive duplicados excluídos), cadastros, meta e
prioridades. Cada direção adota uma base sem reviews, compara todas as linhas
financeiras da origem e sincroniza para um segundo banco vazio com comparação
semântica e replay. Exercita também geração posterior, edição de notas da compra,
edição de uma ocorrência no receptor, retomada de um baseline anterior, cópias de
uma base ainda não sincronizada com exclusão histórica (troca nos dois sentidos),
exclusões com snapshots diferentes/versão viva, 250 reviews exclusivamente de
dependência, rollback e catálogos iguais/diferentes. Consultas de vários períodos
históricos com agendas semanal/custom/manual alteradas exigem contagem total
exatamente estável em ambos os apps; geração futura é verificada por frequência.

As regressões de foreground comprovam envio sem aprovação de combinação e a
preservação de decisões específicas de restore. A convergência existente mantém
conflitos de pagamentos concorrentes, resolução por heads atuais e delete/edit.
As validações de sync/self-hosted exercitam pareamento, criptografia, restart,
revogação, offline, backup/restore e recuperações de epoch com o transporte real.
