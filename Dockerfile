# syntax=docker/dockerfile:1
# Servidor dedicado + cliente WASM + puente/panel Node, todo en una imagen.
# La primera construcción es larga (compila OpenTTD dos veces y descarga emsdk).

FROM ubuntu:24.04 AS builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git curl unzip python3 xz-utils ca-certificates \
      zlib1g-dev liblzma-dev liblzo2-dev libpng-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY versions.env ./
COPY scripts ./scripts
COPY patches ./patches
COPY web ./web
COPY server ./server
RUN scripts/build-server.sh
RUN scripts/build-web.sh

FROM node:22-bookworm-slim
ENV NODE_ENV=production HTTP_PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends \
      zlib1g liblzma5 liblzo2-2 libpng16-16 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY webserver/package.json ./webserver/
RUN cd webserver && npm install --omit=dev
COPY webserver ./webserver
COPY server ./server
COPY --from=builder /app/build/server/openttd ./build/server/openttd
COPY --from=builder /app/build/www ./build/www
# OpenGFX descargado durante la compilación; se copia al volumen si falta.
COPY --from=builder /app/runtime/server/baseset /opt/baseset
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p runtime && chown -R node:node /app
USER node
VOLUME /app/runtime
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
