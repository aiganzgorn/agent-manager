const $ = (id) => document.getElementById(id);

const S = {
  root: new URLSearchParams(location.search).get('root') || '',
  tab: 'agents',
  plugins: null,
  settings: null,
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
    renderSidebar();
    if (S.tab !== 'agents') renderPanel(S.tab);
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

function hideBuiltins() {
  const panel = $('builtinsPanel');
  if (panel) panel.hidden = true;
}

function openAgent(agent) {
  if (!guardDirty()) return;
  hideBuiltins();
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
  hideBuiltins();
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
  hideBuiltins();
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

const CORE_IDS = ['build', 'plan'];
const CORE_SUBS = ['general', 'explore'];

function showBuiltins() {
  if (!guardDirty()) return;
  S.current = null;
  $('empty').hidden = true;
  $('editor').hidden = true;

  let panel = $('builtinsPanel');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'builtinsPanel';
    panel.className = 'editor';
    document.querySelector('.main').appendChild(panel);
  }
  panel.hidden = false;
  panel.innerHTML =
    '<header class="editor-head"><div class="head-line"><h1>Как opencode видит агентов</h1><span class="grow"></span>' +
    '<button id="reloadResolved" class="ghost">Перечитать</button></div>' +
    '<div class="pathline"><code>источник: opencode api get /api/agent — собранные агенты, их промпты и итоговые права</code></div></header>' +
    '<div id="builtinList" class="cards"><div class="no-prompt">Читаю у opencode…</div></div>';
  $('reloadResolved').onclick = () => loadResolved(true);
  renderTree();
  loadResolved(true);
}

async function loadResolved(fresh) {
  const list = $('builtinList');
  if (!list) return;
  list.innerHTML = '<div class="no-prompt">Читаю у opencode…</div>';
  let data;
  try {
    data = await api('/api/resolved' + (fresh ? '?fresh=1' : ''));
  } catch (e) {
    data = { error: e.message };
  }
  if (data.error) {
    list.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'no-prompt';
    box.style.color = '#e0a0a0';
    box.textContent = 'Не получилось спросить opencode: ' + data.error;
    list.appendChild(box);
    return;
  }
  renderResolved(list, data.agents || []);
}

function renderResolved(list, agents) {
  list.innerHTML = '';
  const core = agents.filter((a) => CORE_IDS.indexOf(a.id) >= 0);
  const coreSubs = agents.filter((a) => CORE_SUBS.indexOf(a.id) >= 0);
  const hidden = agents.filter((a) => a.hidden && CORE_IDS.indexOf(a.id) < 0 && CORE_SUBS.indexOf(a.id) < 0);
  const custom = agents.filter((a) => !a.hidden && CORE_IDS.indexOf(a.id) < 0 && CORE_SUBS.indexOf(a.id) < 0);

  const intro = document.createElement('div');
  intro.className = 'no-prompt';
  intro.innerHTML =
    'Агент — это описание, системный промпт, модель и правила. Встроенные заданы в самом opencode, свои — файлами <code>.md</code>. ' +
    'Здесь показано то, что opencode собрал на самом деле: файлы, <code>opencode.json</code> и встроенные значения уже слиты.';
  list.appendChild(intro);

  addSection(list, 'Основные агенты', 'Работают как основной агент сессии. Промпт у них общий — из харнесса, а не из конфига.', core);
  addSection(list, 'Встроенные субагенты', 'Их вызывает основная модель через инструмент subagent.', coreSubs);
  addSection(list, 'Служебные и скрытые', 'hidden: true — в списках не видны, но участвуют в работе (сжатие контекста, заголовки).', hidden);
  addSection(list, 'Твои агенты', 'Файлы и настройки из конфига — в том виде, в каком их получит модель.', custom);
}

function addSection(list, title, note, agents) {
  if (!agents.length) return;
  const h = document.createElement('div');
  h.className = 'section-title';
  h.textContent = title;
  list.appendChild(h);
  const p = document.createElement('p');
  p.className = 'section-note';
  p.textContent = note;
  list.appendChild(p);
  for (const a of agents) list.appendChild(agentCard(a));
}

function agentCard(a) {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('h3');
  const name = document.createElement('code');
  name.textContent = a.id;
  head.appendChild(name);
  const mode = document.createElement('span');
  mode.className = 'badge';
  mode.textContent = a.mode || 'primary';
  head.appendChild(mode);
  if (a.hidden) {
    const hid = document.createElement('span');
    hid.className = 'badge v1';
    hid.textContent = 'hidden';
    head.appendChild(hid);
  }
  if (a.model) {
    const m = document.createElement('span');
    m.className = 'badge';
    m.textContent = typeof a.model === 'string' ? a.model : (a.model.providerID || '') + '/' + (a.model.modelID || a.model.model || '');
    head.appendChild(m);
  }
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if (a.system) {
    const copy = document.createElement('button');
    copy.className = 'ghost tiny';
    copy.textContent = 'скопировать промпт';
    copy.onclick = () =>
      navigator.clipboard.writeText(a.system).then(
        () => toast('Промпт скопирован'),
        () => toast('Не вышло скопировать', true)
      );
    actions.appendChild(copy);
  }
  head.appendChild(actions);
  card.appendChild(head);

  if (a.description) {
    const d = document.createElement('p');
    d.className = 'desc';
    d.textContent = a.description;
    card.appendChild(d);
  }

  if (a.system) {
    const pre = document.createElement('pre');
    pre.className = 'prompt';
    pre.textContent = a.system;
    card.appendChild(pre);
  } else {
    const no = document.createElement('div');
    no.className = 'no-prompt';
    no.textContent =
      'Своего системного промпта нет. opencode подставляет такому агенту общий базовый промпт харнесса (он вшит в бинарь opencode) плюс напоминания про активный режим. ' +
      'В конфиге это поле пустое, так что переопределять тут нечего — свои инструкции добавляются как system / тело .md-файла.';
    card.appendChild(no);
  }

  const rules = Array.isArray(a.permissions) ? a.permissions : (a.permissions && a.permissions.rules) || [];
  if (rules.length) {
    const box = document.createElement('div');
    box.className = 'rules';
    for (const r of rules.slice(0, 8)) {
      const chip = document.createElement('span');
      chip.className = 'rule ' + (r.effect || '');
      chip.textContent = (r.action || '*') + ': ' + (r.resource || '*') + ' → ' + (r.effect || 'allow');
      box.appendChild(chip);
    }
    if (rules.length > 8) {
      const more = document.createElement('span');
      more.className = 'rule';
      more.textContent = '+' + (rules.length - 8) + ' ещё';
      box.appendChild(more);
    }
    card.appendChild(box);
  }

  return card;
}


// ---- tabs, skills, plugins, settings ---------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function panelHeader(title, sub) {
  const head = el('header', 'editor-head');
  const line = el('div', 'head-line');
  line.appendChild(el('h1', null, title));
  head.appendChild(line);
  if (sub) {
    const p = el('div', 'pathline');
    p.appendChild(el('code', null, sub));
    head.appendChild(p);
  }
  return head;
}

