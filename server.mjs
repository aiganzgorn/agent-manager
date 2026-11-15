#!/usr/bin/env node
// Agent manager for opencode V2: browse and edit markdown agents that opencode
// itself reads, so a save is picked up without any conversion step.
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { parseAgentFile, stringifyAgentFile, V1_KEYS } from './frontmatter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4737);
const HOME = os.homedir();
const GLOBAL = path.join(HOME, '.config', 'opencode');
const ROOT_DEFAULT = path.resolve(process.argv[2] || process.cwd());

// ---- discovery -------------------------------------------------------------

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walkMd(dir, base, out) {
  if (!isDir(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, base, out);
    else if (e.isFile() && e.name.endsWith('.md')) {
      out.push({ file: full, id: path.relative(base, full).split(path.sep).join('/').replace(/\.md$/, '') });
    }
  }
  return out;
}

function agentDirs(scopeDir) {
  return { live: path.join(scopeDir, 'agents'), legacy: path.join(scopeDir, 'agent') };
}

function loadAgent(found, scope, projectId) {
  let text = '';
  let st = null;
  try {
    text = fs.readFileSync(found.file, 'utf8');
    st = fs.statSync(found.file);
  } catch {
    return null;
  }
  const parsed = parseAgentFile(text);
  const v1 = V1_KEYS.filter((k) => {
    const re = new RegExp('^' + k + ':', 'm');
    return re.test(parsed.extra);
  });
  return {
    id: found.id,
    file: found.file,
    scope,
    projectId: projectId || null,
    legacy: found.file.indexOf(path.sep + 'agent' + path.sep) >= 0,
    fields: parsed.fields,
    extra: parsed.extra,
    prompt: parsed.prompt,
    v1,
    mtime: st ? st.mtimeMs : 0,
  };
}

function collectAgents(scopeDir, scope, projectId) {
  const dirs = agentDirs(scopeDir);
  const found = [];
  walkMd(dirs.live, dirs.live, found);
  walkMd(dirs.legacy, dirs.legacy, found);
  return found.map((f) => loadAgent(f, scope, projectId)).filter(Boolean).sort(byId);
}

function byId(a, b) {
  return a.id.localeCompare(b.id);
}

// Agents defined inline in opencode.json(c): read-only here, since rewriting a
// JSONC file with comments is not safe enough for an editor.
function configAgents(scopeDir) {
  const out = [];
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(scopeDir, name);
    if (!fs.existsSync(file)) continue;
    let doc;
    try {
      doc = parseJsonc(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const agents = doc && doc.agents;
    if (!agents || typeof agents !== 'object') continue;
    for (const id of Object.keys(agents)) {
      const a = agents[id] || {};
      out.push({
        id,
        file,
        fields: {
          description: a.description || '',
          mode: a.mode || '',
          model: typeof a.model === 'string' ? a.model : a.model ? JSON.stringify(a.model) : '',
          disabled: !!a.disabled,
          hidden: !!a.hidden,
        },
      });
    }
  }
  return out.sort(byId);
}

function projectDirs(root) {
  const dirs = [];
  const hasOc = (d) => fs.existsSync(path.join(d, '.opencode')) || fs.existsSync(path.join(d, 'opencode.json')) || fs.existsSync(path.join(d, 'opencode.jsonc'));
  if (hasOc(root)) dirs.push(root);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (hasOc(full)) dirs.push(full);
  }
  return dirs;
}

function buildState(root) {
  const globalAgents = collectAgents(GLOBAL, 'global', null);
  const projects = projectDirs(root).map((dir) => ({
    id: dir,
    label: path.relative(root, dir) || path.basename(dir),
    agents: collectAgents(path.join(dir, '.opencode'), 'project', dir),
    configAgents: configAgents(path.join(dir, '.opencode')).concat(configAgents(dir)),
  }));
  const seen = new Set();
  const uniqueConfig = [];
  for (const p of projects) {
    for (const a of p.configAgents) {
      const key = a.file + '#' + a.id;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueConfig.push(a);
    }
  }
  return {
    root,
    globalDir: GLOBAL,
    globalAgents,
    globalConfigAgents: configAgents(GLOBAL),
    configAgents: uniqueConfig,
    projects,
  };
}

