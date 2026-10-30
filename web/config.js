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

  // Se oculta el aviso "las partidas se guardan en el IndexedDB del navegador": aquí el juego
  // es siempre el del servidor y no se guardan partidas en el navegador.
  const style = document.createElement('style');
  style.textContent = '#overlay, #filesystem { display: none !important; }';
  document.head.appendChild(style);

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

  // Contador de acciones (construir/destruir). El juego lo dibuja en su barra de estado, junto al
  // dinero (parche statusbar_gui.cpp); se le pasa el texto con em_openttd_set_actions().
  window.openttd_actions_text = '';
  window.openttd_actions_zero = false;
  let me = null;
  function draw() {
    if (!me || me.actions === null) {
      window.openttd_actions_text = '';
      return;
    }
    const min = Math.max(0, Math.round((me.nextRestore - Date.now()) / 60000));
    window.openttd_actions_text = `ACTIONS ${me.actions}/${me.max}  RESET ${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
    window.openttd_actions_zero = me.actions === 0;
  }
  // Se lo pasamos al juego (barra de estado) en cuanto está arrancado.
  let setActions = null;
  function pushToGame() {
    try {
      setActions ??= window.Module && Module.cwrap ? Module.cwrap('em_openttd_set_actions', null, ['string', 'number']) : null;
      if (setActions) setActions(window.openttd_actions_text, window.openttd_actions_zero ? 1 : 0);
    } catch { setActions = null; /* el juego aún no está listo */ }
  }
  setInterval(pushToGame, 500);
  async function poll() {
    try {
      const r = await fetch('/auth/me', { cache: 'no-store' });
      if (r.ok) me = await r.json();
    } catch { /* sin red: se mantiene el último valor */ }
    draw();
  }
  poll();
  setInterval(poll, 3000);
  setInterval(draw, 30000);
})();
