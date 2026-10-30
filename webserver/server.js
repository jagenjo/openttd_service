// Servidor web: sirve el cliente WASM y hace de puente WebSocket -> TCP
// hacia el servidor de juego, todo en el mismo origen (/ws).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import { Users } from './users.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = process.env.WWW_DIR || path.join(ROOT, 'build', 'www');
const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);
const GAME_HOST = process.env.GAME_HOST || '127.0.0.1';
const GAME_PORT = Number(process.env.GAME_PORT || 3979);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

// --- Cuentas y sesiones --------------------------------------------------------

const users = new Users(path.join(ROOT, 'runtime', 'users.json'));
const COOKIE = 'ottd_session';

function sessionToken(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`));
  return m ? m[1] : null;
}
const currentUser = (req) => users.session(sessionToken(req));
const clientIp = (req) => req.socket.remoteAddress || '';

// Jugadores con una conexión abierta al juego a través del puente: nombre en minúsculas -> WebSocket.
const bridged = new Map();
async function handleAuth(req, res, pathname) {
  const json = (code, body, headers = {}) =>
    res.writeHead(code, { 'Content-Type': MIME['.json'], ...headers }).end(JSON.stringify(body));
  if (pathname === '/auth/login' && req.method === 'POST') {
    try {
      const b = await readJson(req);
      const token = users.login(b.user, b.password, clientIp(req));
      const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
      json(200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}` });
    } catch (e) {
      json(401, { error: e.message });
    }
  } else if (pathname === '/auth/me' && req.method === 'GET') {
    // Datos para el contador de acciones que se muestra sobre el juego.
    const user = currentUser(req);
    if (!user) return json(401, { error: 'Login required' });
    const max = game.settings.actions_per_day;
    json(200, { user, max: max > 0 ? max : null, actions: game.actionsLeft(user), nextRestore: game.nextRestore() }, { 'Cache-Control': 'no-store' });
  } else if (pathname === '/auth/logout' && req.method === 'POST') {
    users.logout(sessionToken(req));
    json(200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  } else {
    res.writeHead(404).end();
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/login') rel = '/login.html';
  if (rel.endsWith('/')) rel += 'index.html';
  // Solo la pantalla de acceso es pública: el juego (y su puente) exigen sesión.
  const user = currentUser(req);
  if (!user && rel !== '/login.html') {
    if (rel === '/index.html') res.writeHead(302, { Location: '/login' }).end();
    else res.writeHead(401).end('Login required');
    return;
  }
  if (user && rel === '/login.html') {
    res.writeHead(302, { Location: '/' }).end();
    return;
  }
  const file = path.join(WWW, path.normalize(rel));
  if (!file.startsWith(WWW + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  if (rel === '/config.js') {
    // Se añade el usuario de la sesión: el juego lo usa como nombre de jugador.
    fs.readFile(file, 'utf8', (err, text) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      // Con empresa propia se entra de espectador y el servidor mueve al jugador a ella
      // (si no, el juego crearía una empresa nueva en cada entrada).
      const spectate = user && users.companyOf(user) !== null && game.companies.some((c) => c.id === users.companyOf(user));
      res.end(`window.openttd_user = ${JSON.stringify(user)};\nwindow.openttd_join_company = ${spectate ? 255 : 'null'};\n${text}`);
    });
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    // Todo se revalida (Last-Modified): tras recompilar, un wasm/data en caché con un openttd.js
    // nuevo hace que el juego se cuelgue al arrancar.
    const lastModified = st.mtime.toUTCString();
    if (req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Last-Modified': lastModified,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// --- Panel de administración -------------------------------------------------

const ADMIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin');
const PASS_FILE = path.join(ROOT, 'runtime', 'admin-password.txt');
fs.mkdirSync(path.dirname(PASS_FILE), { recursive: true });
let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  if (!fs.existsSync(PASS_FILE)) {
    fs.writeFileSync(PASS_FILE, crypto.randomBytes(12).toString('base64url') + '\n', { mode: 0o600 });
  }
  adminPassword = fs.readFileSync(PASS_FILE, 'utf8').trim();
}

function authorized(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !token) return false;
  const pass = Buffer.from(token, 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass);
  const b = Buffer.from(adminPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const game = new Game({
  root: ROOT,
  players: {
    isAllowed: (name) => bridged.has(name.toLowerCase()),
    accounts: () => users.list(),
    companyOf: (name) => users.companyOf(name),
    ownerOf: (id) => users.ownerOf(id),
    setCompany: (name, id) => users.setCompany(name, id),
    actionsOf: (name) => users.actionsOf(name),
    setActions: (name, n) => users.setActions(name, n),
    restoreAllActions: () => users.restoreAllActions(),
  },
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const api = {
  'GET /api/status': async () => game.status(),
  'GET /api/log': async () => ({ log: game.log }),
  'POST /api/settings': async (b) => ({ settings: game.saveSettings(b) }),
  'POST /api/start': async (b) => game.start(b.save),
  'POST /api/stop': async () => game.stop(),
  'POST /api/newgame': async () => {
    await game.stop();
    game.start();
  },
  'POST /api/save': async (b) => game.command(`save "${String(b.name || 'manual').replace(/[^\w.-]/g, '_')}"`, 20000),
  'POST /api/pause': async () => game.command('pause'),
  'POST /api/unpause': async () => game.command('unpause'),
  'POST /api/say': async (b) => game.command(`say "${String(b.message || '').replace(/["\r\n]/g, "'")}"`),
  'GET /api/users': async () => ({ users: users.list(), online: [...bridged.keys()] }),
  'POST /api/users': async (b) => users.set(b.name, b.password),
  'POST /api/users/delete': async (b) => {
    users.remove(b.name);
    bridged.get(String(b.name).toLowerCase())?.close();
  },
  'POST /api/company/delete': async (b) => {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id < 1 || id > 15) throw new Error('Empresa no válida');
    // OpenTTD no borra una empresa con jugadores dentro: se pasan a espectadores.
    for (const c of game.clients.filter((c) => c.company === id)) await game.command(`move ${c.id} 255`);
    const out = (await game.command(`reset_company ${id}`)).join(' ');
    if (/cannot|error|invalid|not exist/i.test(out)) throw new Error(out);
    game.addLog(`Empresa ${id} eliminada desde el panel`);
    const owner = users.ownerOf(id);
    if (owner) users.setCompany(owner, null);
    await game.refresh().catch(() => {});
  },
  'POST /api/map/refresh': async () => ({ map: await game.generateMap() }),
  'POST /api/actions/restore': async () => {
    users.restoreAllActions();
    game.actionsSynced = false; // se vuelve a dar a cada empresa su máximo en la próxima pasada
    game.addLog('Acciones restablecidas desde el panel');
  },
  'POST /api/kick': async (b) => game.command(`kick ${Number(b.id)}`),
  'POST /api/command': async (b) => {
    const lines = await game.command(String(b.command || ''), 10000, { log: true });
    lines.forEach((l) => game.addLog(l));
    return { lines };
  },
};

async function handleAdmin(req, res) {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OpenTTD admin", charset="UTF-8"' }).end('Auth required');
    return;
  }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    fs.createReadStream(path.join(ADMIN_DIR, 'index.html')).pipe(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/map.png') {
    fs.readFile(game.mapFile, (err, png) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': MIME['.png'], 'Cache-Control': 'no-cache' }).end(png);
    });
    return;
  }
  const handler = api[`${req.method} ${url.pathname}`];
  if (!handler) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    const result = (await handler(body)) ?? { ok: true };
    res.writeHead(200, { 'Content-Type': MIME['.json'] }).end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': MIME['.json'] }).end(JSON.stringify({ error: e.message }));
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/')) handleAdmin(req, res);
  else if (pathname.startsWith('/auth/')) handleAuth(req, res, pathname);
  else serveStatic(req, res);
});

// Estado y lista de jugadores permitidos se revisan periódicamente.
setInterval(() => game.refresh().catch(() => {}), 2000);

// Al arrancar se reanuda la partida más reciente (la guardada al apagar o, si el proceso
// murió sin avisar, el último autoguardado cada 10 min).
function resume() {
  const save = game.latestSave();
  if (!save) return;
  try {
    game.start(save);
  } catch (e) {
    console.error(e.message);
  }
}
if (process.env.GAME_AUTOSTART !== '0') resume();

// Si el servidor de juego se cae solo, se reanuda desde el último guardado
// (con límite, por si la partida guardada es la que lo hace caer).
const restarts = [];
game.on('exit', () => {
  if (game.requestedExit || process.env.GAME_AUTOSTART === '0') return;
  const now = Date.now();
  while (restarts.length && now - restarts[0] > 300000) restarts.shift();
  if (restarts.length >= 3) return console.error('El servidor de juego se cae repetidamente; no se reinicia más.');
  restarts.push(now);
  setTimeout(resume, 3000);
});

// Al apagar (Ctrl+C, systemd, cierre de terminal) se guarda la partida antes de salir.
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await game.stop().catch(() => {});
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(0));
process.on('uncaughtException', (e) => {
  console.error(e);
  shutdown(1);
});

// Cada WebSocket del navegador se convierte en una conexión TCP al servidor de juego.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const user = currentUser(req);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Una sola conexión por jugador: la nueva sustituye a la anterior (p.ej. al recargar la página).
    const key = user.toLowerCase();
    bridged.get(key)?.close();
    bridged.set(key, ws);
    ws.on('close', () => bridged.get(key) === ws && bridged.delete(key));
    const tcp = net.connect(GAME_PORT, GAME_HOST);
    tcp.setNoDelay(true);
    const pending = [];
    tcp.on('connect', () => pending.splice(0).forEach((b) => tcp.write(b)));
    ws.on('message', (data) => (tcp.connecting ? pending.push(data) : tcp.write(data)));
    tcp.on('data', (data) => ws.readyState === ws.OPEN && ws.send(data));
    tcp.on('close', () => ws.close());
    tcp.on('error', () => ws.close());
    ws.on('close', () => tcp.destroy());
    ws.on('error', () => tcp.destroy());
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`Cliente web:  http://localhost:${HTTP_PORT}/  (puente /ws -> ${GAME_HOST}:${GAME_PORT})`);
  console.log(`Panel admin:  http://localhost:${HTTP_PORT}/admin  (usuario cualquiera, contraseña en ${process.env.ADMIN_PASSWORD ? '$ADMIN_PASSWORD' : PASS_FILE})`);
});
