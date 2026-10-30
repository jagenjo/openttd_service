// Cuentas de jugador (runtime/users.json) y sesiones en memoria.
// Las contraseñas se guardan con scrypt; nunca en claro.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// El nombre de usuario es también el nombre del jugador dentro de OpenTTD.
export const NAME_RE = /^[A-Za-z0-9_.-]{1,24}$/;
const SESSION_TTL = 7 * 24 * 3600 * 1000;

const hash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');

export class Users {
  constructor(file) {
    this.file = file;
    this.sessions = new Map(); // token -> { name, expires }
    this.failures = new Map(); // ip -> { count, until }
    try {
      this.users = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.users = {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.users, null, 2), { mode: 0o600 });
  }

  key(name) {
    return String(name).toLowerCase();
  }

  list() {
    return Object.values(this.users).map((u) => ({ name: u.name, created: u.created, company: u.company ?? null, actions: u.actions ?? null }));
  }

  set(name, password) {
    name = String(name || '').trim();
    if (!NAME_RE.test(name)) throw new Error('Nombre no válido: 1-24 caracteres entre letras, números, _ . -');
    if (String(password || '').length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres');
    const salt = crypto.randomBytes(16).toString('hex');
    const prev = this.users[this.key(name)];
    this.users[this.key(name)] = { name: prev?.name ?? name, salt, hash: hash(password, salt), created: prev?.created ?? Date.now(), ...(prev?.company ? { company: prev.company } : {}), ...(prev?.actions != null ? { actions: prev.actions } : {}), ...(prev?.chatSeen != null ? { chatSeen: prev.chatSeen } : {}) };
    this.save();
    this.dropSessions(name);
  }

  remove(name) {
    delete this.users[this.key(name)];
    this.save();
    this.dropSessions(name);
  }

  // Empresa (número de la consola, desde 1) vinculada a la cuenta, o null.
  companyOf(name) {
    return this.users[this.key(name)]?.company ?? null;
  }

  ownerOf(company) {
    return Object.values(this.users).find((u) => u.company === company)?.name ?? null;
  }

  setCompany(name, company) {
    const u = this.users[this.key(name)];
    if (!u || (u.company ?? null) === company) return;
    if (company === null) delete u.company;
    else u.company = company;
    this.save();
  }

  // Acciones restantes de la cuenta; null = todas las del día.
  actionsOf(name) {
    return this.users[this.key(name)]?.actions ?? null;
  }

  setActions(name, n) {
    const u = this.users[this.key(name)];
    if (!u || (u.actions ?? null) === n) return;
    if (n === null) delete u.actions;
    else u.actions = n;
    this.save();
  }

  restoreAllActions() {
    for (const u of Object.values(this.users)) delete u.actions;
    this.save();
  }

  // Cambia el máximo diario: a quien ya había gastado acciones se le suma/resta la diferencia.
  adjustActions(oldMax, newMax) {
    for (const u of Object.values(this.users)) {
      if (u.actions == null) continue;
      if (oldMax <= 0 || newMax <= 0) delete u.actions;
      else u.actions = Math.min(newMax, Math.max(0, u.actions + newMax - oldMax));
    }
    this.save();
  }

  // Último mensaje de chat entregado dentro del juego a esta cuenta (null = ninguno).
  chatSeenOf(name) {
    return this.users[this.key(name)]?.chatSeen ?? null;
  }

  setChatSeen(name, id) {
    const u = this.users[this.key(name)];
    if (!u || u.chatSeen === id) return;
    u.chatSeen = id;
    this.save();
  }

  has(name) {
    return this.key(name) in this.users;
  }

  // Devuelve el token de sesión, o lanza un error. Frena los intentos repetidos desde una misma IP.
  login(name, password, ip) {
    const f = this.failures.get(ip);
    if (f && f.count >= 5 && Date.now() < f.until) throw new Error('Demasiados intentos; espera un minuto');
    const u = this.users[this.key(name)];
    // Se calcula el hash aunque el usuario no exista, para que el tiempo no delate qué nombres existen.
    const h = hash(String(password || ''), u?.salt ?? '0'.repeat(32));
    const ok = u && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) {
      const count = (f && Date.now() < f.until ? f.count : 0) + 1;
      this.failures.set(ip, { count, until: Date.now() + 60000 });
      throw new Error('Usuario o contraseña incorrectos');
    }
    this.failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { name: u.name, expires: Date.now() + SESSION_TTL });
    return token;
  }

  // Nombre del usuario de una sesión, o null.
  session(token) {
    const s = token && this.sessions.get(token);
    if (!s) return null;
    if (s.expires < Date.now() || !this.has(s.name)) {
      this.sessions.delete(token);
      return null;
    }
    return s.name;
  }

  logout(token) {
    this.sessions.delete(token);
  }

  dropSessions(name) {
    for (const [t, s] of this.sessions) if (this.key(s.name) === this.key(name)) this.sessions.delete(t);
  }
}
