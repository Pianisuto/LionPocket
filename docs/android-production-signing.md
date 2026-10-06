# Assinatura Android de produção

A partir da v0.3.11, o package normal `com.lionpocketmobile` usa uma identidade de assinatura permanente externa ao repositório. A chave privada nunca deve ser commitada.

## 1. Criar a identidade uma única vez

No computador responsável pela custódia, com JDK 21 e Python 3:

```sh
bash tools/release/create-android-production-signing.sh
```

Por padrão são criados, com permissões privadas:

- `~/.local/share/lionpocket-signing/lionpocket-production.p12`
- `~/.local/share/lionpocket-signing/android-signing.properties`

O script não sobrescreve uma identidade existente e não imprime a senha.

Faça pelo menos um backup independente e cifrado dos **dois arquivos**. Perder o keystore ou a senha impede publicar uma atualização compatível com instalações já assinadas por essa identidade.

O SHA-256 do certificado é público e pode ser registrado em documentação/checks de release. A chave e as senhas são privadas.

## 2. Build local com assinatura de produção

GitHub Actions está desativado e o workflow de publicação foi removido. Preserve a chave permanente e suas senhas fora do checkout. Configure um arquivo privado com `storeFile`, `storePassword`, `keyAlias`, `keyPassword` e `certificateSha256`, conforme as propriedades aceitas pelo Gradle; nunca adicione esse arquivo ao Git.

```sh
export LIONPOCKET_ANDROID_SIGNING_FILE=/caminho/privado/production-signing.properties
export LIONPOCKET_ANDROID_CERTIFICATE_SHA256=<fingerprint-permanente>
npm run mobile:build:android:release
node tools/release/android-production-candidate.cjs
```

O build recusa assinatura ausente, certificado debug e fingerprint divergente. O ensaio manual `validate:full` usa exclusivamente identidades de desenvolvimento/efêmeras de teste e não publica esse candidato.

## 3. Primeira migração de instalações antigas

As instalações anteriores à v0.3.11 podem estar assinadas pela chave pública de desenvolvimento. Android recusa `adb install -r`/instalação por cima quando o package ID é igual e o certificado muda.

Antes de desinstalar uma instalação antiga que contenha dados:

1. em **Dados locais**, salve um backup SQLite em arquivo externo;
2. se já usa sync, guarde também pacote LPR1 e código de recuperação, ou mantenha outro aparelho autorizado;
3. confira que o arquivo externo está acessível;
4. desinstale o app antigo;
5. instale o APK de produção v0.3.11;
6. restaure o SQLite por **Dados locais → Escolher arquivo local**;
7. reconfigure/repareie a sincronização.

O restore local desabilita transporte restaurado para não reutilizar secrets removidos com o Android Keystore antigo.

Depois dessa migração única, releases futuras assinadas pela mesma identidade podem atualizar normalmente.

## 4. Publicação explícita

A publicação é uma operação separada dos hooks de validação, feita somente após aprovação do proprietário. Não há workflow GitHub para disparar.

1. Execute `npm run validate:full` conforme o [guia local](local-validation.md) e registre também os ensaios Windows em host descartável.
2. Construa Linux/Windows normais e o Android com a identidade permanente; confira certificados, versões e checksums.
3. Prepare manifest/checksums com `tools/release/publication-metadata.cjs`, usando o SHA exato de `main` e a versão aprovada.
4. Somente depois da autorização explícita, crie a tag/release e envie os artefatos revisados pela operação manual. Não reutilize tag ou substitua release existente.

A tag publicada também identifica o source do servidor self-hosted, cuja imagem é compilada localmente.
