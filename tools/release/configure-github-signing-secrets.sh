#!/usr/bin/env bash
set -euo pipefail
umask 077

properties="${1:-$HOME/.local/share/lionpocket-signing/android-signing.properties}"
repo="${2:-Pianisuto/LionPocket}"

command -v gh >/dev/null 2>&1 || { echo "GitHub CLI (gh) não encontrado." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Faça login primeiro com: gh auth login" >&2; exit 1; }
[[ -f "$properties" ]] || { echo "Arquivo de assinatura não encontrado: $properties" >&2; exit 1; }

read_property() {
  local key="$1"
  sed -n "s/^$key=//p" "$properties" | head -n 1
}

store_file="$(read_property storeFile)"
store_password="$(read_property storePassword)"
key_alias="$(read_property keyAlias)"
key_password="$(read_property keyPassword)"
certificate="$(read_property certificateSha256)"

[[ -f "$store_file" ]] || { echo "Keystore não encontrado: $store_file" >&2; exit 1; }
[[ -n "$store_password" && -n "$key_alias" && -n "$key_password" && "$certificate" =~ ^[0-9a-fA-F]{64}$ ]] || {
  echo "Arquivo de assinatura incompleto." >&2
  exit 1
}

base64 -w 0 "$store_file" | gh secret set LIONPOCKET_ANDROID_KEYSTORE_BASE64 --repo "$repo"
printf '%s' "$store_password" | gh secret set LIONPOCKET_ANDROID_STORE_PASSWORD --repo "$repo"
printf '%s' "$key_alias" | gh secret set LIONPOCKET_ANDROID_KEY_ALIAS --repo "$repo"
printf '%s' "$key_password" | gh secret set LIONPOCKET_ANDROID_KEY_PASSWORD --repo "$repo"
printf '%s' "$certificate" | gh secret set LIONPOCKET_ANDROID_CERTIFICATE_SHA256 --repo "$repo"

unset store_password key_password
echo "Secrets de assinatura configurados no GitHub para $repo."
echo "Nenhum valor secreto foi impresso."
