# Evidência do draft de gerações e planejamento do anchor

Execução local em 2026-10-02, branch `codex/anchor-generation-recovery`, base main `cfaf1ea99f56af2fa9c1ac23b429bd21f33320dc`, após PR #9. Todos os dados/contas/SQLite/servidores são sintéticos e descartáveis. Não foi aberto banco pessoal nem instalada atualização sobre aplicativos pessoais.

**Resultado: recorte seguro em draft; recuperação financeira B não concluída.** Discovery mantém `activationAvailable:false`. O [modelo e o bloqueio de projeção/fechamento do grafo](self-hosted-epoch-recovery.md) delimitam exatamente a implementação.

| Verificação | Resultado local |
| --- | --- |
| `npm test` | 372 passaram; 33 condicionais de integração não executados nessa chamada |
| `npm run typecheck` | Passou em todos os workspaces/harnesses |
| `npm run lint` | Passou, zero erros; warnings de regras existentes, incluindo non-null assertions em fixtures |
| `git diff --check` | Passou |
| `npm run release:validate` | Passou: 0.3.10 / Android versionCode 3 |
| `npm run sync:dev:test` | PostgreSQL/Keycloak reais: 61 passaram, 1 condicional de cliente anterior não executado nessa chamada |
| `node tools/release/version-skew.cjs` | 3 passaram; engine/controller anterior de `8de0087cdbcdcc670ec2073ba3f4ea51932072b4` compilados sem alteração |
| `npm run sync:self-hosted:unit` | 21 passaram, incluindo geração legacy/parcial, digest paginado, envelope adulterado e validação read-only |
| `npm run sync:self-hosted:validate` | Compose Caddy, proxy próprio e CA com secrets externos sintéticos passaram |
| `npm run sync:self-hosted:test` | Clean-install, TLS/PKCE, SQLite desktop/mobile, normal sync, restart/offline, canários e backup/verify/restore oficial passaram |
| Linux normal/beta | `npm run package` nos dois canais passou |
| Android debug/normal/beta | `assembleDebug`, `assembleRelease -PdevelopmentSigning=true`, `assembleRelease -PprivateBeta=true`, x86_64: passaram |

O primeiro build Android falhou por ausência de `javac` no JDK 21 do host. Retry utilizou o JDK 17 de teste já disponível no cache Gradle e passou nos três canais. Não houve instalação de JDK no sistema nem alteração de signing de produção. Os APKs são de desenvolvimento/teste; não foram instalados num dispositivo pessoal.

## Evidência de preservação e planejamento

O teste PostgreSQL/Keycloak com adapters SQLite reais estabelece desktop proprietário e Android pareado, aceita C1, captura snapshot do servidor, aceita C2 no desktop depois do snapshot e conserva C3 no Android offline. O restore sintético perde C2 remoto e muda o epoch. A autorização é aceita, o servidor congela seus envelopes restaurados em arquivos tipados imutáveis, o desktop cria backup SQLite aberto e hashado, arquiva seus sidecars e prepara mapping contendo **C1+C2**. Os op/commit IDs de B são novos. Tabelas/grafo/outbox/binding A e Android continuam iguais. Não há envio de baseline B, instalação B ou retomada do sync.

Os oito testes de arquivo/planejamento usam SQLite nativo desktop e o adapter mobile real de teste. Conferem cópia das colunas de todos os sidecars, bytes dos envelopes preparados, inspeção do backup, retry com os mesmos IDs, tombstones e duas branches edit/edit e delete/edit, dependencies entre heads topológicas, review desconhecido/histórico e paginação de um grafo com 107 heads. JSON export completo falha explicitamente quando não consegue preservar a extensão; cancelamento mantém toda a evidência.

O teste específico da projeção comprova o **bloqueio arquitetural novo**: X/Y com uma base comum em A mantêm uma transação disponível; reemitir apenas essas duas branches como raízes e passá-las pela projeção normal B mantém dois heads/conflito mas deixa a transação ausente. Esse resultado é deliberadamente documentado, não convertido em ativação supostamente segura.

O vetor final OpenSSL cobre domínio `LionPocket/epoch-transition/v1`, commits de artifacts/manifesto/pin, alteração de campos, substituição da assinatura pela autorização de preparação, contagens int64 e encadeamento contratual A→B→C. Os artifacts do vetor são compromissos sintéticos, não proteção B de produção.

## Fault injection e privacidade

Coberto nesta preparação:

- falha do backup/hash/pin antes de qualquer tabela de recovery;
- rollback durante cópia local, antes de selo, com A intacta;
- interrupção durante mapping: nenhum mapping parcial fica utilizável; retry converge;
- fault PostgreSQL durante autorização e durante cópia do archive: consumo/challenge/autorização/cópias revertem juntos;
- perda de resposta/restart/retry da autorização depois da expiração;
- imutabilidade de archive, selo, journal identity e mapping;
- tentativa de registrar duas gerações selecionadas simultaneamente;
- cadeia operacional após restores oficiais E1→E2→E3 continua bloqueando salto de um cofre A pendente;
- canários financeiros/recovery ausentes de PostgreSQL e logs, incluindo archives remotos.

`verify-backup` v3 foi executado com instalação ativa A e senha administrativa do backup B diferentes. Dumps/config/secrets/CA/identidade/serviços permaneceram iguais; bancos temporários foram removidos. Backup adulterado foi recusado. Isso é read-only para a instalação ativa.

**Não implementados/testados:** secrets/profile/registry/key/recovery B; abertura de recovery B em instalação limpa; staging/upload/manifesto remoto completo; activation transaction/replay/concorrência; crash após ativação e saga de instalação B; sync normal B; integração financeira do anchor E1→E2→E3. As contagens/nomes de testes acima não certificam esses cenários. Segundo aparelho e recovery sem SQLite antigo permanecem pendentes.

Windows normal/beta, packaged/installed Electron smoke e upgrade Android de aplicativo instalado são responsabilidade dos workflows de readiness acionados pelo PR. O resultado remoto deve ser consultado no PR; a evidência local não afirma sucesso desses jobs. Nenhuma decisão do Vault/Visão e Decisões foi alterada.

A primeira execução Windows do PR encontrou `EPERM` no flush do arquivo de backup aberto com `r`. A correção usa `r+`, sem truncar ou escrever bytes, pois `FlushFileBuffers` exige acesso de escrita. A inspeção SQLite/hash posterior continua read-only. Os oito testes locais de archive passaram novamente; os checks do HEAD atualizado são a evidência da validação Windows.
