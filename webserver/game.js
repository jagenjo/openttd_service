// Gestiona el proceso del servidor dedicado de OpenTTD y habla con él por su
// consola (stdin/stdout). Así no hace falta exponer el puerto admin.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseIni, stringifyIni } from './ini.js';
import { renderMap } from './gamemap.js';

// Ajustes de generación del mapa: clave del panel -> [sección del .cfg, nombre, mín, máx, defecto de OpenTTD].
export const MAPGEN = {
  sea_level: ['difficulty', 'quantity_sea_lakes', 0, 4, 0], // 0 muy poca agua ... 3 mucha, 4 personalizada
  custom_sea_level: ['game_creation', 'custom_sea_level', 1, 90, 20], // % de agua si sea_level = 4
  rivers: ['game_creation', 'amount_of_rivers', 0, 3, 2],
  terrain_type: ['difficulty', 'terrain_type', 0, 4, 1], // 0 muy llano ... 4 alpino
  smoothness: ['game_creation', 'tgen_smoothness', 0, 3, 1],
  variety: ['game_creation', 'variety', 0, 5, 0],
  land_generator: ['game_creation', 'land_generator', 0, 1, 1], // 0 original, 1 TerraGenesis
  towns: ['difficulty', 'number_towns', 0, 4, 2], // 4 = personalizado
  custom_towns: ['game_creation', 'custom_town_number', 1, 5000, 10],
  industries: ['difficulty', 'industry_density', 0, 5, 4],
  snow_coverage: ['game_creation', 'snow_coverage', 0, 100, 40],
  desert_coverage: ['game_creation', 'desert_coverage', 0, 100, 50],
};

export const DEFAULT_SETTINGS = {
  ...Object.fromEntries(Object.entries(MAPGEN).map(([k, v]) => [k, v[4]])),
  seed: null, // null = aleatoria
  money_factor: 0.5, // multiplicador de los ingresos por carga (1 = normal)
  server_name: 'OpenTTD Slow Time',
  server_password: '',
  minutes_per_calendar_year: 1440,
  starting_year: 1950,
  map_x: 8,
  map_y: 8,
  landscape: 'temperate',
  max_companies: 15,
  actions_per_day: 100,
};

const s_seed = (s) => s.seed !== null && s.seed !== undefined;

