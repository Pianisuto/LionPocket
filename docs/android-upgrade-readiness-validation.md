# Readiness do upgrade Android no PR #11

Investigação local em 2026-10-02, partindo de `3a6753b88cadbfb84edd9c9f6486427ce502891f`, na mesma branch `codex/causal-anchor-rebase`. Somente AVDs API 36/google_apis/x86_64 descartáveis e SQLite sintético. APK anterior real: `8de0087cdbcdcc670ec2073ba3f4ea51932072b4` (0.3.9, versionCode 2); candidato atual: 0.3.10, versionCode 3. Não foram usados aparelhos ou dados pessoais.

## Evidência e limite da atribuição

O [run 37019147701, job Android 110878476776](https://github.com/Pianisuto/LionPocket/actions/runs/37019147701/job/110878476776) passou v1 e falhou v4 com `user_version=4`. O harness fazia `am start`, esperava seis segundos e executava `am force-stop`, sem verificar processo, abertura do arquivo ou conclusão da migration. O run antigo não guardou logcat/estado do processo. Portanto **não permite provar qual condição específica de startup ocorreu naquele runner**; não classificamos automaticamente o run como flaky.

Antes de alterar o produto, a matriz original inteira passou no AVD local. No v4, logcat mostrou `Start proc`, `ReactNativeJS: Running "LionPocketMobile"`, biblioteca NitroSQLite carregada e Activity exibida. O arquivo `/data/user/0/com.lionpocketmobile/files/lionpocket.sqlite`, UID sintético 10216, passou de 139264 bytes/schema 4 para 352256 bytes/schema 8. O backup de proteção v4 foi criado em `files/backups`. Não havia WAL/SHM nem `AndroidRuntime` fatal/erro JS de migration nessa reprodução. A função `migrate`, a abertura inicial e as migrations financeiras eram idênticas às do main após PR #10; a alteração de `workflow.throw` é no adapter de workflows sync.

Reprodução controlada do defeito do harness, com o mesmo APK/arquivo/storage:

1. Processo parado; injetar a fixture v4, preservar UID/permissões/contexto SELinux; verificar schema 4.
2. `adb install -r` do candidato; iniciar Activity; suspender o PID recém-criado com SIGSTOP antes da inicialização React Native.
3. Aos seis segundos: PID 7082 em `State: T (stopped)`, schema 4, arquivo v4 intacto. O `force-stop` do harness antigo mantém schema 4 e reproduz exatamente sua assertion.
4. Abrir novamente **sem reinstalar nem limpar storage**: PID 7253 executa React Native e migra o mesmo arquivo para schema 8, sem crash.

Isso prova uma race no critério antigo: tempo decorrido não é conclusão de startup/migration. Não foi reproduzida regressão na migration do produto. O mecanismo exato do atraso/falha do run antigo permanece sem observação direta; os novos diagnósticos tornam uma recorrência distinguível de erro real de startup, migration, arquivo ou transporte ADB.

## Condição de conclusão e diagnóstico

`connection.ts` emite `[LionPocket] database ready: lionpocket.sqlite schema=8` somente depois de `await migrate` (incluindo os commits transacionais) e da configuração do UUID provider existente. Falha de migration emite marcador de erro, fecha a conexão e continua rejeitando a Promise; não há bypass nem alteração da migration.

`android_readiness.py` exige, para o candidato atual:

- PID atual do package ainda presente;
- esse PID abriu exatamente o arquivo injetado: comparação de device/inode com `/proc/PID/fd`, inclusive aliases/bind mounts `/data/data` e `/data/user/0`;
- `PRAGMA user_version=8`, usando SQLite do AVD com `-readonly`, `query_only=ON` e o UID do app;
- marcador de readiness pertencente ao **mesmo PID**, com logcat limpo antes dessa abertura.

A fixture v8 preexistente, um marcador de processo anterior ou apenas `Running LionPocketMobile` não satisfazem o critério. O APK anterior, que não possui marcador novo, usa schema 8 + FD correto + processo React Native corrente para sua preparação inicial. O harness de compatibilidade também espera readiness na substituição final e exige a rejeição específica de schema futuro 99 pelo startup real; arquivo 99 intocado sem abertura não passa.

Polling de 250ms, janela de observação de 60s e timeout de 5s por chamada ADB, seguido por diagnósticos também limitados. Lock/ADB indisponível não vira sucesso. Em timeout/erro, captura antes do cleanup: schema encontrado, PID/status, package/code path/dataDir/UID, SQLite/WAL/SHM com tamanho/inode/mtime, `dumpsys activity` e logcat ReactNativeJS/ReactNative/AndroidRuntime/LionPocket/ActivityManager. O schema é consultado pelo protocolo de locking/WAL do SQLite; não há cópia inconsistente de arquivos vivos nem escrita de migration pelo harness. Extração do main/WAL/SHM para comparar registros continua somente após `force-stop` e confirmação de ausência de processo.

O upgrade continua `adb install -r`. Comparações de todos os registros/colunas/tabelas originais, sidecars, `integrity_check` e `foreign_key_check` permanecem intactas. O harness agora também exige UID/inode do diretório de storage iguais antes/depois; não usa uninstall, clear-storage ou downgrade. A sequência da matriz existente foi preservada: instalação inicial do APK anterior, v1→atual, fixtures v4/v5/v8 com substituições do candidato já instalado; beta instala seu APK anterior separado e substitui v8→atual.

## Resultados locais

| Package/cenário | Schema final | Registros/tabelas comparados | Readiness |
| --- | --- | --- | --- |
| Normal v1 | 8 | 2 / 1 | 1,549s |
| Normal v4 | 8 | 13 / 10 | 1,930s |
| Normal v5 | 8 | 14 / 11 | 2,014s |
| Normal v8 | 8 | 47 / 30 | 2,214s |
| Beta anterior v8 → beta atual | 8 | 47 / 30 | 1,295s |

Todos: `integrity_check=ok`, zero FKs, valores preservados, storage preservado. Também passaram: substituições finais normal/beta com todas as tabelas iguais; recusa `INSTALL_FAILED_UPDATE_INCOMPATIBLE` sem uninstall ou alteração do banco; abertura/rejeição específica de schema 99 sem modificar seus registros.

Teste real da nova espera com SIGSTOP e retomada deliberada após sete segundos: schema 4 enquanto suspenso, readiness/schema 8 no mesmo PID/storage após **7,435s** totais. Uma janela negativa de 1s não aceita o processo suspenso e captura PID/State T/schema 4/logcat/Activity/arquivos. O delay é fault injection do experimento, não uma espera adicionada ao harness.

Regressões permanentes: 10 testes Python, executados por `npm test`/`test:release`, cobrem atraso além de seis segundos, v8 sem inicialização, arquivo errado, PID morto, lock, erro explícito, transporte ADB, marker de PID anterior, leitura SQLite readonly/UID e rejeição específica de schema futuro. O teste mobile mantém a migration pendente e prova que o marcador só aparece após sua conclusão, e nunca após falha.

Validação local adicional: archive/planner 43 testes (incluindo replay, C1+C2, conflitos e stress 4000); `npm test` 409; typecheck; lint sem erros; diff check; PostgreSQL/Keycloak 61 + cliente anterior 3; self-hosted 21 unitários e smoke completo; Android debug/normal/beta, assinatura ausente/fixture externa e assinatura incompatível. A primeira execução local concorrente dos testes IdP e cliente anterior colidiu nos listeners 18761/18774; executados em sequência passaram. Nenhuma mudança de produto foi feita para esse erro de orquestração local.

Os dois workflows do novo HEAD devem ser consultados no [PR #11](https://github.com/Pianisuto/LionPocket/pull/11); a evidência acima é local, não substitui seus resultados remotos. Não houve staging, geração B ativa, keys/recovery/registry B, EpochTransition persistida, activation, binding B ou migração de segundo aparelho. Protocolo/E2EE/Vault, causal closure/replay/plan_format=2, preservação de conflitos, `workflow.throw`, `preserveUncapturedWrites` e `activationAvailable:false` continuam iguais.
