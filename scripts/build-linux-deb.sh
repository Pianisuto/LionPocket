#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$project_dir/out/LionPocket-linux-x64"
output_dir="$project_dir/out/make/deb/x64"
version="$(node -p "require('$project_dir/package.json').version")"
package_path="$output_dir/lionpocket_${version}_amd64.deb"
stage_dir="$(mktemp -d)"

cleanup() {
  rm -rf -- "$stage_dir"
}
trap cleanup EXIT

if [[ ! -x "$app_dir/lionpocket" ]]; then
  echo "Aplicativo empacotado não encontrado em: $app_dir" >&2
  exit 1
fi

mkdir -p \
  "$stage_dir/DEBIAN" \
  "$stage_dir/opt/LionPocket" \
  "$stage_dir/usr/bin" \
  "$stage_dir/usr/share/applications" \
  "$stage_dir/usr/share/icons/hicolor/512x512/apps" \
  "$output_dir"

cp -a "$app_dir/." "$stage_dir/opt/LionPocket/"
chmod 0755 "$stage_dir/opt/LionPocket"
chmod 4755 "$stage_dir/opt/LionPocket/chrome-sandbox"
ln -s /opt/LionPocket/lionpocket "$stage_dir/usr/bin/lionpocket"
install -m 0644 "$project_dir/assets/icon.png" \
  "$stage_dir/usr/share/icons/hicolor/512x512/apps/lionpocket.png"

cat > "$stage_dir/DEBIAN/control" <<EOF
Package: lionpocket
Version: $version
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Pianisuto
Installed-Size: $(du -sk "$stage_dir/opt/LionPocket" | cut -f1)
Depends: libgtk-3-0, libnss3, libxss1, libasound2t64 | libasound2, libgbm1
Description: Finanças pessoais simples, locais e bonitas
 LionPocket organiza entradas, despesas, parcelas e objetivos sem precisar de internet.
EOF

cat > "$stage_dir/usr/share/applications/lionpocket.desktop" <<'EOF'
[Desktop Entry]
Name=LionPocket
GenericName=Finanças pessoais
Comment=Organize suas finanças pessoais
Exec=lionpocket
Icon=lionpocket
Terminal=false
Type=Application
Categories=Office;Finance;
StartupWMClass=LionPocket
EOF

# Instalações anteriores feitas à mão ficavam em ~/.local e o atalho de lá tem
# precedência sobre o do sistema: sem remover, o menu continua abrindo a versão
# velha por mais que o pacote novo seja instalado. Só os caminhos exatos da
# instalação antiga são apagados — ~/.config, onde mora o banco, não é tocado.
cat > "$stage_dir/DEBIAN/preinst" <<'EOF'
#!/bin/sh
set -e

for home in /home/*; do
  [ -d "$home" ] || continue
  rm -rf "$home/.local/opt/lionpocket" 2>/dev/null || true
  rm -f "$home/.local/share/applications/lionpocket.desktop" 2>/dev/null || true
  rm -f "$home/.local/share/icons/hicolor/"*"/apps/lionpocket.png" 2>/dev/null || true
done

exit 0
EOF

# Sem isto o app demora a aparecer na busca do sistema: o índice de atalhos e o
# cache de ícones continuam com o estado anterior até algo mais os regenerar.
cat > "$stage_dir/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e

update-desktop-database /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true

exit 0
EOF

cat > "$stage_dir/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e

update-desktop-database /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true

exit 0
EOF

chmod 0755 "$stage_dir/DEBIAN"
chmod 0644 "$stage_dir/DEBIAN/control"
chmod 0755 "$stage_dir/DEBIAN/preinst" "$stage_dir/DEBIAN/postinst" "$stage_dir/DEBIAN/postrm"
chmod 0644 "$stage_dir/usr/share/applications/lionpocket.desktop"
dpkg-deb --root-owner-group --build "$stage_dir" "$package_path"

echo "Instalador criado em: $package_path"