export class Game extends EventEmitter {
  constructor({ root, players }) {
    super();
    this.players = players; // { isAllowed(name), companyOf(name), ownerOf(id), setCompany(name, id|null) }
    this.root = root;
    this.bin = path.join(root, 'build', 'server', 'openttd');
    this.dataDir = path.join(root, 'runtime', 'server');
    this.financeFile = path.join(root, 'runtime', 'finance.json');
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
    this.actionsSynced = false;
    this.knownClients = new Set();
    this.actionsFile = path.join(root, 'runtime', 'actions.json');
    this.mapFile = path.join(root, 'runtime', 'map.png');
    this.mapInfo = this.loadMapInfo();
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
    const ints = ['minutes_per_calendar_year', 'starting_year', 'map_x', 'map_y', 'max_companies', 'actions_per_day'];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      s[k] = ints.includes(k) ? Number(v) : v;
    }
    s.minutes_per_calendar_year = Math.min(10080, Math.max(1, s.minutes_per_calendar_year | 0));
    s.map_x = Math.min(12, Math.max(6, s.map_x | 0));
    s.map_y = Math.min(12, Math.max(6, s.map_y | 0));
    for (const [k, [, , min, max, def]] of Object.entries(MAPGEN)) {
      const n = Math.round(Number(s[k]));
      s[k] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
    }
    const f = Number(s.money_factor);
    s.money_factor = Number.isFinite(f) ? Math.min(10, Math.max(0.01, Math.round(f * 100) / 100)) : 0.5;
    // Semilla: vacía o 0 = aleatoria.
    s.seed = s.seed === '' || s.seed == null || Number(s.seed) <= 0 ? null : Math.min(4294967294, Math.floor(Number(s.seed)));
    s.max_companies = Math.min(15, Math.max(1, s.max_companies | 0));
    s.actions_per_day = Math.min(100000, Math.max(0, s.actions_per_day | 0)); // 0 = sin límite
    const oldMax = this.settings.actions_per_day;
    const oldFactor = this.settings.money_factor;
    const oldMinutes = this.settings.minutes_per_calendar_year;
    this.settings = s;
    if (s.money_factor !== oldFactor || s.minutes_per_calendar_year !== oldMinutes) this.moneySynced = false; // se aplica a la partida en marcha
    if (s.actions_per_day !== oldMax) {
      this.players.adjustActions(oldMax, s.actions_per_day);
      this.actionsSynced = false; // se vuelve a dar a cada empresa su valor en la próxima pasada
    }
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
    cfg.economy = { ...cfg.economy, income_percent: this.incomePercent };
    for (const [k, [section, name]] of Object.entries(MAPGEN)) cfg[section] = { ...cfg[section], [name]: s[k] };
    fs.writeFileSync(path.join(this.dataDir, 'openttd.cfg'), stringifyIni(cfg));
    fs.writeFileSync(path.join(this.dataDir, 'private.cfg'), stringifyIni({ network: { server_name: s.server_name } }));
    fs.writeFileSync(path.join(this.dataDir, 'secrets.cfg'), stringifyIni({ network: { server_password: s.server_password } }), { mode: 0o600 });
  }

  // Ingresos por carga, en % (50 = la mitad). Es un ajuste de la partida: va en la partida
  // guardada y el servidor lo propaga a los clientes, así que todos calculan lo mismo.
  get incomePercent() {
    return Math.min(1000, Math.max(1, Math.round(this.settings.money_factor * 100)));
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
    this.mapDirty = true;
    // El puerto del juego solo escucha en local: se entra por el puente web (que exige login).
    // GAME_PUBLIC=1 lo abre a todas las interfaces.
    const bind = process.env.GAME_PUBLIC ? '-D' : `-D127.0.0.1:${process.env.GAME_PORT || 3979}`;
    const args = [bind, '-c', path.join(this.dataDir, 'openttd.cfg'), '-x'];
    if (s_seed(this.settings) && !save) args.push('-G', String(this.settings.seed));
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
      this.actionsSynced = false;
      this.moneySynced = false;
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

  // Finanzas mensuales por empresa. El juego solo da acumulados del año; aquí se restan los del
  // inicio de mes. Se guarda en runtime/finance.json para no perder el mes en curso al reiniciar.
  async updateFinance() {
    if (!this.finance) {
      try { this.finance = JSON.parse(fs.readFileSync(this.financeFile, 'utf8')); } catch { this.finance = { month: null, companies: {} }; }
    }
    const month = this.date?.match(/\d{4}-\d{2}/)?.[0];
    if (!month) return;
    const out = await this.command('company_finance');
    const keys = ['cargo', 'run', 'property', 'interest'];
    const f = this.finance;
    const rolled = f.month && f.month !== month;
    const seen = new Set();
    for (const l of out) {
      const m = l.match(/^#:(\d+) cargo:(-?\d+) run:(-?\d+) property:(-?\d+) interest:(-?\d+)/);
      if (!m) continue;
      const id = m[1];
      seen.add(id);
      const cum = Object.fromEntries(keys.map((k, i) => [k, Number(m[i + 2])]));
      let st = f.companies[id];
      if (!st) st = f.companies[id] = { base: cum, last: cum, prev: null };
      if (rolled) {
        st.prev = Object.fromEntries(keys.map((k) => [k, st.last[k] - st.base[k]]));
        st.base = cum;
      }
      for (const k of keys) if (cum[k] < st.base[k]) st.base = { ...st.base, [k]: 0 }; // año nuevo: el acumulado vuelve a 0
      st.last = cum;
    }
    for (const id of Object.keys(f.companies)) if (!seen.has(id)) delete f.companies[id];
    await this.updateHistory(month);
    f.month = month;
    if (rolled || Date.now() - (this.financeSaved || 0) > 30000) {
      this.financeSaved = Date.now();
      try { fs.writeFileSync(this.financeFile, JSON.stringify(f)); } catch {}
    }
  }

  // Ingresos y gastos por trimestre: son los datos que el propio juego guarda en la partida
  // (los de la gráfica de finanzas). El trimestre 0 es el actual y los demás, anteriores.
  async updateHistory(month) {
    const out = await this.command('company_history');
    let year = Number(month.slice(0, 4));
    let quarter = Math.floor((Number(month.slice(5, 7)) - 1) / 3);
    const history = {};
    for (const l of out) {
      const m = l.match(/^#:(\d+) q:(\d+) income:(-?\d+) expenses:(-?\d+)/);
      if (!m) continue;
      let y = year, q = quarter - Number(m[2]);
      while (q < 0) { q += 4; y--; }
      const income = Number(m[3]), expenses = -Number(m[4]); // en el juego los gastos son negativos
      (history[m[1]] ||= []).unshift({ m: `${y} T${q + 1}`, income, expenses, net: income - expenses, partial: m[2] === '0' });
    }
    this.history = history;
  }

  // Datos del último mes completo de una empresa (o el mes en curso si aún no hay ninguno).
  financeOf(companyId) {
    const st = this.finance?.companies?.[String(companyId)];
    if (!st) return null;
    const mtd = Object.fromEntries(Object.keys(st.last).map((k) => [k, st.last[k] - st.base[k]]));
    const src = st.prev || mtd;
    return {
      history: this.history?.[String(companyId)] || [],
      completeMonth: !!st.prev,
      cargo: src.cargo,
      running: src.run,
      maintenance: src.property,
      interest: src.interest,
      net: src.cargo - src.run - src.property - src.interest,
    };
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
      .map((l) => l.match(/^#:(\d+)\(([^)]+)\) Company Name: '(.*)'\s+Year Founded: (\d+)\s+Money: (-?\d+)\s+Loan: (\d+)\s+Value: (-?\d+)\s+\(T:(\d+), R:(\d+), P:(\d+), S:(\d+)\)/))
      .filter(Boolean)
      .map(([, id, colour, name, founded, money, loan, value, t, r, p, s]) => ({
        id: Number(id), colour, name, founded: Number(founded),
        money: Number(money), loan: Number(loan), value: Number(value),
        vehicles: { trains: +t, road: +r, planes: +p, ships: +s },
      }));

    await this.updateFinance();
    await this.enforcePlayers();
    await this.syncActions();
    await this.syncIncome();
    await this.refreshMap();
  }

  // El mapa se regenera cada hora en punto, y al cargar una partida.
  async refreshMap() {
    if (this.generatingMap || this.date === null) return;
    const hour = (t) => Math.floor(t / 3600000);
    if (!this.mapDirty && this.mapInfo && hour(this.mapInfo.time) === hour(Date.now())) return;
    this.generatingMap = true;
    try {
      await this.generateMap();
      this.mapDirty = false;
    } catch (e) {
      this.addLog(`No se pudo generar el mapa: ${e.message}`);
      this.mapDirty = false; // se reintenta en la próxima hora
    } finally {
      this.generatingMap = false;
    }
  }

  // --- Acciones ---------------------------------------------------------------------
  // Construir o destruir en el mapa cuesta una acción. El servidor de juego lleva la cuenta
  // por empresa (y rechaza al llegar a 0); aquí se guarda por cuenta, para que sobreviva a
  // reinicios y a cambios de empresa, y se restablece cada día a las 0:00 (hora local).

  get maxActions() {
    return this.settings.actions_per_day > 0 ? this.settings.actions_per_day : 'unlimited';
  }

  localDay() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  nextRestore() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }

  // Acciones que le quedan a una cuenta (null = sin límite).
  actionsLeft(name) {
    if (!(this.settings.actions_per_day > 0)) return null;
    return Math.min(this.players.actionsOf(name) ?? Infinity, this.settings.actions_per_day);
  }

  async syncActions() {
    const P = this.players;
    let lastRestore = null;
    try {
      lastRestore = JSON.parse(fs.readFileSync(this.actionsFile, 'utf8')).lastRestore;
    } catch { /* primera vez */ }
    const today = this.localDay();
    const restore = lastRestore !== null && lastRestore !== today;
    if (lastRestore !== today) fs.writeFileSync(this.actionsFile, JSON.stringify({ lastRestore: today }));
    if (restore) {
      P.restoreAllActions();
      this.addLog('ACTIONS RESTORE: acciones restablecidas');
    }

    if (!this.actionsSynced || restore) {
      // El servidor de juego arranca con el valor por defecto: se le dan los valores guardados.
      await this.command(`actions_default ${this.maxActions}`);
      for (const c of this.companies) {
        const owner = P.ownerOf(c.id);
        const left = owner ? this.actionsLeft(owner) : null;
        await this.command(`actions_set ${c.id} ${left ?? this.maxActions}`);
      }
      this.actionsSynced = true;
      if (restore) await this.command('say "ACTIONS RESTORE: tus acciones se han restablecido"').catch(() => {});
      return;
    }
    for (const line of await this.command('actions')) {
      const m = line.match(/^Actions company (\d+): (-?\d+)$/);
      const owner = m && P.ownerOf(Number(m[1]));
      if (owner && Number(m[2]) >= 0) P.setActions(owner, Number(m[2]));
    }
  }

  // La partida guarda su multiplicador de ingresos: al cargar una guardada con otro valor (o al
  // cambiarlo en el panel) se pone el del panel con el comando de consola `setting`.
  async syncIncome() {
    if (this.moneySynced) return;
    const pct = this.incomePercent;
    await this.command(`setting income_percent ${pct}`);
    // El ritmo del calendario también se puede cambiar con la partida en marcha.
    await this.command(`setting minutes_per_calendar_year ${this.settings.minutes_per_calendar_year}`);
    const out = (await this.command('setting income_percent')).join(' ');
    this.moneySynced = new RegExp(`current value[^\\d]*${pct}\\b`, 'i').test(out);
    this.addLog(this.moneySynced ? `Ingresos por carga: ${pct}% · ${this.settings.minutes_per_calendar_year} min por año de juego` : `No se pudo fijar los ingresos (${out})`);
    if (!this.moneySynced) this.moneySynced = true; // no insistir en cada pasada
  }

  // --- Mapa -------------------------------------------------------------------------

  loadMapInfo() {
    try {
      return JSON.parse(fs.readFileSync(this.mapFile + '.json', 'utf8'));
    } catch {
      return null;
    }
  }

  // Vuelca el mapa del juego en marcha y lo convierte en imagen (un píxel por casilla).
  async generateMap() {
    const raw = path.join(this.dataDir, 'map.dump');
    await this.command(`dump_map ${raw}`, 60000);
    const { width, height, png } = renderMap(raw, this.companies);
    fs.writeFileSync(this.mapFile, png);
    this.mapInfo = {
      time: Date.now(), width, height, date: this.date,
      companies: this.companies.map((c) => ({ id: c.id, name: c.name, colour: c.colour })),
    };
    fs.writeFileSync(this.mapFile + '.json', JSON.stringify(this.mapInfo));
    fs.rmSync(raw, { force: true });
    return this.mapInfo;
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

    // Mensajes que se dejaron en la web mientras el jugador no estaba: se le entregan al entrar.
    const current = new Set(this.clients.map((c) => c.id));
    for (const c of this.clients) {
      if (this.knownClients.has(c.id) || !P.isAllowed(c.name)) continue;
      for (const line of P.pendingChat(c.name)) {
        await this.command(`say_client ${c.id} "${line}"`).catch(() => {});
      }
    }
    this.knownClients = current;

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
        const left = this.actionsLeft(c.name);
        await this.command(`actions_set ${c.company} ${left ?? this.maxActions}`).catch(() => {});
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
      map: this.mapInfo,
      saves: this.saves(),
    };
  }
}
