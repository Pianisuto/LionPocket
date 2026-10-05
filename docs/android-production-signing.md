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

## 2. Configurar GitHub Actions

Com GitHub CLI autenticado:

```sh
bash tools/release/configure-github-signing-secrets.sh
```

O helper lê o arquivo privado e envia por stdin os seguintes repository secrets, sem imprimir seus valores:

- `LIONPOCKET_ANDROID_KEYSTORE_BASE64`
- `LIONPOCKET_ANDROID_STORE_PASSWORD`
- `LIONPOCKET_ANDROID_KEY_ALIAS`
- `LIONPOCKET_ANDROID_KEY_PASSWORD`
- `LIONPOCKET_ANDROID_CERTIFICATE_SHA256`

A CI materializa o keystore somente no diretório temporário do runner. Builds normais de produção recusam assinatura ausente, certificado debug e fingerprint divergente.

## 3. Primeira migração de instalações antigas

As instalações anteriores à v0.3.11 podem estar assinadas pela chave pública de desenvolvimento. Android recusa `adb install -r`/instalação por cima quando o package ID é igual e o certificado muda.

Antes de desinstalar uma instalação antiga que contenha dados:

1. em **Dados locais**, salve um backup SQLite em arquivo externo;
2. se já usa sync, guarde também código de recuperação, convite e URL do servidor, ou mantenha outro aparelho autorizado;
3. confira que o arquivo externo está acessível;
4. desinstale o app antigo;
5. instale o APK de produção v0.3.11;
6. restaure o SQLite por **Dados locais → Escolher arquivo local**;
7. reconfigure/repareie a sincronização.

O restore local desabilita transporte restaurado para não reutilizar secrets removidos com o Android Keystore antigo.

Depois dessa migração única, releases futuras assinadas pela mesma identidade podem atualizar normalmente.

## 4. Publicar uma release

O workflow público é propositalmente manual e só aceita `main`.

Exemplo para v0.3.11:

```sh
gh workflow run publish-release.yml \
  --repo Pianisuto/LionPocket \
  --ref main \
  -f version=0.3.11 \
  -f 'confirm=PUBLICAR v0.3.11'
```

Acompanhe:

```sh
gh run watch --repo Pianisuto/LionPocket
```

O workflow:

- revalida suíte/versão;
- constrói Linux e Windows normais;
- constrói e verifica o APK com a identidade permanente;
- publica checksums e manifest;
- cria a tag e GitHub Release no SHA exato de `main`.

A tag da release é também a versão oficial do servidor self-hosted. O servidor é instalado a partir do source archive/tag e compila a imagem da API localmente.
