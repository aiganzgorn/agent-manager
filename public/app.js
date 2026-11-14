const $ = (id) => document.getElementById(id);

const S = {
  root: new URLSearchParams(location.search).get('root') || '',
  state: null,
  current: null, // { agent, isNew, projectId }
  dirty: false,
  previewTimer: null,
};

const ACTIONS = ['shell', 'edit', 'subagent', 'read', 'glob', 'grep', 'webfetch', 'websearch', 'skill', '*'];

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function toast(text, bad) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

// ---- loading ---------------------------------------------------------------

async function loadState() {
  try {
    const q = S.root ? '?root=' + encodeURIComponent(S.root) : '';
    S.state = await api('/api/state' + q);
    S.root = S.state.root;
    $('rootInput').value = S.state.root;
    $('scopeSub').textContent = 'глобально: ' + S.state.globalDir.replace(/^\/Users\/[^/]+/, '~');
    renderTree();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderTree() {
  const tree = $('tree');
  tree.innerHTML = '';
  if (!S.state) return;

  tree.appendChild(group('Глобальные', S.state.globalAgents, S.state.globalConfigAgents, null));

  for (const p of S.state.projects) {
    const label = p.label === '.' ? S.state.root.split('/').pop() : p.label;
    tree.appendChild(group(label, p.agents, p.configAgents, p.id));
  }

  if (!S.state.projects.length) {
    const note = document.createElement('div');
    note.className = 'group-head';
    note.style.textTransform = 'none';
    note.style.letterSpacing = '0';
    note.textContent = 'Проектов с .opencode не нашлось — глобальные агенты выше.';
    tree.appendChild(note);
  }
}

function group(label, agents, configAgents, projectId) {
  const wrap = document.createElement('div');
  wrap.className = 'group';

  const head = document.createElement('div');
  head.className = 'group-head';
  head.innerHTML = '<span class="label"></span><span class="count"></span>';
  head.querySelector('.label').textContent = label;
  head.querySelector('.label').title = label;
  head.querySelector('.count').textContent = agents.length + (configAgents || []).length || '';

  const add = document.createElement('button');
  add.className = 'add';
  add.textContent = '+ агент';
  add.title = 'Создать агента в этой группе';
  add.onclick = () => startNew(projectId);
  head.appendChild(add);
  wrap.appendChild(head);

  for (const a of agents) wrap.appendChild(row(a));
  for (const a of configAgents || []) wrap.appendChild(row(a, true));

  return wrap;
}

function row(a, isConfig) {
  const b = document.createElement('button');
  const mode = (a.fields && a.fields.mode) || 'primary';
  b.className = 'agent-row m-' + mode;
  if (S.current && S.current.agent && S.current.agent.file === a.file && S.current.agent.id === a.id) b.classList.add('active');
  b.innerHTML = '<span class="dot"></span><span class="name"></span><span class="tag"></span>';
  b.querySelector('.name').textContent = a.id;
  b.querySelector('.name').title = a.fields.description || a.id;
  const tag = b.querySelector('.tag');
  tag.textContent = isConfig ? 'json' : mode === 'subagent' ? 'sub' : mode === 'all' ? 'all' : '';
  if (a.v1 && a.v1.length) {
    tag.textContent = 'v1';
    tag.className = 'tag v1';
    tag.title = 'Старые поля: ' + a.v1.join(', ');
  }
  b.onclick = () => (isConfig ? openConfigAgent(a) : openAgent(a));
  return b;
}

// ---- editor ----------------------------------------------------------------

function openAgent(agent) {
  if (!guardDirty()) return;
  S.current = { agent: agent, isNew: false, projectId: agent.projectId };
  $('empty').hidden = true;
  $('editor').hidden = false;
  $('idField').hidden = true;

  const badges = [];
  badges.push('<span class="badge ' + (agent.scope === 'global' ? 'global' : 'project') + '">' + (agent.scope === 'global' ? 'глобальный' : 'проект') + '</span>');
  if (agent.legacy) badges.push('<span class="badge">папка agent/ (старая)</span>');
  if (agent.v1 && agent.v1.length) badges.push('<span class="badge v1">V1-поля</span>');
  renderHead(agent.id, badges.join(''), agent.file);

  fillForm(agent.fields, agent.prompt);

  const extra = $('extraBox');
  if (agent.extra && agent.extra.trim()) {
    extra.hidden = false;
    $('f_extra').textContent = agent.extra.trim();
  } else {
    extra.hidden = true;
  }

  banner(
    agent.v1 && agent.v1.length
      ? 'В файле поля старого формата (' + agent.v1.join(', ') + '). Они сохранятся дословно, но V2 их не рекомендует — права лучше задавать через permissions.'
      : '',
    'warn'
  );

  setDirty(false);
  renderTree();
  refreshPreview();
}

function openConfigAgent(a) {
  if (!guardDirty()) return;
  S.current = { agent: a, isNew: false, config: true };
  $('empty').hidden = true;
  $('editor').hidden = false;
  $('idField').hidden = true;
  renderHead(a.id, '<span class="badge project">из opencode.json</span>', a.file);
  fillForm(a.fields, '');
  $('extraBox').hidden = true;
  banner('Этот агент задан внутри opencode.json. Редактор не переписывает JSON-конфиги — правь файл руками, чтобы не потерять комментарии и остальные настройки.', 'warn');
  setDirty(false);
  renderTree();
}

function startNew(projectId) {
  if (!guardDirty()) return;
  S.current = { agent: { id: '', fields: {}, prompt: '' }, isNew: true, projectId };
  $('empty').hidden = true;
  $('editor').hidden = false;
  $('idField').hidden = false;
  renderHead('Новый агент', '<span class="badge ' + (projectId ? 'project' : 'global') + '">' + (projectId ? 'в проекте' : 'глобальный') + '</span>', projectId ? projectId + '/.opencode/agents/' : '~/.config/opencode/agents/');
  fillForm({ mode: 'subagent', permissions: [] }, '');
  $('extraBox').hidden = true;
  banner('', 'warn');
  setDirty(false);
  $('f_id').focus();
  renderTree();
  refreshPreview();
}

function renderHead(title, badgesHtml, pathText) {
  $('agentTitle').textContent = title;
  $('agentBadges').innerHTML = badgesHtml || '';
  $('agentPath').textContent = pathText || '';
}

function fillForm(fields, prompt) {
  const f = fields || {};
  $('f_description').value = f.description || '';
  $('f_mode').value = f.mode || '';
  $('f_model').value = f.model || '';
  $('f_steps').value = f.steps || '';
  $('f_hidden').checked = !!f.hidden;
  $('f_colorText').value = f.color || '';
  $('f_color').value = /^#[0-9a-f]{6}$/i.test(f.color || '') ? f.color : '#7fb069';
  $('f_prompt').value = prompt || '';
  renderPerms(Array.isArray(f.permissions) ? f.permissions : []);
}

function renderPerms(rows) {
  const box = $('perms');
  box.innerHTML = '';
  for (const r of rows) box.appendChild(permRow(r));
}

function permRow(r) {
  const row = document.createElement('div');
  row.className = 'perm';

  const action = document.createElement('input');
  action.className = 'p_action';
  action.setAttribute('list', 'actions');
  action.placeholder = 'shell';
  action.value = (r && r.action) || '';

  const resource = document.createElement('input');
  resource.className = 'p_resource';
  resource.placeholder = '* или git push *';
  resource.value = (r && r.resource) || '';

  const effect = document.createElement('select');
  effect.className = 'p_effect';
  for (const e of ['allow', 'ask', 'deny']) {
    const o = document.createElement('option');
    o.value = e;
    o.textContent = e;
    effect.appendChild(o);
  }
  effect.value = (r && r.effect) || 'allow';

  const kill = document.createElement('button');
  kill.className = 'kill';
  kill.textContent = '×';
  kill.title = 'Убрать правило';
  kill.onclick = () => {
    row.remove();
    setDirty(true);
    schedulePreview();
  };

  row.append(action, resource, effect, kill);
  return row;
}

function readForm() {
  const fields = {};
  const val = (id) => $(id).value.trim();
  if (val('f_description')) fields.description = val('f_description');
  if (val('f_mode')) fields.mode = val('f_mode');
  if (val('f_model')) fields.model = val('f_model');
  if (val('f_colorText')) fields.color = val('f_colorText');
  const steps = Number(val('f_steps'));
  if (val('f_steps') && Number.isFinite(steps) && steps > 0) fields.steps = steps;
  if ($('f_hidden').checked) fields.hidden = true;

  const perms = [];
  for (const row of document.querySelectorAll('.perm')) {
    const action = row.querySelector('.p_action').value.trim();
    if (!action) continue;
    perms.push({
      action: action,
      resource: row.querySelector('.p_resource').value.trim() || '*',
      effect: row.querySelector('.p_effect').value,
    });
  }
  if (perms.length) fields.permissions = perms;
  return { fields: fields, prompt: $('f_prompt').value };
}

// ---- dirty / preview / save ------------------------------------------------

function setDirty(on) {
  S.dirty = on;
  $('dirtyDot').classList.toggle('on', on);
  $('saveBtn').disabled = !on && !(S.current && S.current.isNew);
}

function guardDirty() {
  return !S.dirty || confirm('Есть несохранённые правки. Уйти без сохранения?');
}

function schedulePreview() {
  clearTimeout(S.previewTimer);
  S.previewTimer = setTimeout(refreshPreview, 250);
}

async function refreshPreview() {
  if ($('preview').hidden || !S.current) return;
  const { fields, prompt } = readForm();
  try {
    const data = await api('/api/preview', {
      root: S.root,
      file: S.current.config ? '' : S.current.agent.file,
      fields: fields,
      prompt: prompt,
    });
    $('previewText').textContent = data.text;
  } catch (e) {
    $('previewText').textContent = '// ' + e.message;
  }
}

async function save() {
  if (!S.current) return;
  if (S.current.config) {
    toast('Этот агент живёт в opencode.json — правь файл: ' + S.current.agent.file, true);
    return;
  }
  const data = readForm();
  const btn = $('saveBtn');
  btn.disabled = true;
  try {
    if (S.current.isNew) {
      const id = $('f_id').value.trim();
      const res = await api('/api/create', {
        root: S.root,
        id: id,
        projectId: S.current.projectId || null,
        fields: data.fields,
        prompt: data.prompt,
      });
      await loadState();
      const created = findAgent(res.file);
      if (created) openAgent(created);
      toast('Агент создан — opencode подхватит его сам.');
    } else {
      await api('/api/save', {
        root: S.root,
        file: S.current.agent.file,
        mtime: S.current.agent.mtime,
        fields: data.fields,
        prompt: data.prompt,
      });
      await loadState();
      const saved = findAgent(S.current.agent.file);
      if (saved) openAgent(saved);
      toast('Сохранено. Перезапуск не нужен; если TUI не увидел — /reload.');
    }
    banner('', '');
  } catch (e) {
    banner(e.message, 'bad');
    toast(e.message, true);
    btn.disabled = false;
  }
}

function findAgent(file) {
  if (!S.state) return null;
  const all = S.state.globalAgents.concat(...S.state.projects.map((p) => p.agents));
  return all.find((a) => a.file === file) || null;
}

function banner(text, kind) {
  const el = $('banner');
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = 'banner' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

// ---- builtins --------------------------------------------------------------

function showBuiltins() {
  if (!guardDirty()) return;
  S.current = null;
  $('empty').hidden = true;
  $('editor').hidden = true;
  const main = document.querySelector('.main');
  let panel = $('builtinsPanel');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'builtinsPanel';
    panel.className = 'editor';
    main.appendChild(panel);
  }
  panel.hidden = false;
  panel.innerHTML = '<div class="editor-head"><div class="head-line"><h1>Встроенные агенты</h1></div></div>';
  const list = document.createElement('div');
  list.className = 'editor-body';
  list.style.gridTemplateColumns = '1fr';
  for (const b of S.state ? S.state.builtins : []) {
    const card = document.createElement('div');
    card.className = 'help';
    card.style.position = 'static';
    card.innerHTML = '<h3><code>' + b.id + '</code> <span class="muted">· ' + b.mode + '</span></h3><p>' + b.description + '</p>';
    list.appendChild(card);
  }
  const note = document.createElement('div');
  note.className = 'help';
  note.style.position = 'static';
  note.innerHTML = '<h3>Как их менять</h3><p>Встроенных агентов нельзя редактировать файлом. Чтобы поменять поведение — добавь агента с тем же id в <code>opencode.json</code> (ключ <code>agents</code>); поля сольются с встроенным.</p>';
  list.appendChild(note);
  panel.appendChild(list);
  renderTree();
}

// ---- wiring ----------------------------------------------------------------

const formRoot = document.querySelector('.editor-body');
formRoot.addEventListener('input', (e) => {
  if (e.target.id === 'f_color') {
    $('f_colorText').value = e.target.value;
  } else if (e.target.id === 'f_colorText') {
    if (/^#[0-9a-f]{6}$/i.test(e.target.value)) $('f_color').value = e.target.value;
  }
  if (!$('editor').hidden) {
    setDirty(true);
    schedulePreview();
  }
});

$('addPerm').onclick = () => {
  $('perms').appendChild(permRow({ effect: 'allow' }));
  setDirty(true);
  schedulePreview();
};

$('saveBtn').onclick = save;

$('previewBtn').onclick = () => {
  const p = $('preview');
  p.hidden = !p.hidden;
  $('previewBtn').textContent = p.hidden ? 'Показать файл' : 'Скрыть файл';
  refreshPreview();
};
$('closePreview').onclick = () => {
  $('preview').hidden = true;
  $('previewBtn').textContent = 'Показать файл';
};

$('copyPath').onclick = () => {
  const p = $('agentPath').textContent;
  if (!p) return;
  navigator.clipboard.writeText(p).then(() => toast('Путь скопирован'), () => toast(p));
};

$('rescanBtn').onclick = () => {
  S.root = $('rootInput').value.trim();
  loadState();
};
$('rootInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    S.root = $('rootInput').value.trim();
    loadState();
  }
});

$('builtinsBtn').onclick = showBuiltins;

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!$('editor').hidden) save();
  }
});

const dl = document.createElement('datalist');
dl.id = 'actions';
for (const a of ACTIONS) {
  const o = document.createElement('option');
  o.value = a;
  dl.appendChild(o);
}
document.body.appendChild(dl);

loadState();