function noteCard(html) {
  const div = el('div', 'no-prompt');
  div.innerHTML = html;
  return div;
}

const TAB_TITLES = { skills: 'Скиллы', plugins: 'Плагины', settings: 'Настройки' };

function setTab(tab) {
  if (tab === S.tab) return;
  if (tab !== 'agents' && !guardDirty()) return;
  S.tab = tab;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  $('builtinsBtn').hidden = tab !== 'agents';
  if (tab === 'agents') {
    const panel = $('panel');
    if (panel) panel.hidden = true;
    $('editor').hidden = !S.current;
    $('empty').hidden = !!S.current;
    renderTree();
    return;
  }
  $('editor').hidden = true;
  $('empty').hidden = true;
  const panel = $('panel');
  panel.hidden = false;
  renderSidebar();
  renderPanel(tab);
}

function renderSidebar() {
  if (S.tab === 'agents') return renderTree();
  const tree = $('tree');
  tree.innerHTML = '';
  const items = [];
  if (S.tab === 'skills' && S.state) {
    for (const sk of S.state.skills.global) items.push({ label: sk.id, tag: 'global', target: 'skill-' + sk.dir });
    for (const p of S.state.skills.projects) {
      for (const sk of p.skills) items.push({ label: sk.id, tag: p.label, target: 'skill-' + p.label + '-' + sk.dir });
    }
    if (!items.length) items.push({ label: 'скиллов нет', target: null });
  }
  if (S.tab === 'plugins') {
    for (const p of S.plugins ? S.plugins.plugins : []) items.push({ label: p.name, tag: p.installed ? p.installed.version : 'нет', target: 'plugin-' + p.name });
    if (!items.length) items.push({ label: S.plugins ? 'плагинов нет' : 'читаю…', target: null });
  }
  if (S.tab === 'settings') {
    for (const f of S.settings ? S.settings.files : []) {
      const parts = f.path.split('/').filter(Boolean);
      items.push({
        label: f.path.split('/').pop(),
        tag: f.scope === 'global' ? 'global' : parts[parts.length - 2],
        target: 'cfg-' + encodeURIComponent(f.path),
      });
    }
    if (!items.length) items.push({ label: S.settings ? 'конфигов нет' : 'читаю…', target: null });
  }

  for (const it of items) {
    const b = el('button', 'agent-row');
    b.appendChild(el('span', 'dot'));
    b.appendChild(el('span', 'name', it.label));
    b.appendChild(el('span', 'tag', it.tag || ''));
    if (it.target) {
      b.onclick = () => {
        const target = document.getElementById(it.target);
        if (target) {
          for (const r of document.querySelectorAll('.agent-row.active')) r.classList.remove('active');
          b.classList.add('active');
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      };
    }
    tree.appendChild(b);
  }
}

function renderPanel(tab) {
  const panel = $('panel');
  panel.innerHTML = '';
  panel.appendChild(panelHeader(TAB_TITLES[tab]));
  if (tab === 'skills') return renderSkills(panel);
  if (tab === 'plugins') return renderPlugins(panel);
  if (tab === 'settings') return renderSettings(panel);
}

function skillCard(sk, anchorId) {
  const card = el('div', 'card');
  if (anchorId) card.id = anchorId;
  const head = el('h3');
  head.appendChild(el('code', null, sk.id));
  head.appendChild(el('span', 'badge ' + (sk.scope === 'global' ? 'global' : 'project'), sk.scope === 'global' ? 'глобальный' : 'проект'));
  if (sk.userInvocable) head.appendChild(el('span', 'badge', 'можно вызвать как команду'));
  const actions = el('div', 'card-actions');
  const copy = el('button', 'ghost tiny', 'скопировать путь');
  copy.onclick = () => navigator.clipboard.writeText(sk.file).then(() => toast('Путь скопирован'), () => toast(sk.file));
  actions.appendChild(copy);
  head.appendChild(actions);
  card.appendChild(head);
  if (sk.description) card.appendChild(el('p', 'desc', sk.description));
  card.appendChild(el('div', 'no-prompt', 'Файл: ' + sk.file + (sk.files.length ? '  ·  рядом: ' + sk.files.join(', ') : '')));
  if (sk.allowedTools) card.appendChild(el('p', 'section-note', 'allowed-tools: ' + sk.allowedTools));
  if (sk.body) {
    const det = el('details', 'extra');
    det.appendChild(el('summary', null, 'Инструкции скилла (' + sk.body.length + ' симв.)'));
    const pre = el('pre', null, sk.body);
    pre.style.maxHeight = '320px';
    pre.style.overflow = 'auto';
    det.appendChild(pre);
    card.appendChild(det);
  }
  return card;
}

function renderSkills(panel) {
  const skills = S.state ? S.state.skills : { global: [], projects: [] };
  panel.appendChild(
    noteCard(
      'Скилл — папка с <code>SKILL.md</code>: имя, описание и инструкции. opencode держит их в контексте и подгружает по описанию, ' +
        'когда задача совпадает. Свои скиллы плагинов (например superpowers) живут внутри пакетов плагинов, а не в этих папках.'
    )
  );
  const body = el('div', 'cards');
  if (skills.global.length) {
    body.appendChild(el('div', 'section-title', 'Глобальные'));
    for (const sk of skills.global) body.appendChild(skillCard(sk, 'skill-' + sk.dir));
  }
  for (const p of skills.projects) {
    if (!p.skills.length) continue;
    body.appendChild(el('div', 'section-title', p.label));
    for (const sk of p.skills) body.appendChild(skillCard(sk, 'skill-' + p.label + '-' + sk.dir));
  }
  if (!skills.global.length && !skills.projects.some((p) => p.skills.length)) {
    body.appendChild(noteCard('Скиллов не нашлось. Положи папку со <code>SKILL.md</code> в <code>~/.config/opencode/skills/</code>.'));
  }
  panel.appendChild(body);
}

async function renderPlugins(panel) {
  panel.appendChild(noteCard('Плагины подключаются ключом <code>plugin</code> в <code>opencode.json</code> и ставятся в <code>~/.cache/opencode/packages</code>.'));
  const box = el('div', 'cards');
  box.appendChild(noteCard('Читаю…'));
  panel.appendChild(box);
  try {
    S.plugins = await api('/api/plugins?root=' + encodeURIComponent(S.root));
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(noteCard('Не получилось прочитать плагины: ' + e.message));
    return;
  }
  box.innerHTML = '';
  if (!S.plugins.plugins.length) box.appendChild(noteCard('В конфиге нет ни одного плагина.'));
  for (const p of S.plugins.plugins) {
    const card = el('div', 'card');
    card.id = 'plugin-' + p.name;
    const head = el('h3');
    head.appendChild(el('code', null, p.name));
    head.appendChild(el('span', p.installed ? 'badge' : 'badge v1', p.installed ? (p.installed.version || 'установлен') : 'не установлен'));
    head.appendChild(el('div', 'card-actions'));
    card.appendChild(head);
    if (p.installed && p.installed.description) card.appendChild(el('p', 'desc', p.installed.description));
    card.appendChild(el('div', 'no-prompt', 'В конфиге: ' + p.spec + (p.installed ? '\nУстановлен: ' + p.installed.dir : '')));
    box.appendChild(card);
  }
  const foot = el('div', 'no-prompt');
  foot.innerHTML = 'Пакеты: <code>' + S.plugins.packagesDir + '</code>. Версия — из <code>package.json</code> установленного пакета; при обновлении плагина opencode сам подхватит новую.';
  box.appendChild(foot);
  renderSidebar();
}

async function renderSettings(panel) {
  const box = el('div', 'cards');
  box.appendChild(noteCard('Читаю…'));
  panel.appendChild(box);
  try {
    S.settings = await api('/api/settings?root=' + encodeURIComponent(S.root));
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(noteCard('Не получилось прочитать настройки: ' + e.message));
    return;
  }
  box.innerHTML = '';
  const env = el('div', 'no-prompt');
  env.innerHTML =
    'opencode <b>' + (S.settings.version || 'версия неизвестна') + '</b> · глобальный конфиг: <code>' + S.settings.globalDir + '</code><br>' +
    'Правки применяются без перезапуска: opencode следит за файлом. Меняются только простые значения (строка, число, флаг) — вложенные объекты и массивы правь в файле, чтобы не потерять комментарии.';
  box.appendChild(env);

  for (const f of S.settings.files) {
    const card = el('div', 'card');
    card.id = 'cfg-' + encodeURIComponent(f.path);
    const head = el('h3');
    head.appendChild(el('code', null, f.path.split('/').slice(-2).join('/')));
    head.appendChild(el('span', 'badge ' + (f.scope === 'global' ? 'global' : 'project'), f.scope === 'global' ? 'глобальный' : 'проект'));
    const actions = el('div', 'card-actions');
    const copy = el('button', 'ghost tiny', 'скопировать путь');
    copy.onclick = () => navigator.clipboard.writeText(f.path).then(() => toast('Путь скопирован'), () => toast(f.path));
    actions.appendChild(copy);
    head.appendChild(actions);
    card.appendChild(head);
    if (f.error) card.appendChild(noteCard('Файл не парсится: ' + f.error));

    for (const e of f.entries) {
      const row = el('div', 'kv');
      const k = el('div', 'k', e.key);
      k.appendChild(el('small', null, e.kind));
      row.appendChild(k);
      if (e.kind === 'complex') {
        const ro = el('div', 'ro');
        ro.appendChild(el('pre', null, e.value.length > 400 ? e.value.slice(0, 400) + ' …' : e.value));
        row.appendChild(ro);
        card.appendChild(row);
        continue;
      }
      const input = el('input');
      input.value = e.parsed === null ? 'null' : String(e.parsed);
      const btn = el('button', 'ghost small', 'сохранить');
      btn.disabled = true;
      input.addEventListener('input', () => (btn.disabled = input.value === String(e.parsed)));
      const commit = async () => {
        btn.disabled = true;
        let value = input.value;
        if (e.kind === 'number') value = Number(value);
        else if (e.kind === 'boolean') value = value === 'true';
        else if (e.kind === 'null') value = null;
        try {
          await api('/api/settings/set', { root: S.root, file: f.path, key: e.key, value: value });
          row.classList.add('saved');
          toast('Сохранено: ' + e.key + '. opencode применит без перезапуска.');
        } catch (err) {
          toast(err.message, true);
        }
      };
      btn.onclick = commit;
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') commit();
      });
      row.appendChild(input);
      row.appendChild(btn);
      card.appendChild(row);
    }
    box.appendChild(card);
  }
  renderSidebar();
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
  S.plugins = null;
  S.settings = null;
  loadState();
};
$('rootInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    S.root = $('rootInput').value.trim();
    loadState();
  }
});

$('builtinsBtn').onclick = showBuiltins;

for (const b of document.querySelectorAll('.tab')) b.onclick = () => setTab(b.dataset.tab);

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
