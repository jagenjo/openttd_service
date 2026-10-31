# OpenTTD Slow Time

Servidor de OpenTTD donde **un año de juego dura un día real**, con cliente web
(WebAssembly) para jugar desde el navegador y panel de administración en HTML.

- El juego va a velocidad normal (vehículos, producción, ingresos por viaje);
  solo el **calendario** avanza más despacio. Se usa el modo de tiempo
  *wallclock* de OpenTTD (≥ 14) con `minutes_per_calendar_year = 1440`, sin
  parches al motor.
- Servidor y cliente web se compilan del **mismo tag** (`versions.env`), así que
  siempre son compatibles.

## Estructura

```
versions.env           Versiones fijadas (OpenTTD, emsdk, OpenGFX)
server/openttd.cfg     Plantilla de configuración del servidor
patches/               Parche del cliente web (hooks para config.js)
web/                   Config del cliente web (config.js) y pantalla de acceso (login.html)
webserver/             Node: sirve el cliente, puente WebSocket→TCP y panel /admin
scripts/               Compilación y arranque
build/, vendor/, runtime/   Generados (ignorados por git)
```

## Puesta en marcha (local)

Requisitos: GCC ≥ 12 (o Clang con C++20), CMake, git, curl, unzip, Node ≥ 18 y las librerías
zlib, liblzma y lzo. En Ubuntu: `scripts/install-deps-ubuntu.sh`. En macOS:
`brew install cmake xz lzo libpng node` (OpenGFX se descarga solo).

**Windows:** usa WSL (Ubuntu). Compila mucho más rápido si el repo está dentro
de WSL (`~/openTTD_service`) que en `/mnt/c` o `/mnt/f`.

```bash
scripts/build-server.sh     # servidor dedicado (~5-10 min)
scripts/build-web.sh        # cliente WASM; instala emsdk la primera vez (~15 min)
scripts/start.sh            # arranca todo en http://localhost:8080
```

- Inicio: <http://localhost:8080/> — página pública con el mapa (arrastrar y zoom), jugadores
  conectados y registrados, clasificación de empresas y estadísticas (`/info.json`, `/map.png`).
- Juego: <http://localhost:8080/play/> → pantalla de usuario/contraseña → entra directamente a la partida del servidor (no hay menú principal).
- Antes hay que crear cuentas en el panel (sección *Cuentas de jugador*).
- Panel: <http://localhost:8080/admin>. Usuario cualquiera; la contraseña se
  genera en `runtime/admin-password.txt` (o define `ADMIN_PASSWORD`).
- El puerto del juego (3979) solo escucha en `127.0.0.1`: se juega únicamente por el cliente web. `GAME_PUBLIC=1` lo abre, pero los clientes que no vengan del puente web son expulsados.

En el panel: **Nueva partida** genera un mapa con la configuración guardada.
Al detener el servidor se guarda `last.sav`, y al arrancar `start.sh` se reanuda
automáticamente (`GAME_AUTOSTART=0` para desactivarlo).

## Cómo funciona el tiempo

| Ajuste | Valor | Efecto |
|---|---|---|
| `timekeeping_units` | 1 (wallclock) | Economía en periodos fijos de 12 min reales |
| `minutes_per_calendar_year` | 1440 | 1 año de calendario = 24 h reales (1 día ≈ 4 min) |
| `inflation` | false | La inflación va por periodo económico; con años de 1 día sería excesiva |

Los gráficos y la cuenta de resultados se muestran por **periodo** (12 min) en lugar
de por año. Los ingresos por viaje no cambian, porque los vehículos se mueven a la
velocidad normal. Lo que cambia es que pasan muchas más horas de juego por cada año
del calendario, por lo que las tecnologías nuevas tardan mucho más en aparecer.

## Jugadores

OpenTTD no tiene cuentas de usuario, así que las gestiona el servidor web
(`runtime/users.json`, contraseñas con scrypt):
- El navegador solo recibe el juego tras iniciar sesión (cookie `HttpOnly`); el puente `/ws` también la exige.
- El **nombre de usuario es el nombre del jugador** en el juego. El cliente WASM está parcheado
  (`patches/web-client.patch`): sin menú principal, se conecta solo al servidor y, si se sale de la
  partida, muestra "Desconectado" en lugar del menú.
- El protocolo de OpenTTD va cifrado, así que el puente no puede leer el nombre: cada pocos
  segundos el servidor expulsa a quien juegue con un nombre que no sea el de un usuario con sesión
  abierta (evita suplantar a otra cuenta cambiándose el nombre).
- Cada cuenta tiene **su empresa**: la primera que funda el jugador se vincula a su cuenta
  (`runtime/users.json`) y en las siguientes entradas el servidor lo mueve a ella (entra como
  espectador y se le traslada en ≤ 2 s); nunca entra en la de otro. Si la empresa desaparece
  (quiebra), se desvincula y la siguiente entrada crea una nueva.
- **Acciones:** cada vez que un jugador construye o destruye algo en el mapa (cualquier orden de
  construcción de terreno: vías, carreteras, estaciones, terraformar, árboles, demoler…) gasta una
  acción; comprar vehículos no cuenta. Sin acciones, el servidor rechaza la orden y avisa por chat.
  Todos los días a las 0:00 (hora local del servidor) llega el *ACTIONS RESTORE* y se recuperan
  todas. Se configuran en el panel (*Acciones por día*, 0 = sin límite) y el jugador ve el
  contador en la barra de estado del juego, junto al dinero. El límite está en el propio servidor de juego
  (`patches/service-server.patch`), por eso `build-server.sh` también aplica parches.
- **Factor de ingresos:** todo lo que se cobra por entregar carga se multiplica por un factor
  (0,5 por defecto; ajustable en el panel, también con la partida en marcha). Es un ajuste real de
  la partida (`economy.income_percent`, en la partida guardada y propagado a los clientes), no un
  parche solo del servidor, para que todos calculen lo mismo (`patches/service-income.patch`).
- **Mapa:** el panel (y la página de inicio) muestra el mapa (un píxel por casilla: color de empresa, blanco = estaciones,
  negro = industrias), regenerado cada hora y al cargar una partida. Lo vuelca el servidor de juego
  con el comando de consola `dump_map` y lo convierte en PNG `webserver/gamemap.js`.
- Las cuentas se crean, cambian y borran en el panel de administración.
- Las empresas se protegen solas: en OpenTTD 15 solo quien la fundó (y quien
  esa persona autorice) puede entrar en ella.

## Docker

```bash
ADMIN_PASSWORD=algo-secreto docker compose up -d --build   # http://localhost:8080
```

La primera construcción es larga (compila OpenTTD dos veces y descarga emsdk). Partidas, cuentas, chat y
ajustes se guardan en `./runtime` (volumen). Al parar el contenedor se guarda la partida y se retoma al
arrancar. Puerto alternativo: `HTTP_PORT=9000 docker compose up -d`.

## Despliegue en Ubuntu (más adelante)

1. `scripts/install-deps-ubuntu.sh`, `build-server.sh`, `build-web.sh`.
2. Ejecutar `scripts/start.sh` como servicio systemd.
3. Poner nginx/caddy con HTTPS delante del puerto 8080 (incluido `/ws` con
   cabeceras `Upgrade`). Con HTTPS el cliente usa `wss://` automáticamente.
4. Abrir el puerto TCP/UDP 3979 si se quiere admitir clientes de escritorio.
