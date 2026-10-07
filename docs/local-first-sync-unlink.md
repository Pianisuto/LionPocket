# Desvincular servidor neste aparelho

Em **Configurações → Sincronização → Desvincular servidor**, o usuário confirma que os dados financeiros locais serão mantidos. Desktop e Android usam `SyncController.unlinkServer(true)` no pacote compartilhado `sync-local`.

O planejamento mensal (`monthly_planning`), incluindo margens de segurança de cada mês e mudanças ainda pendentes, também é preservado. Após desvincular, continua editável offline e participa da nova baseline ao reconectar. Veja [o modelo e a cobertura](monthly-planning.md).

A operação é exclusivamente local: não consulta o servidor, não exige login e não revoga aparelhos nem apaga conta, cofre remoto ou servidor. Os outros aparelhos continuam vinculados. O registro remoto deste aparelho pode continuar na lista de dispositivos; removê-lo remotamente é outra ação.

O core cancela o ciclo de foreground e o polling de pareamento, aguarda suas operações em andamento e impede novos comandos durante a desvinculação. O consentimento é persistido como `unlinkPending` antes da limpeza. Uma interrupção ou falha conserva essa intenção e impede transporte/onboarding até a limpeza ser retomada, automaticamente na inicialização ou pelo mesmo botão.

A limpeza remove as chaves locais dos perfis conhecidos do aparelho (incluindo rotação pendente e preparação/ativação de recuperação), a sessão em memória, os perfis públicos, o vínculo, os cursores e as filas de transporte. Os sidecars opcionais de recuperação deixam de poder retomar operações no servidor anterior. O perfil público termina como `{ endpoint: '' }` e o banco volta a `mode='disabled'`, sem pausa, vínculo ou cursores: o uso normal permanece local-first.

Nenhuma tabela financeira é alterada. Identidades, aliases, slots de recorrência/parcelamento e proveniência/recibos de importação permanecem estáveis. As alterações não enviadas continuam nas tabelas financeiras; o próximo vínculo gera uma nova baseline desses dados. Revisões financeiras, alternativas de conflito e decisões pendentes são preservadas em texto claro no sidecar existente `sync_review`, com motivo informativo `detached_history`, antes da retirada do namespace de transporte. Esse histórico é somente de preservação, não uma fila para reenvio automático ou uma nova tela de revisão. O histórico acompanha os backups que incluem os sidecars de sincronização, sem criar tabelas nem alterar o formato de backup.

A confirmação não configura outro servidor. Depois da conclusão, as opções normais de configuração e convite ficam disponíveis novamente. Conectar futuramente usa os mesmos fluxos explícitos já existentes.

## Validação

`apps/sync-server/src/unlink.local.test.ts` usa bases SQLite sintéticas e os adaptadores reais Desktop/Android, sem serviços externos. Confere todas as tabelas locais fora dos sidecars de sync, pendências, valores monetários, recorrências, parcelas, metas, identidades/proveniência, conflitos, limpeza de segredos por escopo, isolamento de outros perfis, rollback, retomada após falha/crash, cancelamento de foreground, concorrência e nova baseline.

`apps/sync-server/src/syncSettings.ui.test.ts` confere nas duas interfaces a confirmação, o cancelamento, a volta à configuração local, a desvinculação durante onboarding e a repetição após falha. Esses testes offline não afirmam cobertura de instalação nativa Windows/Android ou cofre real do sistema operacional.
