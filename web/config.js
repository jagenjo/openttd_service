// Configuración del cliente web de OpenTTD (se carga antes del juego).
(function () {
  const GAME_PORT = 3979;
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  // El servidor web expone en /ws un puente WebSocket -> TCP hacia el servidor de juego.
  const proxyUrl = `${wsProto}://${location.host}/ws`;

  window.openttd_websocket_url = function (host, port, proto) {
    if (proto === 'tcp' && port === GAME_PORT) return proxyUrl;
    return null; // resto (servidor de contenidos, etc.): comportamiento por defecto
  };

  // Aparece en la lista de servidores del juego.
  window.openttd_servers = [`${location.hostname}:${GAME_PORT}`];
})();
