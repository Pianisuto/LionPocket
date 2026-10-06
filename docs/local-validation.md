# Validação local antes de commit e push

GitHub Actions está desativado nas configurações do repositório. Os workflows automáticos e de publicação foram removidos; pushes, PRs e tags não iniciam jobs pagos. Não reative ou execute Actions sem uma nova decisão explícita do proprietário.

## Comandos e hooks

```sh
npm ci                    # instala também os hooks deste checkout
npm run validate:plan       # mostra a cobertura sem executar testes
git add <arquivos>
npm run validate:local      # pipeline completo deste host Linux x64
git commit -m "..."
git push
```

`pre-commit` e `pre-push` chamam o mesmo pipeline. Os hooks recusam mudanças não staged e arquivos novos não staged, porque testar um conteúdo diferente do commit não valida o que será enviado. No push, o index precisa corresponder a HEAD e as referências enviadas precisam apontar para o commit testado; outra branch deve ser validada no seu próprio checkout.

Uma execução aprovada gera recibo em `.git/local-validation/receipt.json`, com hash de todos os arquivos versionados/novos, runtime e cobertura. Commit e push reaproveitam o recibo por até 24 horas **somente se os bytes, permissões executáveis e runtime forem iguais**. Alteração, falha, mudança de runtime ou expiração exige nova execução completa. Um teste parcial não emite recibo. Essa reutilização evita repetir os mesmos builds entre um commit e seu push.

`npm run hooks:install` reinstala os hooks. O instalador recusa substituir uma configuração personalizada de `core.hooksPath`. Logs ficam em `.git/local-validation/`; nenhum recibo/log é enviado ao repositório. Uma execução manual de `validate:local` sempre testa novamente e invalida o recibo anterior antes de começar. Não use `--no-verify` para contornar falhas.

## Cobertura

| Etapa | Execução local |
| --- | --- |
| Versões/metadados/checksums | Scripts de release existentes; sem publicação |
| Testes, typecheck e lint | Todos os workspaces e regressões de release/hooks |
| Integração | PostgreSQL/Keycloak reais em projeto Compose exclusivo; remove somente volumes de fixture da própria execução |
| Self-hosted | Compose, testes operacionais, TLS, instalação limpa, E2EE, backup/restore e E1 → E2 → E3 |
| Linux normal e beta | DEB/ZIP, SQLite/perfis e deep link cold/warm/single instance com **pacote instalado em containers descartáveis** |
| Android | Debug/instrumentation, releases normal/beta de desenvolvimento, certificado efêmero, APKs base em checkout temporário, preservação de SQLite, schema/assinatura incompatíveis, deep link e cofre/checkpoints nativos |
| Windows | **Não executado em Linux.** Squirrel, associação do protocolo e DPAPI exigem host Windows descartável |

O teste de pacote Linux monta o checkout somente para leitura e instala o DEB dentro do container. O sandbox Chromium de root é desativado somente nesse ambiente de teste, protegido pelo isolamento externo do container; não muda configuração do produto. O Android cria seu próprio AVD, escolhe porta livre, confere nome/serial e `ro.kernel.qemu`, e remove somente esse recurso. Não usa telefone conectado nem AVD pessoal, não desinstala app pessoal e não limpa banco financeiro do usuário. O runner não publica binários, tags, releases ou mensagens externas.

## Pré-requisitos Linux

- Linux x64, Node 24+, npm, Git, Python 3, Docker Engine/Compose acessível ao usuário e KVM (`/dev/kvm`).
- JDK 21 completo, incluindo `javac` (`JAVA_HOME` tem prioridade). O runner aceita também um JDK já instalado em `~/.cache/lionpocket-local-validation/jdk21`; caso contrário, usa o home de `java`. JRE sozinho é recusado antes dos testes. O runner não baixa/instala JDK automaticamente.
- Android SDK em `ANDROID_HOME`/`ANDROID_SDK_ROOT`, ou `~/Android/Sdk`, com platform-tools, emulator, cmdline-tools/latest, `platforms;android-37.0`, `build-tools;37.0.0`, `ndk;27.1.12297006` e `system-images;android-36;google_apis;x86_64`, e respectivas licenças aceitas.
- Portas 55432/18080 livres para as fixtures de integração. O runner não encerra serviços existentes para liberar portas.
- Dependências instaladas com `npm ci`; acesso a caches/registries de npm, Gradle e imagens Docker na primeira execução. As execuções seguintes usam os caches locais.

Pré-requisito ausente ou erro de teste bloqueia o hook; não vira skip silencioso nem resultado verde. Para diagnóstico, `npm run validate:checks` executa apenas testes/tipos/lint e `npm run validate:android` executa somente a etapa Android completa. Nenhum desses comandos parciais autoriza commit/push ou emite recibo completo. O pipeline completo de hooks é suportado neste host Linux; Windows precisa do ensaio separado abaixo.

## Windows descartável

Em Windows Sandbox/VM de teste, nunca no perfil pessoal com uma instalação LionPocket em uso, execute para os canais `normal` e `private-beta`:

```powershell
npm ci
$env:LIONPOCKET_BUILD_CHANNEL = 'normal' # repetir com private-beta
npm run build:core
npm run test --workspace apps/desktop -- --testTimeout=30000 --hookTimeout=30000
npm run make -- --platform=win32 --arch=x64
node tools/release/checksums.cjs apps/desktop/out/make .exe .nupkg .zip RELEASES
node tools/release/desktop-smoke.cjs
$env:CI = 'true' # habilita somente o harness instalado no host descartável; não chama GitHub
node tools/release/windows-installer-smoke.cjs
node tools/pairing/desktop-deeplink-smoke.cjs
```

Registre o resultado separadamente. Um recibo Linux/Android não afirma que esse ensaio Windows aconteceu. Compilar um executável Windows em Linux não substitui instalar Squirrel, ler a associação do sistema e testar DPAPI.

## Interrupções

O runner mantém lock por checkout comum para não sobrepor builds/testes. Em interrupção, encerra os processos de teste e limpa os recursos próprios. Se um desligamento abrupto deixar `.git/local-validation/lock`, verifique `owner.json` e confirme que aquele PID/execução terminou antes de remover esse diretório. Nunca remova locks ou recursos de outra execução ativa.