function parseJsonc(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

// ---- writes ----------------------------------------------------------------

function allowedAgentDirs(root) {
  const dirs = [];
  const push = (d) => {
    const live = agentDirs(d).live;
    const legacy = agentDirs(d).legacy;
    dirs.push(live, legacy);
  };
  push(GLOBAL);
  push(path.join(root, '.opencode'));
  for (const p of projectDirs(root)) push(path.join(p, '.opencode'));
  return dirs;
}

function insideAny(file, dirs) {
  const abs = path.resolve(file);
  return dirs.some((d) => {
    const base = path.resolve(d) + path.sep;
    return abs.startsWith(base);
  });
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function validId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

// ---- http ------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type) {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function saveAgent(payload, create) {
  const root = path.resolve(String(payload.root || ROOT_DEFAULT));
  const dirs = allowedAgentDirs(root);
  const fields = payload.fields || {};
  const prompt = payload.prompt || '';

  if (create) {
    if (!validId(payload.id)) throw err(400, 'Имя агента: только латиница в нижнем регистре, цифры, точка, дефис, подчёркивание.');
    if (payload.projectId && !dirs.some((d) => path.resolve(d) === path.resolve(path.join(payload.projectId, '.opencode', 'agents')))) {
      throw err(400, 'Проект не найден (нет .opencode рядом).');
    }
    const dir = payload.projectId ? path.join(payload.projectId, '.opencode', 'agents') : path.join(GLOBAL, 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, payload.id + '.md');
    if (fs.existsSync(file)) throw err(409, 'Агент с таким именем уже существует.');
    writeAtomic(file, stringifyAgentFile(fields, '', prompt));
    return { file };
  }

  const file = path.resolve(String(payload.file || ''));
  if (!file.endsWith('.md') || !insideAny(file, dirs)) throw err(403, 'Этот файл не похож на файл агента opencode.');
  if (!fs.existsSync(file)) throw err(404, 'Файл не найден — возможно, его удалили.');
  if (payload.mtime && Math.abs(fs.statSync(file).mtimeMs - Number(payload.mtime)) > 1) {
    throw err(409, 'Файл изменился на диске после загрузки. Перечитай агента и повтори правку.');
  }
  const current = parseAgentFile(fs.readFileSync(file, 'utf8'));
  writeAtomic(file, stringifyAgentFile(fields, current.extra, prompt));
  return { file };
}

// Resolved agents straight from opencode: merged config, built-in defaults and
// the effective system prompt. Cached, because each call spawns the CLI.
// The CLI drops the tail of large output when stdout is a pipe (v2.1.4), so it
// writes to a temp file instead: a regular file is written whole.
let resolvedCache = { at: 0, agents: null };

function resolvedAgents(attempt) {
  attempt = attempt || 1;
  if (resolvedCache.agents && Date.now() - resolvedCache.at < 60000) {
    return Promise.resolve({ agents: resolvedCache.agents });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const outFile = path.join(os.tmpdir(), 'agent-manager-resolved-' + process.pid + '-' + attempt + '.json');
    let fd;
    try {
      fd = fs.openSync(outFile, 'w');
    } catch (e) {
      return done({ error: 'Не открылся временный файл: ' + e.message });
    }
    const finish = () => {
      try {
        fs.closeSync(fd);
      } catch {}
      let text = '';
      try {
        text = fs.readFileSync(outFile, 'utf8');
      } catch {}
      try {
        fs.unlinkSync(outFile);
      } catch {}
      return text;
    };

    let child;
    try {
      child = spawn(process.env.OPENCODE_BIN || 'opencode', ['api', 'get', '/api/agent'], { stdio: ['ignore', fd, 'pipe'] });
    } catch (e) {
      finish();
      return done({ error: 'opencode не запускается: ' + e.message });
    }

    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish();
      done({ error: 'opencode api не ответил за 20 секунд.' });
    }, 20000);

    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish();
      done({ error: 'opencode CLI не найден: ' + e.message + '. Запусти сервер из терминала, где opencode в PATH.' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = finish();
      if (code !== 0) return done({ error: err.trim() || 'opencode api завершился с кодом ' + code });
      try {
        const parsed = JSON.parse(text);
        const agents = parsed.data || parsed;
        if (!Array.isArray(agents)) throw new Error('неожиданный ответ');
        resolvedCache = { at: Date.now(), agents: agents };
        done({ agents: agents });
      } catch (e) {
        // the first call can come back empty while the service boots
        if (attempt < 2) return done(resolvedAgents(attempt + 1));
        done({ error: 'Не разобрала ответ opencode: ' + e.message });
      }
    });
  });
}

function err(code, message) {
  const e = new Error(message);
  e.status = code;
  return e;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/api/state') {
      const root = path.resolve(url.searchParams.get('root') || ROOT_DEFAULT);
      if (!isDir(root)) throw err(400, 'Папка не найдена: ' + root);
      return send(res, 200, buildState(root));
    }
    if (url.pathname === '/api/preview' && req.method === 'POST') {
      const payload = await readBody(req);
      let extra = payload.extra || '';
      if (payload.file) {
        const dirs = allowedAgentDirs(path.resolve(String(payload.root || ROOT_DEFAULT)));
        const file = path.resolve(String(payload.file));
        if (insideAny(file, dirs) && fs.existsSync(file)) extra = parseAgentFile(fs.readFileSync(file, 'utf8')).extra;
      }
      return send(res, 200, { text: stringifyAgentFile(payload.fields || {}, extra, payload.prompt || '') });
    }
    if (url.pathname === '/api/resolved') {
      if (url.searchParams.get('fresh')) resolvedCache = { at: 0, agents: null };
      return send(res, 200, await resolvedAgents());
    }
    if (url.pathname === '/api/save' && req.method === 'POST') {
      return send(res, 200, saveAgent(await readBody(req), false));
    }
    if (url.pathname === '/api/create' && req.method === 'POST') {
      return send(res, 200, saveAgent(await readBody(req), true));
    }
    if (url.pathname.indexOf('/api/') === 0) return send(res, 404, { error: 'Нет такого метода.' });

    return serveStatic(url.pathname, res);
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'Ошибка' });
  }
});

function serveStatic(urlPath, res) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(HERE, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(HERE, 'public') + path.sep)) return send(res, 403, 'no');
  if (!fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

server.listen(PORT, '127.0.0.1', () => {
  const link = 'http://127.0.0.1:' + PORT + '/';
  console.log('agent-manager: ' + link);
  console.log('проекты сканируются в: ' + ROOT_DEFAULT);
  if (!process.env.NO_OPEN) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      spawn(opener, [link], { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* открыть вручную */
    }
  }
});
