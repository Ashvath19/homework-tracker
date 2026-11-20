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
  .map(([k, t]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${t.label}</option>`).join('');

// Each person's cached copy is stored separately, so siblings sharing a computer don't mix lists.
let userId = ONLINE ? safeGet('hw-last-user') : 'local';
let state = loadLocal();
let tagFilter = null;
let authed = false;
let me = null;              // { id, name }
let moodle = { connected: false };
let meta = {};
let vapidKey = null;
let school = null;          // { today, letter: 'A'|'B'|'C'|null, nextA, nextB }

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
const storageKey = () => (userId && userId !== 'local' ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY);

// ---------- local storage ----------
function loadLocal() {
  try {
    if (ONLINE && !userId) return { classes: [], tasks: [] };
    const s = JSON.parse(localStorage.getItem(storageKey()));
    if (s && Array.isArray(s.classes) && Array.isArray(s.tasks)) return { classes: s.classes, tasks: s.tasks };
  } catch {}
  return { classes: [], tasks: [] };
}
function saveLocal() {
  if (ONLINE && !userId) return;
  safeSet(storageKey(), JSON.stringify(state));
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

// The scheduled check runs every 2 hours, but a run can be missed. If Moodle hasn't been
// checked in over 2 hours when you open the site, check now (at most once every 10 minutes).
const STALE_MS = 2 * 60 * 60 * 1000;
let lastAutoSync = 0;
async function syncIfStale() {
  if (!ONLINE || !authed || !moodle.connected) return;
  if (meta.lastSync && Date.now() - meta.lastSync < STALE_MS) return;
  if (Date.now() - lastAutoSync < 10 * 60 * 1000) return;
  lastAutoSync = Date.now();
  try { await api('POST', '/api/sync'); await pull(); } catch (e) { console.warn('auto check failed', e); }
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

let loginMode = 'key';
function renderLogin() {
  const keyForm = `
    <form class="login-form" data-form="login-key">
      <label for="key">Moodle key</label>
      <input id="key" name="token" class="field" autocomplete="off" autocapitalize="off" spellcheck="false" required>
      <button class="primary">Log in</button>
      <details>
        <summary>Where do I find my key?</summary>
        <ol>
          <li>Log in to <a href="https://learn.vcs.net" target="_blank" rel="noopener">learn.vcs.net</a> on a computer.</li>
          <li>Open <a href="https://learn.vcs.net/user/managetoken.php" target="_blank" rel="noopener">Preferences, then Security keys</a>.</li>
          <li>In the <b>Moodle mobile web service</b> row, click <b>Reset</b>.</li>
          <li>Moodle shows your new key once, at the top of the page. Click <b>Copy to clipboard</b> and paste it here.</li>
        </ol>
        No row like that? Sign in to the Moodle app on your phone once, then reload the page.
      </details>
      <details>
        <summary>What happens to my key?</summary>
        <ul>
          <li>It's stored encrypted and only used to read your courses, assignments, quizzes, and calendar. This site never submits work, sends messages, or looks at your grades.</li>
          <li>Only you can see your homework list here.</li>
          <li>This site is run by a student, not by VCS. Whoever runs it could technically use your key, so only use it if you trust them.</li>
          <li>To cut off access anytime, click <b>Reset</b> on Moodle's <a href="https://learn.vcs.net/user/managetoken.php" target="_blank" rel="noopener">Security keys page</a>, or delete your account in Settings.</li>
        </ul>
      </details>
      <button type="button" class="link-btn switch" data-action="login-mode" data-mode="code">Log in with a code from another device</button>
    </form>`;
  const codeForm = `
    <form class="login-form" data-form="login-code">
      <label for="code">6-digit code</label>
      <input id="code" name="code" class="field code-input" inputmode="numeric" maxlength="7" autocomplete="one-time-code" required>
      <button class="primary">Log in</button>
      <p class="hint">Get a code on a device where you're already logged in, under Settings.</p>
      <button type="button" class="link-btn switch" data-action="login-mode" data-mode="key">Log in with your Moodle key instead</button>
    </form>`;
  $('#main').innerHTML = `
    <div class="login">
      <h1><span class="hl">Homework</span></h1>
      <p class="lede">Your Moodle assignments, sorted by when they're due.</p>
      <div class="beta-note">
        <p><b>Still being tested.</b> It might miss some homework or show the wrong due date, especially for classes with different teachers. Double-check Moodle for anything important, and tell whoever sent you the link if something's off.</p>
        <p><b>Your Moodle key is like a password.</b> This site stores it to read your Moodle account as you. It's run by a student, not VCS, so only use it if you trust whoever runs it. You can cut off access anytime by resetting your key on Moodle.</p>
      </div>
      ${loginMode === 'code' ? codeForm : keyForm}
      <p class="err" id="login-err" role="alert"></p>
    </div>`;
  $('#main input')?.focus();
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
  $('#sync-status').textContent = !moodle.connected ? (ONLINE ? 'Moodle not connected' : '')
    : meta.lastError ? '⚠️ Moodle sync problem'
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
      `<button class="filter ${tagFilter === k ? 'on' : ''}" data-action="filter" data-tag="${k}">${t.label}</button>`).join('')}
  </div>`;
}
const applyFilter = (list) => tagFilter ? list.filter((t) => (t.tag || 'homework') === tagFilter) : list;

const PENCIL = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

function taskRow(t, showClass) {
  const c = classById(t.classId);
  const due = dueInfo(t.due);
  const tag = TAGS[t.tag] || TAGS.homework;
  const title = `<span class="tag tag-${t.tag || 'homework'}">${tag.label}</span>${esc(t.title)}`;
  const meta = (showClass && c) || t.notes || t.doneBy === 'moodle' || t.source === 'lesson' || t.files?.length || t.study?.length ? `<span class="task-meta">
          ${showClass && c ? `<span class="chip"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</span>` : ''}
          ${t.source === 'lesson' && !t.done ? `<span title="From the lesson plan for ${esc(t.chapter || '')}">Lesson plan</span>` : ''}
          ${!t.done && (t.study?.length) ? `<span>${t.study.length} study file${t.study.length === 1 ? '' : 's'}</span>` : ''}
          ${!t.done && !t.study?.length && t.files?.length ? `<span>${t.files.length} file${t.files.length === 1 ? '' : 's'}</span>` : ''}
          ${t.notes ? `<span title="${esc(t.notes)}">Has notes</span>` : ''}
          ${t.done && t.doneBy === 'moodle' ? `<span>Submitted on Moodle</span>` : ''}
        </span>` : '';
  return `
    <li class="task ${t.done ? 'done' : ''} ${tag.big ? 'big' : ''}" data-id="${t.id}">
      <input type="checkbox" data-action="toggle" ${t.done ? 'checked' : ''} aria-label="Mark done">
      <div class="task-body">
        <button class="task-title" data-action="open-task">${title}</button>
        ${meta}
      </div>
      ${t.done ? '' : `<span class="due ${due.cls}">${due.cls === 'today' ? `<span class="hl">${due.label}</span>` : due.label}${t.dueEstimated ? '<span class="est" title="Estimated: the next lesson plan isn’t posted yet">?</span>' : ''}</span>`}
      <button class="edit-btn" data-action="edit-task" aria-label="Edit ${esc(t.title)}" title="Edit">${PENCIL}</button>
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
        <p>${ONLINE ? 'Nothing from Moodle yet. Your classes show up here as soon as teachers post assignments, or you can add them yourself.' : 'Start by adding your classes.'}</p>
        <div class="row" style="justify-content:center">
          <button class="btn" data-action="new-class">Add a class</button>
        </div>
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

  main.innerHTML = `
    ${hero(allTodo, buckets)}
    ${dayPicker()}
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

function firstName() {
  const n = me?.name || '';
  return (n.match(/\(([^)]+)\)/)?.[1] || n.split(' ')[0] || '').trim();
}

function hero(allTodo, b) {
  const now = new Date();
  const dateLine = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const letter = school?.today === dateStr(now) ? school.letter : null;
  const dayBadge = letter
    ? `<span class="day-badge day-${letter}" title="${letter} day on the VCHS calendar">${letter}<small>day</small></span>`
    : `<span class="day-badge day-off" title="No classes today">–<small>no school</small></span>`;

  // one plain sentence about what matters next
  let line;
  const tomorrowCount = b.tomorrow.length, todayCount = b.today.length;
  if (!allTodo.length) line = 'Nothing on your list. Enjoy it.';
  else if (todayCount) line = `${todayCount} thing${todayCount === 1 ? '' : 's'} due today${tomorrowCount ? `, ${tomorrowCount} tomorrow` : ''}.`;
  else if (tomorrowCount) line = `${tomorrowCount} thing${tomorrowCount === 1 ? '' : 's'} due tomorrow.`;
  else {
    const next = [...allTodo].filter((t) => t.due).sort(byDue).find((t) => daysUntil(t.due) >= 0);
    line = next ? `Next up: ${esc(next.title)}, ${dueInfo(next.due).label.toLowerCase()}.` : 'Nothing due soon.';
  }
  const bigOne = [...allTodo].filter((t) => (t.tag === 'test' || t.tag === 'quiz') && t.due && daysUntil(t.due) >= 0 && daysUntil(t.due) < 7).sort(byDue)[0];
  const testLine = bigOne
    ? `<p class="hero-note"><span class="tag tag-${bigOne.tag}">${TAGS[bigOne.tag].label}</span>${esc(classById(bigOne.classId)?.name || '')}, ${dueInfo(bigOne.due).label.toLowerCase()}</p>` : '';
  const late = b.late.length ? `<p class="hero-note bad">${b.late.length} overdue</p>` : '';

  return `
    <header class="hero">
      <div class="hero-text">
        <p class="hero-date">${dateLine}</p>
        <h2>Welcome back${firstName() ? `, <span class="hl">${esc(firstName())}</span>` : ''}</h2>
        <p class="hero-line">${line}</p>
        ${testLine}${late}
      </div>
      ${ONLINE && school ? dayBadge : ''}
    </header>`;
}

// Classes from Moodle lesson plans need to know if you're in the A-day or B-day section.
function dayPicker() {
  const need = classes().filter((c) => c.moodleId && !c.day && !c.singleDay && tasks().some((t) => t.classId === c.id && t.source === 'lesson'));
  if (!need.length) return '';
  return `
    <section class="day-setup">
      <h3>Which day do you have each class?</h3>
      <p class="hint">Lesson plans list two dates, one for A days and one for B days. Pick yours so homework shows the right due date. You can change it later under Edit class.</p>
      <ul>
        ${need.map((c) => `
          <li>
            <span class="chip"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</span>
            <span class="seg" role="group" aria-label="${esc(c.name)} day">
              <button data-action="set-day" data-class="${c.id}" data-day="A">A day</button>
              <button data-action="set-day" data-class="${c.id}" data-day="B">B day</button>
            </span>
          </li>`).join('')}
      </ul>
    </section>`;
}

// Switch a class between A and B days and move its lesson-plan due dates to match.
function setClassDay(c, day) {
  c.day = day;
  touch(c);
  for (const t of tasks()) {
    if (t.classId === c.id && t.lpDates && t.dueAuto !== false) {
      t.due = t.lpDates[day === 'B' ? 1 : 0];
      touch(t);
    }
  }
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
    <p class="subtitle">${todo.length ? `${todo.length} to do` : "You're all caught up"}${late ? `, <span class="bad">${late} overdue</span>` : ''}.${c.moodleId ? ' Synced from Moodle.' : ''}</p>
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
    <p class="hint">You'll get a ping when new homework shows up on Moodle, and a reminder at 6pm listing what's due tomorrow.</p>`;

  const moodleCard = !ONLINE ? `<p>Moodle sync only works on the website version.</p>` : `
    <p>Connected as <b>${esc(moodle.name || 'you')}</b>. ${meta.lastSync ? `Last checked ${ago(meta.lastSync)}${meta.lastCount != null ? `, ${meta.lastCount} upcoming item${meta.lastCount === 1 ? '' : 's'}` : ''}.` : 'Not checked yet.'}
       It checks again every 2 hours on its own, and whenever you open the site after a longer gap.</p>
    ${meta.lastError ? `<p class="bad">${esc(meta.lastError)}</p>` : ''}
    <div class="row"><button class="btn" data-action="sync-now">Check Moodle now</button></div>
    <p class="hint">Things you submit on Moodle get checked off automatically.</p>
    <details ${meta.lastError ? 'open' : ''}>
      <summary class="hint">Replace your Moodle key</summary>
      <p class="hint">On Moodle's <a href="https://learn.vcs.net/user/managetoken.php" target="_blank" rel="noopener">Security keys page</a>, click Reset in the Moodle mobile web service row and copy the key it shows. Your other devices will be logged out and need a new code.</p>
      <form class="row" data-form="moodle">
        <input name="token" placeholder="Paste your new Moodle key" autocomplete="off" spellcheck="false" required class="field">
        <button class="btn">Save key</button>
      </form>
    </details>`;

  $('#main').innerHTML = `
    <div class="page-header"><h2>Settings</h2></div>
    <section class="card"><h3>Notifications</h3>${notif}</section>
    <section class="card"><h3>Moodle</h3>${moodleCard}</section>
    <section class="card"><h3>Backup</h3>
      <div class="row">
        <button class="btn" data-action="export">Export backup</button>
        <button class="btn" data-action="import">Import backup</button>
      </div>
      <p class="hint">Import adds everything from a backup file to what's already here.</p>
    </section>
    ${ONLINE ? `<section class="card"><h3>Share with a friend</h3>
      <p>Send a friend the link. They log in with their own Moodle key and only see their own homework.</p>
      <div class="row"><button class="btn" data-action="share">Share the link</button></div>
    </section>` : ''}
    ${ONLINE && me ? `<section class="card"><h3>Account</h3>
      <p>Logged in as <b>${esc(me.name)}</b>.</p>
      <div class="row"><button class="primary" data-action="link-device">Log in on another device</button></div>
      <div id="link-code"></div>
      <div class="row">
        <button class="btn" data-action="logout">Log out</button>
        <button class="danger" data-action="delete-account">Delete my account</button>
      </div>
    </section>` : ''}`;

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
    : on ? 'Notifications are on for this device.' : 'Notifications are off on this device.';
  $('#push-on').hidden = on || Notification.permission === 'denied';
  $('#push-test').hidden = !on;
  $('#push-off').hidden = !on;
}

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// ---------- details view ----------
const fileHref = (u) => (/^https:\/\/learn\.vcs\.net\/(webservice\/)?pluginfile\.php\//.test(u) && ONLINE ? `/api/file?u=${encodeURIComponent(u)}` : u);
function fileKind(f) {
  const ext = (f.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || f.url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || '').toLowerCase();
  if (/docs\.google\.com\/document/.test(f.url)) return 'Doc';
  if (/docs\.google\.com\/presentation/.test(f.url)) return 'Slides';
  if (/docs\.google\.com\/spreadsheets/.test(f.url)) return 'Sheet';
  if (/youtube\.com|youtu\.be|vimeo/.test(f.url)) return 'Video';
  return { pdf: 'PDF', doc: 'Word', docx: 'Word', ppt: 'PPT', pptx: 'PPT', xls: 'Excel', xlsx: 'Excel', jpg: 'Image', jpeg: 'Image', png: 'Image', gif: 'Image', heic: 'Image', mp4: 'Video', mov: 'Video' }[ext] || 'Link';
}
function descHtml(text) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`); list = []; } };
  for (const line of text.split('\n')) {
    if (line.startsWith('• ')) list.push(line.slice(2));
    else { flush(); out.push(`<p>${esc(line)}</p>`); }
  }
  flush();
  return out.join('');
}

