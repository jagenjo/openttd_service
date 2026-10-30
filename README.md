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
web/config.js          Config del cliente web: proxy /ws y servidor en la lista
webserver/             Node: sirve el cliente, puente WebSocket→TCP y panel /admin
scripts/               Compilación y arranque
build/, vendor/, runtime/   Generados (ignorados por git)
```

## Puesta en marcha (local)

Requisitos: compilador C++, CMake, git, curl, unzip, Node ≥ 18 y las librerías
zlib, liblzma y lzo. En Ubuntu: `scripts/install-deps-ubuntu.sh`. En macOS:
`brew install cmake xz lzo libpng node` (OpenGFX se descarga solo).

```bash
scripts/build-server.sh     # servidor dedicado (~5-10 min)
scripts/build-web.sh        # cliente WASM; instala emsdk la primera vez (~15 min)
scripts/start.sh            # arranca todo en http://localhost:8080
```

- Cliente web: <http://localhost:8080/> → *Multiplayer* → el servidor aparece en la lista → *Join game*.
- Panel: <http://localhost:8080/admin>. Usuario cualquiera; la contraseña se
  genera en `runtime/admin-password.txt` (o define `ADMIN_PASSWORD`).
- Los clientes de escritorio de OpenTTD 15.3 también pueden conectarse a `host:3979`.

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

OpenTTD no tiene cuentas de usuario. El panel ofrece:
- **Contraseña del servidor** (la piden todos los clientes).
- **Lista de jugadores**: si está activada, se expulsa a quien se conecte con un
  nombre que no esté en la lista (control por nombre, no es autenticación fuerte).
- Las empresas se protegen solas: en OpenTTD 15 solo quien la fundó (y quien
  esa persona autorice) puede entrar en ella.

## Despliegue en Ubuntu (más adelante)

1. `scripts/install-deps-ubuntu.sh`, `build-server.sh`, `build-web.sh`.
2. Ejecutar `scripts/start.sh` como servicio systemd.
3. Poner nginx/caddy con HTTPS delante del puerto 8080 (incluido `/ws` con
   cabeceras `Upgrade`). Con HTTPS el cliente usa `wss://` automáticamente.
4. Abrir el puerto TCP/UDP 3979 si se quiere admitir clientes de escritorio.
