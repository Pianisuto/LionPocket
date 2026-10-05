#!/usr/bin/env bash
set -euo pipefail
umask 077

destination="${1:-$HOME/.local/share/lionpocket-signing}"
store="$destination/lionpocket-production.p12"
properties="$destination/android-signing.properties"
alias_name="lionpocket"

command -v keytool >/dev/null 2>&1 || { echo "keytool não encontrado. Instale/use um JDK 21 completo." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 não encontrado." >&2; exit 1; }

mkdir -p "$destination"
chmod 700 "$destination"
if [[ -e "$store" || -e "$properties" ]]; then
  echo "A identidade de produção já existe em $destination. Nada foi sobrescrito." >&2
  exit 1
fi

password="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"
export LP_STORE_PASS="$password" LP_KEY_PASS="$password"

keytool -genkeypair   -alias "$alias_name"   -keyalg RSA   -keysize 4096   -sigalg SHA256withRSA   -validity 10000   -storetype PKCS12   -keystore "$store"   -storepass:env LP_STORE_PASS   -keypass:env LP_KEY_PASS   -dname "CN=LionPocket, OU=Mobile, O=LionPocket, C=BR"   -noprompt >/dev/null

fingerprint="$(
  keytool -list -v     -keystore "$store"     -alias "$alias_name"     -storepass:env LP_STORE_PASS     -J-Duser.language=en -J-Duser.country=US |
  sed -n 's/^[[:space:]]*SHA256: //p' |
  head -n 1 |
  tr -d ':' |
  tr '[:upper:]' '[:lower:]'
)"
[[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || { echo "Não foi possível obter o SHA-256 do certificado." >&2; rm -f "$store"; exit 1; }

cat > "$properties" <<EOF
storeFile=$store
storePassword=$password
keyAlias=$alias_name
keyPassword=$password
certificateSha256=$fingerprint
EOF
chmod 600 "$store" "$properties"
unset LP_STORE_PASS LP_KEY_PASS password

echo "Identidade Android permanente criada."
echo "Keystore: $store"
echo "Configuração privada: $properties"
echo "Certificado SHA-256: $fingerprint"
echo
echo "FAÇA BACKUP DOS DOIS ARQUIVOS EM OUTRO LOCAL SEGURO."
echo "Perder esta chave impede atualizar instalações Android assinadas por ela."