function fileList(title, list, cls = '') {
  if (!list.length) return '';
  return `
      <section class="detail-files ${cls}">
        <h3>${title} <span class="n">${list.length}</span></h3>
        <ul>${list.map((f) => `
          <li><a href="${esc(fileHref(f.url))}" target="_blank" rel="noopener">
            <span class="kind">${fileKind(f)}</span><span class="fname">${esc(f.name)}</span>
          </a></li>`).join('')}
        </ul>
      </section>`;
}

let detailId = null;
function openDetail(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  detailId = id;
  const c = classById(t.classId);
  const tag = TAGS[t.tag] || TAGS.homework;
  const files = t.files?.length ? t.files : (t.link ? [{ name: 'Linked file', url: t.link }] : []);
  const dueText = t.due ? parseDate(t.due).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : 'No due date';
  const lesson = t.lessonUrl || (t.source === 'lesson' ? t.url : null);
  const fileUrls = new Set(files.map((f) => f.url));
  const study = (t.study || []).filter((f) => !fileUrls.has(f.url));
  const lessonTitle = t.lessonTitle || t.chapter;

  $('#detail-body').innerHTML = `
    <div class="detail-top">
      <span class="tag tag-${t.tag || 'homework'}">${tag.label}</span>
      ${c ? `<span class="chip"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</span>` : ''}
      <button class="icon-btn detail-close" data-action="detail-close" aria-label="Close">×</button>
    </div>
    <h2>${esc(t.title)}</h2>
    <p class="detail-due ${!t.done && t.due && daysUntil(t.due) < 0 ? 'bad' : ''}">${t.done ? 'Done' : `Due ${esc(dueText)}`}${t.dueEstimated && !t.done ? ' (estimated)' : ''}</p>

    ${fileList('Files', files)}
    ${(t.tag === 'quiz' || t.tag === 'test') ? (study.length
      ? fileList(t.tag === 'test' ? 'Study materials' : 'Practice and review', study, 'study')
      : `<p class="hint">No practice or study materials matched this ${t.tag} on the course page yet.</p>`) : ''}

    ${t.desc ? `<section class="detail-desc"><h3>Instructions</h3>${descHtml(t.desc)}</section>` : ''}
    ${!files.length && !t.desc && !study.length ? `<p class="hint">Your teacher didn't post a description or files with this one. Check the lesson plan below.</p>` : ''}
    ${t.notes ? `<section class="detail-desc"><h3>Your notes</h3>${descHtml(t.notes)}</section>` : ''}

    ${lesson ? `<a class="detail-lesson" href="${esc(lesson)}" target="_blank" rel="noopener">
      <span>Lesson plan</span><strong>${esc(lessonTitle || 'Open in Moodle')}</strong></a>` : ''}

    <div class="detail-actions">
      <button class="primary" data-action="detail-done">${t.done ? 'Mark not done' : 'Mark done'}</button>
      <button class="btn" data-action="detail-edit">Edit</button>
      ${t.source === 'moodle' && t.url ? `<a class="link-btn" href="${esc(t.url)}" target="_blank" rel="noopener">Open on Moodle</a>` : ''}
    </div>`;
  $('#detail-dialog').showModal();
}
$('#detail-dialog').addEventListener('close', () => {
  detailId = null;
  if (renderPending) { renderPending = false; render(); }
});
// click outside the panel to close
$('#detail-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

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
  const href = t.link || t.url;
  link.hidden = !href;
  if (href) { link.href = href; link.textContent = t.link ? 'Open linked file' : 'Open in Moodle'; }
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
    if (f.due.value !== (t.due || '')) t.dueAuto = false; // you picked a date; sync won't move it
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
  $('#class-day-row').hidden = !c?.moodleId;
  f.day.value = c?.day || '';
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
        const c = classById(editingClassId);
        if (name !== c.name) c.renamed = true; // the sync won't touch names you chose
        touch(Object.assign(c, { name, color }));
        if (f.day.value && f.day.value !== c.day) setClassDay(c, f.day.value);
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
    case 'open-task': openDetail(taskId); break;
    case 'detail-close': $('#detail-dialog').close(); break;
    case 'detail-edit': { const id = detailId; $('#detail-dialog').close(); openTaskDialog(id); break; }
    case 'detail-done': {
      const t = state.tasks.find((x) => x.id === detailId);
      if (t) {
        t.done = !t.done;
        t.doneAt = t.done ? Date.now() : null;
        t.doneBy = t.done ? 'you' : null;
        touch(t);
        $('#detail-dialog').close();
        commit();
        if (t.done) toast('Marked done');
      }
      break;
    }
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
      try { await api('POST', '/api/push?test=1'); toast('Test sent. It should appear in a few seconds.'); }
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
      forgetDevice();
      break;
    }
    case 'delete-account': {
      if (!confirm('Delete your account and all your homework? This can\'t be undone.')) break;
      try { await api('DELETE', '/api/account'); } catch (err) { toast(err.message); break; }
      forgetDevice();
      break;
    }
    case 'login-mode': loginMode = el.dataset.mode; render(); break;
    case 'set-day': {
      const c = classById(el.dataset.class);
      if (c) { setClassDay(c, el.dataset.day); commit(); toast(`${c.name}: ${el.dataset.day} days`); }
      break;
    }
    case 'link-device': {
      try {
        const { code, expiresAt } = await api('POST', '/api/link');
        showLinkCode(code, expiresAt);
      } catch (err) { toast(err.message); }
      break;
    }
    case 'share': {
      const url = location.origin;
      const text = 'I use this to keep track of homework from Moodle. It sorts everything by due date and can remind you at 6pm what\'s due tomorrow. You log in with your Moodle key; the login page shows where to find it.';
      try {
        if (navigator.share) await navigator.share({ title: 'Homework', text, url });
        else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Copied. Paste it to a friend.'); }
      } catch (err) {
        if (err.name !== 'AbortError') toast('Couldn\'t share. The link is ' + url);
      }
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
  if (f.dataset.form === 'login-key' || f.dataset.form === 'login-code') {
    e.preventDefault();
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    btn.textContent = f.dataset.form === 'login-key' ? 'Checking with Moodle…' : 'Logging in…';
    try {
      if (f.dataset.form === 'login-key' && /^webservice-/i.test(f.token.value.trim())) {
        throw new Error("That's the key's name. Copy the key itself: the 32-character code in the same row.");
      }
      const body = f.dataset.form === 'login-key' ? { token: f.token.value } : { code: f.code.value };
      await api('POST', '/api/login', body);
      await boot(true);
    } catch (err) {
      $('#login-err').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
    return;
  }
  if (f.dataset.form === 'moodle') {
    e.preventDefault();
    const btn = f.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await api('POST', '/api/moodle', { token: f.token.value });
      await pull();
      toast('New key saved');
      render();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Save key';
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

function showLinkCode(code, expiresAt) {
  const box = $('#link-code');
  if (!box) return;
  clearInterval(showLinkCode.t);
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (!document.body.contains(box)) return clearInterval(showLinkCode.t);
    box.innerHTML = left ? `
      <div class="link-box">
        <div class="link-code">${code.slice(0, 3)} ${code.slice(3)}</div>
        <p class="hint">On your other device, open this site, choose <b>Log in with a code</b>, and enter this.
        Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. Works once.</p>
      </div>` : `<p class="hint">That code expired. Make a new one if you still need it.</p>`;
    if (!left) clearInterval(showLinkCode.t);
  };
  tick();
  showLinkCode.t = setInterval(tick, 1000);
}

// ---------- startup ----------
function userChanged(id) {
  if (userId === id) return false;
  userId = id;
  safeSet('hw-last-user', id);
  return true;
}
function forgetDevice() {
  if (userId && userId !== 'local') safeSet(storageKey(), null);
  safeSet('hw-last-user', null);
  userId = null;
  authed = false;
  me = null;
  state = { classes: [], tasks: [] };
  render();
}
function registerSW() {
  if (ONLINE && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.warn);
}

async function boot(again = false) {
  if (!again) {
    window.addEventListener('hashchange', render);
    if (!ONLINE) { render(); return; }
    // stay fresh: re-check when you come back to the tab/app, and every few minutes while open
    document.addEventListener('visibilitychange', async () => { if (!document.hidden) { await pull(); syncIfStale(); } });
    setInterval(() => { if (!document.hidden) pull(); }, 3 * 60 * 1000);
  }

  authed = !!userId; // optimistic: show the last person's cached homework instantly
  render();
  try {
    const s = await api('GET', '/api/session');
    vapidKey = s.vapidPublicKey;
    authed = s.authed;
    me = s.user;
    school = s.school || null;
    moodle = me ? { connected: true, name: me.name } : { connected: false };
  } catch {
    return; // offline — keep showing the cached copy
  }
  if (!authed) { forgetDevice(); return; }
  if (userChanged(me.id)) state = loadLocal();
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  render();
  registerSW();
  await pull();
  syncIfStale();
}
boot();
