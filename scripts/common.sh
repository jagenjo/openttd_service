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
