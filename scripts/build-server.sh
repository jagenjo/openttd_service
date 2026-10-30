#!/usr/bin/env bash
# Compila el servidor dedicado (sin gráficos ni sonido).
# Dependencias Ubuntu: sudo apt install build-essential cmake git zlib1g-dev liblzma-dev liblzo2-dev
source "$(dirname "$0")/common.sh"
"$ROOT/scripts/fetch-source.sh"
mkdir -p "$BUILD_DIR/server"
cmake -S "$SRC_DIR" -B "$BUILD_DIR/server" \
  -DOPTION_DEDICATED=ON -DCMAKE_BUILD_TYPE=Release -DOPTION_USE_ASSERTS=OFF
cmake --build "$BUILD_DIR/server" -j "$JOBS"
echo "Servidor compilado: $BUILD_DIR/server/openttd"
