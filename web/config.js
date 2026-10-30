// Configuración del cliente web de OpenTTD (se carga antes del juego).
// El servidor web antepone `window.openttd_user` (el usuario con sesión abierta) y `window.openttd_join_company`.
(function () {
  const GAME_PORT = 3979;
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  // El servidor web expone en /ws un puente WebSocket -> TCP hacia el servidor de juego.
  const proxyUrl = `${wsProto}://${location.host}/ws`;

  window.openttd_websocket_url = function (host, port, proto) {
    if (proto === 'tcp' && port === GAME_PORT) return proxyUrl;
    return null; // resto: comportamiento por defecto
  };

  // Sin menú principal: el juego se conecta directamente al servidor al arrancar.
  // openttd_join_company = 255 (espectador) si la cuenta ya tiene empresa: el servidor la mueve a ella.
  const company = window.openttd_join_company == null ? '' : `#${window.openttd_join_company}`;
  window.openttd_extra_args = ['-n', `${location.hostname}:${GAME_PORT}${company}`];

  // El juego llama a esto cuando se sale de la partida (desconexión, expulsión, "Desconectar").
  window.openttd_disconnected = function () {
    if (document.getElementById('disconnected')) return;
    const d = document.createElement('div');
    d.id = 'disconnected';
    d.style.cssText = 'position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:#2a3a4a';
    d.innerHTML = '<div style="background:#838383;border:1px solid #a8a8a8;outline:1px solid #626262;width:320px;font:14px Tahoma,Arial,sans-serif;color:#101010">' +
      '<div style="background:#4a6a8a;color:#fff;padding:4px 8px;text-shadow:1px 1px #101010">OpenTTD</div>' +
      '<p style="margin:12px">Desconectado del servidor.</p>' +
      '<div style="display:flex;gap:8px;margin:0 12px 12px">' +
      '<button id="d-again" style="flex:1;padding:6px">Volver a entrar</button>' +
      '<button id="d-out" style="flex:1;padding:6px">Cerrar sesión</button></div></div>';
    document.body.appendChild(d);
    document.getElementById('d-again').onclick = () => location.reload();
    document.getElementById('d-out').onclick = () =>
      fetch('/auth/logout', { method: 'POST' }).finally(() => (location.href = '/login'));
  };
})();
