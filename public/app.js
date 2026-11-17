// Homework Tracker
// Online (on Vercel): syncs with the server, which also pulls homework from Moodle.
// Opened as a local file: works offline with this browser's storage only.

const STORAGE_KEY = 'homework-tracker-v1';
const ONLINE = location.protocol.startsWith('http');
const COLORS = ['#e5484d', '#f76b15', '#e2a336', '#30a46c', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];
const TAGS = {
  homework: { label: 'Homework', icon: '📄' },
  reading:  { label: 'Reading',  icon: '📖' },
  essay:    { label: 'Essay',    icon: '✍️' },
  lab:      { label: 'Lab',      icon: '🧪' },
  project:  { label: 'Project',  icon: '🛠️' },
  quiz:     { label: 'Quiz',     icon: '❓', big: true },
  test:     { label: 'Test',     icon: '🚨', big: true },
};
const tagOptions = (sel) => Object.entries(TAGS)
  .map(([k, t]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${t.icon} ${t.label}</option>`).join('');

let state = loadLocal();
let tagFilter = null;
let authed = false;
let meta = {};
let vapidKey = null;

// ---------- local storage ----------
function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && Array.isArray(s.classes) && Array.isArray(s.tasks)) return { classes: s.classes, tasks: s.tasks };
  } catch {}
  return { classes: [], tasks: [] };
}
function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const touch = (o) => { o.updatedAt = Date.now(); return o; };

// Call after any change: saves, redraws, and sends to the server.
function commit() {
  saveLocal();
  render();
  pushSoon();
}

// ---------- server sync ----------
function mergeState(a, b) {
  const list = (x = [], y = []) => {
    const m = new Map();
    for (const it of [...x, ...y]) {
      const cur = m.get(it.id);
      if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) m.set(it.id, it);
    }
    return [...m.values()];
  };
  return { classes: list(a.classes, b.classes), tasks: list(a.tasks, b.tasks) };
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && path !== '/api/session') { authed = false; render(); throw new Error('Please log in'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

let pushTimer;
function pushSoon() {
  if (!ONLINE || !authed) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try { adopt(await api('PUT', '/api/state', state)); } catch (e) { console.warn('save failed', e); }
  }, 300);
}
async function pull() {
  if (!ONLINE || !authed) return;
  try { adopt(await api('GET', '/api/state')); } catch (e) { console.warn('load failed', e); }
}
function adopt(server) {
  meta = server.meta || {};
  const merged = mergeState(state, server);
  const before = JSON.stringify(state);
  const localHadNewer = JSON.stringify(mergeState(server, merged)) !== JSON.stringify(mergeState(server, server));
  state = merged;
  saveLocal();
  if (JSON.stringify(state) !== before || location.hash === '#/settings') softRender();
  if (localHadNewer) pushSoon();
}

// Don't redraw under someone's fingers while they're typing or editing.
let renderPending = false;
function softRender() {
  const typing = document.querySelector('.quick-add input[name=title]')?.value;
  if (typing || document.querySelector('dialog[open]')) { renderPending = true; return; }
  render();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (renderPending && !document.querySelector('dialog[open]') && !document.querySelector('.quick-add input[name=title]')?.value) {
    renderPending = false;
    render();
  }
}, 0));

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const live = (arr) => arr.filter((x) => !x.deleted);
const classes = () => live(state.classes);
const tasks = () => live(state.tasks);
const classById = (id) => state.classes.find((c) => c.id === id && !c.deleted);
const pending = () => tasks().filter((t) => !t.done && classById(t.classId));

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysUntil(s) {
  return Math.round((parseDate(s) - parseDate(dateStr(new Date()))) / 86400000);
}
function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return dateStr(d);
}
function dueInfo(due) {
  if (!due) return { label: 'No due date', cls: '' };
  const n = daysUntil(due);
  const d = parseDate(due);
  if (n < 0) return { label: n === -1 ? 'Yesterday' : `${-n} days late`, cls: 'late' };
  if (n === 0) return { label: 'Today', cls: 'today' };
  if (n === 1) return { label: 'Tomorrow', cls: '' };
  if (n < 7) return { label: d.toLocaleDateString(undefined, { weekday: 'long' }), cls: '' };
  return { label: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), cls: '' };
}
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
}
function byDue(a, b) {
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (!a.due !== !b.due) return a.due ? -1 : 1; // no-date items go last
  return a.title.localeCompare(b.title);
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- rendering ----------
function render() {
  document.body.classList.toggle('locked', ONLINE && !authed);
  if (ONLINE && !authed) return renderLogin();

  const route = location.hash.slice(1) || '/';
  const m = route.match(/^\/class\/(.+)$/);
  const cls = m && classById(m[1]);
  if (m && !cls) { location.hash = '#/'; return; }

  renderSidebar(cls ? cls.id : route);
  if (route === '/settings') renderSettings();
  else if (cls) renderClass(cls);
  else renderDashboard();
}

function renderLogin() {
  $('#main').innerHTML = `
    <form class="login" data-form="login">
      <h1>📚 Homework</h1>
      <input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
      <button class="primary">Log in</button>
      <p class="err" id="login-err"></p>
    </form>`;
}

function renderSidebar(active) {
  const counts = {};
  pending().forEach((t) => (counts[t.classId] = (counts[t.classId] || 0) + 1));

  document.querySelector('[data-route="/"]').classList.toggle('active', active === '/');
  document.querySelector('[data-route="/settings"]').classList.toggle('active', active === '/settings');
  $('#class-list').innerHTML = classes().map((c) => `
    <a href="#/class/${c.id}" class="nav-link ${c.id === active ? 'active' : ''}">
      <span class="dot" style="background:${c.color}"></span>
      <span>${esc(c.name)}</span>
      <span class="count">${counts[c.id] || ''}</span>
    </a>`).join('') || `<p class="subtitle" style="margin:4px 10px;font-size:13px">No classes yet</p>`;
  $('#sync-status').textContent = meta.lastError ? '⚠️ Moodle sync problem'
    : meta.lastSync ? `Moodle checked ${ago(meta.lastSync)}` : '';
}

function quickAddForm(classId) {
  const classPicker = classId
    ? `<input type="hidden" name="classId" value="${classId}">`
    : `<select name="classId" required aria-label="Class">
         ${classes().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
       </select>`;
  return `
    <form class="quick-add" data-form="add">
      <input name="title" placeholder="Add homework…" required autocomplete="off" aria-label="Homework title">
      ${classPicker}
      <select name="tag" aria-label="Type">${tagOptions('homework')}</select>
      <input type="date" name="due" value="${tomorrow()}" aria-label="Due date">
      <button class="primary">Add</button>
    </form>`;
}

function filterBar(list) {
  const used = new Set(list.map((t) => t.tag || 'homework'));
  if (used.size < 2 && !tagFilter) return '';
  return `<div class="filters">
    <button class="filter ${!tagFilter ? 'on' : ''}" data-action="filter" data-tag="">All</button>
    ${Object.entries(TAGS).filter(([k]) => used.has(k) || k === tagFilter).map(([k, t]) =>
      `<button class="filter ${tagFilter === k ? 'on' : ''}" data-action="filter" data-tag="${k}">${t.icon} ${t.label}</button>`).join('')}
  </div>`;
}
const applyFilter = (list) => tagFilter ? list.filter((t) => (t.tag || 'homework') === tagFilter) : list;

function taskRow(t, showClass) {
  const c = classById(t.classId);
  const due = dueInfo(t.due);
  const tag = TAGS[t.tag] || TAGS.homework;
  return `
    <li class="task ${t.done ? 'done' : ''} ${tag.big ? 'big' : ''}" data-id="${t.id}">
      <input type="checkbox" data-action="toggle" ${t.done ? 'checked' : ''} aria-label="Mark done">
      <button class="task-body" data-action="edit-task">
        <span class="task-title"><span class="tag tag-${t.tag || 'homework'}">${tag.icon} ${tag.label}</span>${esc(t.title)}</span>
        ${(showClass && c) || t.notes || t.doneBy === 'moodle' ? `<span class="task-meta">
          ${showClass && c ? `<span class="chip"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</span>` : ''}
          ${t.notes ? `<span title="${esc(t.notes)}">📝 notes</span>` : ''}
          ${t.done && t.doneBy === 'moodle' ? `<span>✓ submitted on Moodle</span>` : ''}
        </span>` : ''}
      </button>
      ${t.done ? '' : `<span class="due ${due.cls}">${due.label}</span>`}
      ${t.url ? `<a class="ext" href="${esc(t.url)}" target="_blank" rel="noopener" title="Open in Moodle" aria-label="Open in Moodle">↗</a>` : ''}
    </li>`;
}

function group(title, list, showClass, extraCls = '') {
  if (!list.length) return '';
  return `
    <section class="group ${extraCls}">
      <h3>${title} <span class="n">${list.length}</span></h3>
      <ul class="task-list">${list.map((t) => taskRow(t, showClass)).join('')}</ul>
    </section>`;
}

function completedSection(list, showClass) {
  if (!list.length) return '';
  list = [...list].sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  return `
    <details class="completed">
      <summary>Completed (${list.length})</summary>
      <ul class="task-list">${list.map((t) => taskRow(t, showClass)).join('')}</ul>
      <p><button class="link-btn" data-action="clear-done">Clear completed</button></p>
    </details>`;
}

function renderDashboard() {
  const main = $('#main');
  if (!classes().length) {
    main.innerHTML = `
      <div class="page-header"><h2>Dashboard</h2></div>
      <p class="subtitle">Everything you have due, in date order.</p>
      <div class="empty">
        <p>${ONLINE ? 'Your classes will show up here once Moodle is connected, or you can add them yourself.' : 'Start by adding your classes.'}</p>
        <button class="primary" data-action="new-class">Add a class</button>
      </div>`;
    return;
  }

  const allTodo = pending();
  const todo = applyFilter(allTodo).sort(byDue);
  const buckets = { late: [], today: [], tomorrow: [], week: [], later: [], none: [] };
  for (const t of todo) {
    if (!t.due) { buckets.none.push(t); continue; }
    const n = daysUntil(t.due);
    if (n < 0) buckets.late.push(t);
    else if (n === 0) buckets.today.push(t);
    else if (n === 1) buckets.tomorrow.push(t);
    else if (n < 7) buckets.week.push(t);
    else buckets.later.push(t);
  }

  const weekCount = buckets.today.length + buckets.tomorrow.length + buckets.week.length;
  const summary = todo.length
    ? `${weekCount} due in the next 7 days` +
      (buckets.late.length ? ` · <span class="bad">${buckets.late.length} overdue</span>` : '')
    : 'All caught up 🎉';

  main.innerHTML = `
    <div class="page-header"><h2>Dashboard</h2></div>
    <p class="subtitle">${summary}</p>
    ${quickAddForm(null)}
    ${filterBar(allTodo)}
    ${group('Overdue', buckets.late, true, 'overdue')}
    ${group('Today', buckets.today, true)}
    ${group('Tomorrow', buckets.tomorrow, true)}
    ${group('This week', buckets.week, true)}
    ${group('Later', buckets.later, true)}
    ${group('No due date', buckets.none, true)}
    ${todo.length ? '' : `<div class="empty"><p>Nothing due. Add homework above when you get some.</p></div>`}
    ${completedSection(tasks().filter((t) => t.done && classById(t.classId)), true)}`;
}

function renderClass(c) {
  const mine = tasks().filter((t) => t.classId === c.id);
  const allTodo = mine.filter((t) => !t.done);
  const todo = applyFilter(allTodo).sort(byDue);
  const late = todo.filter((t) => t.due && daysUntil(t.due) < 0).length;

  $('#main').innerHTML = `
    <div class="page-header">
      <span class="dot" style="background:${c.color};width:14px;height:14px"></span>
      <h2>${esc(c.name)}</h2>
      <div class="actions"><button class="btn" data-action="edit-class" data-class="${c.id}">Edit class</button></div>
    </div>
    <p class="subtitle">${todo.length ? `${todo.length} to do` : 'All caught up 🎉'}${late ? ` · <span class="bad">${late} overdue</span>` : ''}${c.moodleId ? ' · synced from Moodle' : ''}</p>
    ${quickAddForm(c.id)}
    ${filterBar(allTodo)}
    ${todo.length ? group('To do', todo, false) : `<div class="empty"><p>No homework for ${esc(c.name)} right now.</p></div>`}
    ${completedSection(mine.filter((t) => t.done), false)}`;
}

function renderSettings() {
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  let notif;
  if (!ONLINE) notif = `<p>Notifications only work on the website version.</p>`;
  else if (iOS && !installed) notif = `
    <p>On iPhone, notifications only work after you add this site to your home screen:</p>
    <ol><li>Tap the <b>Share</b> button in Safari</li><li>Tap <b>Add to Home Screen</b></li><li>Open Homework from your home screen and come back to this page</li></ol>`;
  else if (!pushSupported) notif = `<p>This browser doesn't support notifications.</p>`;
  else if (!vapidKey) notif = `<p>Notifications aren't set up on the server yet.</p>`;
  else notif = `
    <p id="push-state">Checking…</p>
    <div class="row">
      <button class="primary" data-action="push-on" id="push-on" hidden>Turn on notifications</button>
      <button class="btn" data-action="push-test" id="push-test" hidden>Send a test</button>
      <button class="link-btn" data-action="push-off" id="push-off" hidden>Turn off on this device</button>
    </div>
    <p class="hint">You'll get a ping when new homework shows up on Moodle, and a reminder around 7pm listing what's due tomorrow.</p>`;

  const moodle = !ONLINE ? `<p>Moodle sync only works on the website version.</p>` : `
    <p>${meta.lastSync ? `Last checked ${ago(meta.lastSync)}${meta.lastCount != null ? ` · ${meta.lastCount} upcoming item${meta.lastCount === 1 ? '' : 's'} on Moodle` : ''}.` : 'Not checked yet.'}
       It checks again every hour on its own.</p>
    ${meta.lastError ? `<p class="bad">Last problem: ${esc(meta.lastError)}</p>` : ''}
    <div class="row"><button class="btn" data-action="sync-now">Check Moodle now</button></div>
    <p class="hint">Things you submit on Moodle get checked off automatically.</p>`;

  $('#main').innerHTML = `
    <div class="page-header"><h2>Settings</h2></div>
    <section class="card"><h3>🔔 Notifications</h3>${notif}</section>
    <section class="card"><h3>🔄 Moodle</h3>${moodle}</section>
    <section class="card"><h3>💾 Backup</h3>
      <div class="row">
        <button class="btn" data-action="export">Export backup</button>
        <button class="btn" data-action="import">Import backup</button>
      </div>
      <p class="hint">Import adds everything from a backup file to what's already here.</p>
    </section>
    ${ONLINE ? `<p><button class="link-btn" data-action="logout">Log out of this device</button></p>` : ''}`;

  if (ONLINE && pushSupported && vapidKey && !(iOS && !installed)) refreshPushState();
}

async function refreshPushState() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const on = !!sub && Notification.permission === 'granted';
  const el = $('#push-state');
  if (!el) return;
  el.textContent = Notification.permission === 'denied'
    ? 'Notifications are blocked for this site. Allow them in your browser or System Settings, then reload.'
    : on ? '✅ Notifications are on for this device.' : 'Notifications are off on this device.';
  $('#push-on').hidden = on || Notification.permission === 'denied';
  $('#push-test').hidden = !on;
  $('#push-off').hidden = !on;
}

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// ---------- task dialog ----------
let editingTaskId = null;
function openTaskDialog(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  editingTaskId = id;
  const f = $('#task-form');
  f.title.value = t.title;
  f.classId.innerHTML = classes().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  f.classId.value = t.classId;
  f.tag.innerHTML = tagOptions(t.tag || 'homework');
  f.due.value = t.due || '';
  f.notes.value = t.notes || '';
  const link = $('#task-link');
  link.hidden = !t.url;
  if (t.url) link.href = t.url;
  $('#task-dialog').showModal();
}
$('#task-dialog').addEventListener('close', () => {
  const dlg = $('#task-dialog');
  const t = state.tasks.find((x) => x.id === editingTaskId);
  if (dlg.returnValue === 'save' && t) {
    const f = $('#task-form');
    t.title = f.title.value.trim() || t.title;
    t.classId = f.classId.value;
    t.tag = f.tag.value;
    t.due = f.due.value;
    t.notes = f.notes.value.trim();
    touch(t);
    commit();
  }
  dlg.returnValue = '';
  editingTaskId = null;
  if (renderPending) { renderPending = false; render(); }
});

// ---------- class dialog ----------
let editingClassId = null;
function openClassDialog(id) {
  const c = id ? classById(id) : null;
  editingClassId = c ? c.id : null;
  const f = $('#class-form');
  $('#class-dialog-title').textContent = c ? 'Edit class' : 'New class';
  f.querySelector('[data-action="delete-class"]').hidden = !c;
  f.name.value = c ? c.name : '';
  const used = new Set(classes().map((x) => x.color));
  const color = c ? c.color : COLORS.find((x) => !used.has(x)) || COLORS[classes().length % COLORS.length];
  $('#color-swatches').innerHTML = COLORS.map((col) => `
    <label><input type="radio" name="color" value="${col}" ${col === color ? 'checked' : ''}>
    <span style="background:${col}"></span></label>`).join('');
  $('#class-dialog').showModal();
}
$('#class-dialog').addEventListener('close', () => {
  const dlg = $('#class-dialog');
  if (dlg.returnValue === 'save') {
    const f = $('#class-form');
    const name = f.name.value.trim();
    const color = f.querySelector('input[name=color]:checked')?.value || COLORS[0];
    if (name) {
      if (editingClassId) {
        touch(Object.assign(classById(editingClassId), { name, color }));
        commit();
      } else {
        const id = uid();
        state.classes.push(touch({ id, name, color }));
        commit();
        location.hash = `#/class/${id}`;
      }
    }
  }
  dlg.returnValue = '';
  editingClassId = null;
  if (renderPending) { renderPending = false; render(); }
});

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const taskId = el.closest('[data-id]')?.dataset.id;

  switch (el.dataset.action) {
    case 'filter': tagFilter = el.dataset.tag || null; render(); break;
    case 'new-class': openClassDialog(null); break;
    case 'edit-class': openClassDialog(el.dataset.class); break;
    case 'edit-task': openTaskDialog(taskId); break;
    case 'delete-task': {
      const t = state.tasks.find((x) => x.id === editingTaskId);
      if (t) touch(Object.assign(t, { deleted: true }));
      $('#task-dialog').close();
      commit();
      break;
    }
    case 'delete-class': {
      const c = classById(editingClassId);
      const mine = tasks().filter((t) => t.classId === c.id);
      const extra = c.moodleId ? '\n\nMoodle homework for this class will stop showing up.' : '';
      if (!confirm(`Delete "${c.name}"${mine.length ? ` and its ${mine.length} homework item${mine.length === 1 ? '' : 's'}` : ''}?${extra}`)) return;
      touch(Object.assign(c, { deleted: true }));
      mine.forEach((t) => touch(Object.assign(t, { deleted: true })));
      $('#class-dialog').close();
      location.hash = '#/';
      commit();
      break;
    }
    case 'clear-done': {
      const onClass = location.hash.match(/^#\/class\/(.+)$/)?.[1];
      tasks().filter((t) => t.done && (!onClass || t.classId === onClass))
        .forEach((t) => touch(Object.assign(t, { deleted: true })));
      commit();
      break;
    }
    case 'export': {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `homework-backup-${dateStr(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      break;
    }
    case 'import': $('#import-file').click(); break;
    case 'sync-now': {
      el.disabled = true;
      el.textContent = 'Checking…';
      try {
        const r = await api('POST', '/api/sync');
        await pull();
        toast(r.added ? `Found ${r.added} new assignment${r.added === 1 ? '' : 's'}` : 'Up to date');
      } catch (err) {
        toast(`Couldn't check Moodle: ${err.message}`);
        await pull();
      }
      render();
      break;
    }
    case 'push-on': {
      // Safari needs the permission prompt to happen right inside the tap.
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { refreshPushState(); break; }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidKey) });
        await api('POST', '/api/push', sub.toJSON());
        toast('Notifications on');
      } catch (err) { toast(`Couldn't turn on notifications: ${err.message}`); }
      refreshPushState();
      break;
    }
    case 'push-test': {
      try { await api('POST', '/api/push?test=1'); toast('Sent! It should pop up in a few seconds.'); }
      catch (err) { toast(err.message); }
      break;
    }
    case 'push-off': {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('DELETE', '/api/push', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      refreshPushState();
      break;
    }
    case 'logout': {
      await api('DELETE', '/api/session').catch(() => {});
      authed = false;
      state = { classes: [], tasks: [] };
      saveLocal();
      render();
      break;
    }
  }
});

