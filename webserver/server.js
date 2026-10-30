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

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(WWW, path.normalize(rel));
  if (!file.startsWith(WWW + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      // config.js e index.html cambian entre despliegues; el resto va versionado con el build.
      'Cache-Control': /\.(html|js)$/.test(file) ? 'no-cache' : 'public, max-age=3600',
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

const game = new Game({ root: ROOT });

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
  else serveStatic(req, res);
});

// Estado y lista de jugadores permitidos se revisan periódicamente.
setInterval(() => game.refresh().catch(() => {}), 5000);

// Al arrancar se reanuda la última partida, si existe.
if (process.env.GAME_AUTOSTART !== '0' && game.saves().some((s) => s.name === 'last.sav')) {
  try {
    game.start('last.sav');
  } catch (e) {
    console.error(e.message);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await game.stop().catch(() => {});
    process.exit(0);
  });
}

// Cada WebSocket del navegador se convierte en una conexión TCP al servidor de juego.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
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
