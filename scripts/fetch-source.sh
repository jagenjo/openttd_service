#!/usr/bin/env bash
# Descarga el código fuente de OpenTTD (tag fijado en versions.env).
source "$(dirname "$0")/common.sh"
if [ -d "$SRC_DIR/.git" ]; then
  echo "Fuente ya presente en $SRC_DIR"
  exit 0
fi
mkdir -p "$ROOT/vendor"
git -c advice.detachedHead=false clone --depth 1 --branch "$OPENTTD_VERSION" \
  https://github.com/OpenTTD/OpenTTD.git "$SRC_DIR"
