#!/usr/bin/env bash
# Compila el cliente WebAssembly a partir del MISMO código fuente que el servidor.
# Instala emsdk en vendor/emsdk la primera vez (versión fijada en versions.env).
source "$(dirname "$0")/common.sh"
"$ROOT/scripts/fetch-source.sh"

EMSDK="$ROOT/vendor/emsdk"
if [ ! -d "$EMSDK" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK"
fi
"$EMSDK/emsdk" install "$EMSDK_VERSION"
"$EMSDK/emsdk" activate "$EMSDK_VERSION" >/dev/null
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
# Port de liblzma que OpenTTD necesita y emscripten no trae.
cp "$SRC_DIR/os/emscripten/ports/liblzma.py" "$EMSDK/upstream/emscripten/tools/ports/contrib/liblzma.py"

# Parches (cliente web sin menú, límite de acciones...). Idempotente.
apply_patches

# 1) Herramientas nativas que se usan durante la compilación (strgen, settingsgen...).
reset_cmake_cache "$BUILD_DIR/web-host"
cmake -S "$SRC_DIR" -B "$BUILD_DIR/web-host" -DOPTION_TOOLS_ONLY=ON
cmake --build "$BUILD_DIR/web-host" -j "$JOBS" --target tools

# 2) El juego en WASM.
emcmake cmake -S "$SRC_DIR" -B "$BUILD_DIR/web" \
  -DHOST_BINARY_DIR="$BUILD_DIR/web-host" -DCMAKE_BUILD_TYPE=Release -DOPTION_USE_ASSERTS=OFF
# OpenGFX va empaquetado en openttd.data: el navegador no tiene que descargar
# gráficos del servidor de contenidos de OpenTTD antes de jugar.
"$ROOT/scripts/fetch-opengfx.sh"
rm -rf "$BUILD_DIR/web/baseset/opengfx" && mkdir -p "$BUILD_DIR/web/baseset/opengfx"
# Solo .grf/.obg (el paquete de Ubuntu trae enlaces rotos a la documentación).
find -L "$RUNTIME_DIR/server/baseset" -type f \( -name '*.grf' -o -name '*.obg' -o -name '*.tar' \) \
  -exec cp {} "$BUILD_DIR/web/baseset/opengfx/" \;
rm -f "$BUILD_DIR"/web/openttd.{js,html,wasm,data}  # fuerza el reenlazado y el reempaquetado de openttd.data
emmake make -C "$BUILD_DIR/web" -j "$JOBS"

# 3) Empaquetar en build/www: intro y login en la raíz, el juego en play/.
OUT="$BUILD_DIR/www"
rm -rf "$OUT" && mkdir -p "$OUT/play"
cp "$BUILD_DIR/web"/openttd.{html,js,wasm,data} "$OUT/play/"
cp "$ROOT/web/config.js" "$OUT/play/config.js"
cp "$ROOT/web/intro.html" "$OUT/index.html"
cp "$ROOT/web/login.html" "$OUT/login.html"
sed 's|<head>|<head><script src="config.js"></script>|' "$OUT/play/openttd.html" > "$OUT/play/index.html"
rm "$OUT/play/openttd.html"
echo "Cliente web listo en $OUT"
