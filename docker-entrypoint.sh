#!/bin/sh
set -e
cd /app
mkdir -p runtime/server/baseset
[ -n "$(ls -A runtime/server/baseset 2>/dev/null)" ] || cp -rL /opt/baseset/. runtime/server/baseset/
cd webserver
exec node server.js
