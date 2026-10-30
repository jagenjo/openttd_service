#!/usr/bin/env bash
# Compila el servidor dedicado (sin gráficos ni sonido).
# Dependencias Ubuntu: scripts/install-deps-ubuntu.sh (GCC >= 12)
source "$(dirname "$0")/common.sh"
"$ROOT/scripts/fetch-source.sh"
apply_patches
mkdir -p "$BUILD_DIR/server"
reset_cmake_cache "$BUILD_DIR/server"
cmake -S "$SRC_DIR" -B "$BUILD_DIR/server" \
  -DOPTION_DEDICATED=ON -DCMAKE_BUILD_TYPE=Release -DOPTION_USE_ASSERTS=OFF
cmake --build "$BUILD_DIR/server" -j "$JOBS"
echo "Servidor compilado: $BUILD_DIR/server/openttd"
