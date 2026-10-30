#!/usr/bin/env bash
# Variables compartidas por todos los scripts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../versions.env
source "$ROOT/versions.env"
SRC_DIR="$ROOT/vendor/openttd-$OPENTTD_VERSION"
BUILD_DIR="$ROOT/build"
RUNTIME_DIR="$ROOT/runtime"
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

# OpenTTD 15 necesita C++20 completo: GCC >= 12 (Ubuntu 22.04 trae GCC 11 por defecto).
if [ -z "${CXX:-}" ] && command -v g++ >/dev/null; then
  if [ "$(g++ -dumpversion | cut -d. -f1)" -lt 12 ]; then
    for v in 14 13 12; do
      if command -v "g++-$v" >/dev/null; then export CC="gcc-$v" CXX="g++-$v"; break; fi
    done
    if [ -z "${CXX:-}" ]; then
      echo "Tu GCC es $(g++ -dumpversion) y OpenTTD necesita GCC 12 o superior." >&2
      echo "Instálalo con: sudo apt install g++-12" >&2
      exit 1
    fi
  fi
fi

# Si la caché de CMake se creó con otro compilador, se borra para reconfigurar.
reset_cmake_cache() {
  local dir="$1" cached
  [ -f "$dir/CMakeCache.txt" ] || return 0
  cached="$(sed -n 's/^CMAKE_CXX_COMPILER:[A-Z]*=//p' "$dir/CMakeCache.txt")"
  if [ -n "${CXX:-}" ] && [ "$(command -v "$CXX")" != "$cached" ]; then
    echo "Compilador cambiado ($cached -> $CXX): reconfigurando $dir"
    rm -rf "$dir/CMakeCache.txt" "$dir/CMakeFiles"
  fi
}
