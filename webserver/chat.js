// Mensajes de los jugadores (runtime/chat.json): los últimos MAX, con id creciente.
import fs from 'node:fs';
import path from 'node:path';

const MAX = 200;
export const MAX_LEN = 200;

export class Chat {
  constructor(file) {
    this.file = file;
    this.lastPost = new Map(); // usuario -> instante del último mensaje (para frenar el spam)
    try {
      this.messages = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.messages = [];
    }
  }

  get lastId() {
    return this.messages.at(-1)?.id ?? 0;
  }

  add(user, text) {
    text = String(text ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_LEN);
    if (!text) throw new Error('Mensaje vacío');
    const now = Date.now();
    if (now - (this.lastPost.get(user) ?? 0) < 2000) throw new Error('Espera un momento antes de escribir otra vez');
    this.lastPost.set(user, now);
    const msg = { id: this.lastId + 1, time: now, user, text };
    this.messages.push(msg);
    if (this.messages.length > MAX) this.messages.splice(0, this.messages.length - MAX);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.messages));
    return msg;
  }

  since(id, limit = 50) {
    return this.messages.filter((m) => m.id > id).slice(-limit);
  }
}

// Línea que se muestra dentro del juego (sin comillas ni caracteres de control).
export const gameLine = (m) => `${m.user}: ${m.text}`.replace(/["\\]/g, "'");
