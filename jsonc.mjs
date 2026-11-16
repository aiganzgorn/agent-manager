// Minimal JSONC support: strip comments, list top-level keys with their value
// spans, and replace one top-level value in place. Everything else in the file
// (comments, formatting, order) stays byte-identical.

export function stripJsonc(text) {
  let out = '';
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '"') {
      const s = readString(text, i);
      out += text.slice(i, s.end);
      i = s.end;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < len && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseConfig(text) {
  return JSON.parse(stripJsonc(text));
}

function readString(text, i) {
  let j = i + 1;
  let value = '';
  let raw = '"';
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      const nx = text[j + 1];
      value += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx === '"' ? '"' : nx === '\\' ? '\\' : nx === '/' ? '/' : nx === 'u' ? String.fromCharCode(parseInt(text.substr(j + 2, 4), 16)) : nx;
      if (nx === 'u') {
        raw += text.substr(j, 6);
        j += 6;
        continue;
      }
      raw += c + nx;
      j += 2;
      continue;
    }
    if (c === '"') {
      raw += '"';
      return { value: value, raw: raw, end: j + 1 };
    }
    value += c;
    raw += c;
    j++;
  }
  return { value: value, raw: raw, end: j };
}

function skipSpace(text, i) {
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

// End index (exclusive) of the value starting at i.
function scanValueEnd(text, i) {
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i = readString(text, i).end;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (depth === 0) return i;
      depth--;
    } else if (c === ',' && depth === 0) return i;
    i++;
  }
  return i;
}

export function topLevelEntries(text) {
  const entries = [];
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"') {
      const str = readString(text, i);
      const after = skipSpace(text, str.end);
      if (depth === 1 && text[after] === ':') {
        const start = skipSpace(text, after + 1);
        const end = scanValueEnd(text, start);
        entries.push({ key: str.value, start: start, end: end, value: text.slice(start, end).trim() });
        i = end;
        continue;
      }
      i = str.end;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return entries;
}

export function valueKind(raw) {
  const t = raw.trim();
  if (t === 'true' || t === 'false') return 'boolean';
  if (t === 'null') return 'null';
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return 'number';
  if (t[0] === '"') return 'string';
  return 'complex';
}

// Replace the value of one top-level key, adding the key when it is missing.
export function setTopLevelValue(text, key, literalText) {
  const entries = topLevelEntries(text);
  const found = entries.filter((e) => e.key === key)[0];
  if (found) return text.slice(0, found.start) + literalText + text.slice(found.end);

  const close = text.lastIndexOf('}');
  if (close < 0) throw new Error('в файле нет объекта верхнего уровня');
  let before = close - 1;
  while (before >= 0 && /\s/.test(text[before])) before--;
  const needsComma = entries.length > 0 && text[before] !== ',';
  const indent = /^\s+/m.exec(text) ? '  ' : '  ';
  const insert = (needsComma ? ',\n' : '') + indent + JSON.stringify(key) + ': ' + literalText + '\n';
  return text.slice(0, close) + insert + text.slice(close);
}

export function toLiteral(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}
