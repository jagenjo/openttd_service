#!/usr/bin/env bash
# Arranca el servicio: cliente web, puente WebSocket y panel de administración.
# El panel lanza y detiene el servidor de OpenTTD.
# Variables opcionales: HTTP_PORT (8080), ADMIN_PASSWORD, GAME_AUTOSTART=0.
source "$(dirname "$0")/common.sh"
[ -x "$BUILD_DIR/server/openttd" ] || { echo "Falta el servidor: ejecuta scripts/build-server.sh" >&2; exit 1; }
[ -f "$BUILD_DIR/www/play/index.html" ] || echo "Aviso: falta el cliente web (scripts/build-web.sh); el panel funciona igual." >&2
"$ROOT/scripts/fetch-opengfx.sh"
cd "$ROOT/webserver"
[ -d node_modules ] || npm install --omit=dev
exec node server.js
