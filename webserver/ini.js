// Lector/escritor mínimo de ficheros .cfg de OpenTTD (formato INI).
export function parseIni(text) {
  const out = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      section = out[m[1]] ??= {};
    } else if (section) {
      const i = line.indexOf('=');
      if (i > 0) section[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

export function stringifyIni(data) {
  return Object.entries(data)
    .map(([name, kv]) => `[${name}]\n` + Object.entries(kv).map(([k, v]) => `${k} = ${v}`).join('\n'))
    .join('\n\n') + '\n';
}
