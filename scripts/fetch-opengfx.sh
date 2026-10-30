#!/usr/bin/env bash
# Prepara OpenGFX (gráficos base libres; el servidor dedicado también los necesita).
# Usa el paquete de Ubuntu si está instalado (sudo apt install openttd-opengfx);
# si no, lo descarga de cdn.openttd.org.
source "$(dirname "$0")/common.sh"
DEST="$RUNTIME_DIR/server/baseset"
SYSTEM=/usr/share/games/openttd/baseset/opengfx
if [ -e "$DEST/opengfx" ] || ls "$DEST"/opengfx-*.tar >/dev/null 2>&1; then exit 0; fi
mkdir -p "$DEST"
if [ -d "$SYSTEM" ]; then
  ln -s "$SYSTEM" "$DEST/opengfx"
  exit 0
fi
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/opengfx.zip" \
  "https://cdn.openttd.org/opengfx-releases/$OPENGFX_VERSION/opengfx-$OPENGFX_VERSION-all.zip"
unzip -q -o "$TMP/opengfx.zip" -d "$DEST"
rm -rf "$TMP"
