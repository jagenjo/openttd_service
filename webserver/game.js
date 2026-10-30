// Gestiona el proceso del servidor dedicado de OpenTTD y habla con él por su
// consola (stdin/stdout). Así no hace falta exponer el puerto admin.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseIni, stringifyIni } from './ini.js';

export const DEFAULT_SETTINGS = {
  server_name: 'OpenTTD Slow Time',
  server_password: '',
  minutes_per_calendar_year: 1440,
  starting_year: 1950,
  map_x: 8,
  map_y: 8,
  landscape: 'temperate',
  max_companies: 15,
};

export class Game extends EventEmitter {
  constructor({ root, players }) {
    super();
    this.players = players; // { isAllowed(name), companyOf(name), ownerOf(id), setCompany(name, id|null) }
    this.root = root;
    this.bin = path.join(root, 'build', 'server', 'openttd');
    this.dataDir = path.join(root, 'runtime', 'server');
    this.settingsFile = path.join(root, 'runtime', 'settings.json');
    this.template = path.join(root, 'server', 'openttd.cfg');
    this.proc = null;
    this.log = [];
    this.queue = [];
    this.current = null;
    this.seq = 0;
    this.buffer = '';
    this.clients = [];
    this.companies = [];
    this.date = null;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.settings = this.loadSettings();
  }

  loadSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(patch) {
    const s = { ...this.settings };
    const ints = ['minutes_per_calendar_year', 'starting_year', 'map_x', 'map_y', 'max_companies'];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      s[k] = ints.includes(k) ? Number(v) : v;
    }
    s.minutes_per_calendar_year = Math.min(10080, Math.max(1, s.minutes_per_calendar_year | 0));
    s.map_x = Math.min(12, Math.max(6, s.map_x | 0));
    s.map_y = Math.min(12, Math.max(6, s.map_y | 0));
    s.max_companies = Math.min(15, Math.max(1, s.max_companies | 0));
    this.settings = s;
    fs.writeFileSync(this.settingsFile, JSON.stringify(s, null, 2));
    return s;
  }

  // Genera openttd.cfg, private.cfg y secrets.cfg a partir de la plantilla y los ajustes del panel.
  writeConfig() {
    const s = this.settings;
    const cfg = parseIni(fs.readFileSync(this.template, 'utf8'));
    cfg.economy = { ...cfg.economy, minutes_per_calendar_year: s.minutes_per_calendar_year };
    cfg.game_creation = {
      ...cfg.game_creation,
      starting_year: s.starting_year,
      map_x: s.map_x,
      map_y: s.map_y,
      landscape: s.landscape,
    };
    cfg.network = { ...cfg.network, max_companies: s.max_companies };
    fs.writeFileSync(path.join(this.dataDir, 'openttd.cfg'), stringifyIni(cfg));
    // El puerto del juego solo escucha en local: se entra por el puente web (que exige login).
    // GAME_PUBLIC=1 lo abre a todas las interfaces.
    const priv = { network: { server_name: s.server_name } };
    if (!process.env.GAME_PUBLIC) priv.server_bind_addresses = { '127.0.0.1': null };
    fs.writeFileSync(path.join(this.dataDir, 'private.cfg'), stringifyIni(priv));
    fs.writeFileSync(path.join(this.dataDir, 'secrets.cfg'), stringifyIni({ network: { server_password: s.server_password } }), { mode: 0o600 });
  }

  get running() {
    return this.proc !== null;
  }

  saves() {
    const dir = path.join(this.dataDir, 'save');
    const list = [];
    for (const sub of ['', 'autosave']) {
      try {
        for (const f of fs.readdirSync(path.join(dir, sub))) {
          if (!f.endsWith('.sav')) continue;
          const st = fs.statSync(path.join(dir, sub, f));
          list.push({ name: path.join(sub, f), mtime: st.mtimeMs });
        }
      } catch { /* aún no hay partidas guardadas */ }
    }
    return list.sort((a, b) => b.mtime - a.mtime);
  }

  // Última partida (guardado manual, al detener o autoguardado), la más reciente.
  latestSave() {
    return this.saves()[0]?.name ?? null;
  }

  // Arranca el servidor. Sin `save` genera un mapa nuevo.
  start(save) {
    if (this.proc) throw new Error('El servidor ya está en marcha');
    if (!fs.existsSync(this.bin)) throw new Error(`Falta ${this.bin}; ejecuta scripts/build-server.sh`);
    this.writeConfig();
    const args = ['-D', '-c', path.join(this.dataDir, 'openttd.cfg'), '-x'];
    if (save) {
      const file = path.join(this.dataDir, 'save', path.normalize(save));
      if (!file.startsWith(path.join(this.dataDir, 'save') + path.sep) || !fs.existsSync(file)) {
        throw new Error('Partida guardada no encontrada');
      }
      args.push('-g', file);
    }
    this.addLog(`> openttd ${args.join(' ')}`);
    this.proc = spawn(this.bin, args, { cwd: this.dataDir, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this.onOutput(d));
    this.proc.stderr.on('data', (d) => this.onOutput(d));
    this.proc.on('exit', (code) => {
      this.addLog(`El servidor terminó (código ${code})`);
      this.requestedExit = this.stopping;
      this.stopping = false;
      this.proc = null;
      this.clients = [];
      this.companies = [];
      this.date = null;
      const pending = [this.current, ...this.queue].filter(Boolean);
      if (this.current) this.finish(this.current);
      this.queue = [];
      for (const c of pending) c.reject(new Error('Servidor detenido'));
      this.emit('exit');
    });
  }

  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.stopping = true;
    const exited = new Promise((r) => proc.once('exit', r));
    try {
      await this.command('save last', 20000);
    } catch { /* si no se puede guardar, salimos igualmente */ }
    proc.stdin.write('quit\n');
    const poke = setInterval(() => proc.stdin.writable && proc.stdin.write('\n'), 200);
    const timer = setTimeout(() => proc.kill('SIGTERM'), 15000);
    await exited;
    clearInterval(poke);
    clearTimeout(timer);
  }

  addLog(line) {
    this.log.push(line);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
  }

  onOutput(chunk) {
    this.buffer += chunk.toString();
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      // Las líneas de consola llevan delante "[fecha hora] ".
      const text = line.replace(/^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] /, '');
      if (this.current) {
        if (text === this.current.marker) {
          const cur = this.current;
          this.finish(cur);
          cur.resolve(cur.lines);
          this.next();
          continue;
        }
        // Las respuestas a comandos no van al log (el panel consulta el estado cada pocos segundos).
        this.current.lines.push(text);
        continue;
      }
      this.addLog(text);
    }
  }

  // Ejecuta un comando de consola y devuelve las líneas que imprime.
  command(cmd, timeout = 5000, { log = false } = {}) {
    if (log) this.addLog(`> ${cmd}`);
    if (!this.proc) return Promise.reject(new Error('El servidor no está en marcha'));
    if (/[\r\n]/.test(cmd)) return Promise.reject(new Error('Comando no válido'));
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, timeout, resolve, reject });
      if (!this.current) this.next();
    });
  }

  next() {
    const job = this.queue.shift();
    if (!job || !this.proc) return;
    const cur = { ...job, marker: `__end_${++this.seq}__`, lines: [] };
    this.current = cur;
    cur.timer = setTimeout(() => {
      if (this.current !== cur) return;
      this.finish(cur);
      cur.reject(new Error(`Sin respuesta a "${cur.cmd}"`));
      this.next();
    }, job.timeout);
    this.proc.stdin.write(`${job.cmd}\necho ${cur.marker}\n`);
    // OpenTTD solo lee una línea de stdin cada vez que select() ve datos nuevos;
    // las líneas que quedan en el búfer de std::cin se procesan al recibir más datos.
    // Enviamos líneas vacías (no hacen nada) hasta ver el marcador.
    cur.poke = setInterval(() => this.proc?.stdin.write('\n'), 200);
  }

  finish(cur) {
    clearTimeout(cur.timer);
    clearInterval(cur.poke);
    if (this.current === cur) this.current = null;
  }

  // Actualiza fecha, clientes y empresas; aplica la lista de jugadores permitidos.
  async refresh() {
    if (!this.proc) return;
    const [date] = await this.command('getdate');
    this.date = date?.replace(/^Date:\s*/, '') ?? null;

    this.clients = (await this.command('clients'))
      .map((l) => l.match(/^Client #(\d+)\s+name: '(.*)'\s+company: (\d+)\s+IP: (\S+)/))
      .filter(Boolean)
      .map(([, id, name, company, ip]) => ({ id: Number(id), name, company: Number(company), ip }))
      .filter((c) => c.ip !== 'server');

    this.companies = (await this.command('companies'))
      .map((l) => l.match(/^#:(\d+)\((\w+)\) Company Name: '(.*)'\s+Year Founded: (\d+)\s+Money: (-?\d+)\s+Loan: (\d+)\s+Value: (-?\d+)\s+\(T:(\d+), R:(\d+), P:(\d+), S:(\d+)\)/))
      .filter(Boolean)
      .map(([, id, colour, name, founded, money, loan, value, t, r, p, s]) => ({
        id: Number(id), colour, name, founded: Number(founded),
        money: Number(money), loan: Number(loan), value: Number(value),
        vehicles: { trains: +t, road: +r, planes: +p, ships: +s },
      }));

    await this.enforcePlayers();
  }

  // Solo juegan los usuarios con sesión abierta en el cliente web, y con su nombre de usuario:
  // cualquiera que entre con otro nombre (p.ej. un cliente de escritorio, o un jugador que se
  // cambie el nombre al de otra cuenta) es expulsado. Además cada cuenta tiene su empresa:
  // la primera que funda se le vincula, y desde entonces entra siempre en ella.
  async enforcePlayers() {
    const P = this.players;
    // Si una empresa vinculada ya no existe (quiebra), se desvincula.
    const exists = new Set(this.companies.map((c) => c.id));
    for (const u of P.accounts()) if (u.company !== null && !exists.has(u.company)) P.setCompany(u.name, null);

    for (const c of this.clients) {
      if (!P.isAllowed(c.name)) {
        this.addLog(`Expulsando a '${c.name}': no coincide con un usuario conectado`);
        await this.command(`kick ${c.id} "Entra desde el cliente web con tu usuario"`).catch(() => {});
        continue;
      }
      if (c.company !== 255 && (c.company < 1 || c.company > 15)) continue; // 254: empresa nueva aún sin crear
      const mine = P.companyOf(c.name);
      const owner = c.company === 255 ? null : P.ownerOf(c.company);
      let target;
      if (mine !== null) {
        // Su empresa; nunca la de otro.
        if (c.company === mine) continue;
        target = mine;
      } else if (c.company !== 255 && owner === null) {
        P.setCompany(c.name, c.company); // primera empresa del jugador: se vincula
        this.addLog(`Empresa ${c.company} vinculada a '${c.name}'`);
        continue;
      } else if (owner !== null && owner.toLowerCase() !== c.name.toLowerCase()) {
        target = 255; // empresa ajena y sin empresa propia: espectador
      } else {
        continue;
      }
      this.addLog(`Moviendo a '${c.name}' a ${target === 255 ? 'espectadores' : `su empresa ${target}`}`);
      await this.command(`move ${c.id} ${target}`).catch(() => {});
    }
  }

  status() {
    return {
      running: this.running,
      date: this.date,
      clients: this.clients,
      companies: this.companies,
      settings: this.settings,
      saves: this.saves(),
    };
  }
}
