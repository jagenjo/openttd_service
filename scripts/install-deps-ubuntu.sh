#!/usr/bin/env bash
# Dependencias para compilar y ejecutar en Ubuntu (22.04/24.04).
set -euo pipefail
sudo apt-get update
sudo apt-get install -y build-essential g++-12 cmake git curl unzip python3 xz-utils \
  zlib1g-dev liblzma-dev liblzo2-dev libpng-dev openttd-opengfx nodejs npm