document.addEventListener('change', (e) => {
  if (e.target.dataset.action === 'toggle') {
    const t = state.tasks.find((x) => x.id === e.target.closest('[data-id]').dataset.id);
    t.done = e.target.checked;
    t.doneAt = t.done ? Date.now() : null;
    t.doneBy = t.done ? 'you' : null;
    touch(t);
    commit();
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.dataset.form === 'login') {
    e.preventDefault();
    try {
      await api('POST', '/api/session', { password: f.password.value });
      authed = true;
      render();
      await pull();
      registerSW();
    } catch (err) {
      $('#login-err').textContent = err.message;
    }
    return;
  }
  if (f.dataset.form !== 'add') return;
  e.preventDefault();
  const title = f.title.value.trim();
  if (!title || !f.classId.value) return;
  state.tasks.push(touch({ id: uid(), title, classId: f.classId.value, tag: f.tag.value, due: f.due.value, notes: '', done: false, doneAt: null }));
  const keepClass = f.classId.value;
  const keepTag = f.tag.value;
  commit();
  // keep the same class + type selected so you can add several in a row
  const next = $('.quick-add');
  if (next?.classId?.tagName === 'SELECT') next.classId.value = keepClass;
  if (next) next.tag.value = keepTag;
  next?.title.focus();
});

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.classes) || !Array.isArray(data.tasks)) throw new Error();
    const now = Date.now();
    state = mergeState(state, {
      classes: data.classes.map((c) => ({ ...c, updatedAt: now })),
      tasks: data.tasks.map((t) => ({ ...t, updatedAt: now })),
    });
    commit();
    toast(`Imported ${live(data.tasks).length} homework items`);
  } catch {
    alert("That file doesn't look like a homework backup.");
  }
});

// ---------- startup ----------
function registerSW() {
  if (ONLINE && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.warn);
}

async function boot() {
  window.addEventListener('hashchange', render);
  if (!ONLINE) { render(); return; }

  // stay fresh: re-check when you come back to the tab/app, and every few minutes while open
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  setInterval(() => { if (!document.hidden) pull(); }, 3 * 60 * 1000);

  authed = true; // optimistic: show cached homework instantly
  render();
  try {
    const s = await api('GET', '/api/session');
    vapidKey = s.vapidPublicKey;
    authed = s.authed;
  } catch {
    return; // offline — keep showing the cached copy
  }
  render();
  if (!authed) return;
  registerSW();
  await pull();
}
boot();
