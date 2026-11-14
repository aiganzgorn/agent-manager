// Markdown agent files for opencode: YAML-ish frontmatter + prompt body.
// Known keys are parsed into fields; anything else is preserved verbatim so
// V1 files (permission:, tools:, temperature:) survive a save untouched.

const KNOWN = [
  'description',
  'mode',
  'model',
  'color',
  'steps',
  'hidden',
  'disabled',
  'permissions',
];

const BOOL_KEYS = ['hidden', 'disabled'];
const NUMBER_KEYS = ['steps'];

export function parseAgentFile(text) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  if (lines[0].trim() !== '---') {
    return { fields: {}, extra: '', prompt: src.replace(/^\n+/, ''), hadFrontmatter: false };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return { fields: {}, extra: '', prompt: src.replace(/^\n+/, ''), hadFrontmatter: false };
  }

  const fields = {};
  let extra = '';
  for (const block of splitBlocks(lines.slice(1, close))) {
    if (!block.key || KNOWN.indexOf(block.key) < 0) {
      extra += block.raw + '\n';
      continue;
    }
    fields[block.key] = parseValue(block);
  }

  const prompt = lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  return { fields, extra, prompt, hadFrontmatter: true };
}

function splitBlocks(fmLines) {
  const blocks = [];
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/.exec(line);
    if (m) {
      blocks.push({ key: m[1], first: m[2], lines: [], raw: line });
    } else if (blocks.length) {
      const b = blocks[blocks.length - 1];
      b.lines.push(line);
      b.raw += '\n' + line;
    } else if (line.trim()) {
      blocks.push({ key: null, first: '', lines: [], raw: line });
    }
  }
  return blocks;
}

function parseValue(block) {
  const key = block.key;
  const isItem = (l) => /^\s*-\s*(.*)$/.test(l);
  const hasItems = block.lines.some(isItem);

  let value;
  if (hasItems) {
    value = parseList(block.lines);
  } else if (/^[|>][-+]?$/.test(block.first.trim())) {
    value = parseBlockScalar(block.first.trim()[0], block.lines);
  } else {
    const parts = [block.first.trim()];
    for (const l of block.lines) {
      const t = l.trim();
      if (t && !t.startsWith('#')) parts.push(t);
    }
    value = unquote(parts.filter(Boolean).join(' '));
  }

  if (BOOL_KEYS.indexOf(key) >= 0) return value === true || value === 'true' || value === 'yes';
  if (NUMBER_KEYS.indexOf(key) >= 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return value;
}

function parseList(lines) {
  const items = [];
  let cur = null;
  for (const line of lines) {
    const m = /^\s*-\s*(.*)$/.exec(line);
    if (m) {
      cur = { head: m[1].trim(), lines: [] };
      items.push(cur);
    } else if (cur && line.trim()) {
      cur.lines.push(line.trim());
    }
  }
  const isMap = items.some((it) => /^[A-Za-z_][A-Za-z0-9_.-]*:/.test(it.head));
  if (!isMap) return items.map((it) => unquote([it.head].concat(it.lines).join(' ').trim())).filter(Boolean);

  return items.map((it) => {
    const obj = {};
    const pairs = [it.head].concat(it.lines);
    for (const pair of pairs) {
      const m = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/.exec(pair);
      if (m) obj[m[1]] = unquote(m[2].trim());
    }
    return obj;
  });
}

function parseBlockScalar(style, lines) {
  const body = lines.map((l) => l.replace(/^\s{0,2}/, ''));
  return style === '|' ? body.join('\n').replace(/\s+$/, '') : body.join(' ').trim();
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2) {
    if (t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
    if (t[0] === '"' && t[t.length - 1] === '"') {
      try {
        return JSON.parse(t);
      } catch {
        return t.slice(1, -1);
      }
    }
  }
  return t;
}

export function stringifyAgentFile(fields, extra, prompt) {
  const f = fields || {};
  const lines = [];
  const put = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    lines.push(k + ': ' + scalar(v));
  };

  put('description', f.description);
  put('mode', f.mode);
  put('model', f.model);
  put('color', f.color);
  put('steps', f.steps);
  if (f.hidden) lines.push('hidden: true');
  if (f.disabled) lines.push('disabled: true');

  const perms = Array.isArray(f.permissions) ? f.permissions.filter((p) => p && p.action) : [];
  if (perms.length) {
    lines.push('permissions:');
    for (const p of perms) {
      lines.push('  - action: ' + scalar(p.action));
      if (p.resource) lines.push('    resource: ' + scalar(p.resource));
      if (p.effect) lines.push('    effect: ' + scalar(p.effect));
    }
  }

  const extraTrim = String(extra || '').trim();
  let out = '---\n' + lines.join('\n') + '\n';
  if (extraTrim) out += extraTrim + '\n';
  out += '---\n';
  const body = String(prompt || '').trim();
  if (body) out += '\n' + body + '\n';
  return out;
}

function scalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return "''";
  if (/^(true|false|yes|no|on|off|null|~)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s)) return quote(s);
  if (!/^[\p{L}\p{N} ._\/()-]+$/u.test(s)) return quote(s);
  if (/^\s|\s$/.test(s)) return quote(s);
  return s;
}

function quote(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

export const KNOWN_FIELDS = KNOWN.slice();
export const V1_KEYS = ['permission', 'tools', 'temperature', 'top_p', 'prompt', 'disable', 'maxSteps'];
