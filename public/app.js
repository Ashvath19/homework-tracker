// Homework Tracker
// Online (on Vercel): syncs with the server, which also pulls homework from Moodle.
// Opened as a local file: works offline with this browser's storage only.

const STORAGE_KEY = 'homework-tracker-v1';
const ONLINE = location.protocol.startsWith('http');
const GITHUB = 'https://github.com/Ashvath19/homework-tracker';
const reportLink = (text) => `<a href="${GITHUB}/issues/new" target="_blank" rel="noopener">${text}</a>`;
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
let feed = null;            // { kind: 'canvas'|'schoology', label, host, name } when a "log your own" account reads a calendar link
const linked = () => moodle.connected || !!feed;
const srcName = () => (moodle.connected ? 'Moodle' : feed?.label || 'Canvas');
const SOURCE_NAMES = { moodle: 'Moodle', canvas: 'Canvas', schoology: 'Schoology' };
// How to find the calendar link on each site. Schoology's menu names differ a little between schools.
const FEED_HOWTO = {
  canvas: {
    placeholder: 'https://…instructure.com/feeds/calendars/user_….ics',
    steps: `<li>Open your school's Canvas website on a computer (not the app), for example <a href="https://esuhsd.instructure.com/calendar" target="_blank" rel="noopener">esuhsd.instructure.com</a>, and go to <b>Calendar</b>.</li>
      <li>Click <b>Calendar Feed</b> at the bottom right, under the list of calendars.</li>
      <li>Copy the link it shows and paste it here.</li>`,
  },
  schoology: {
    placeholder: 'https://…schoology.com/calendar/feed/ical/…/ical.ics',
    steps: `<li>Open your school's Schoology website on a computer (not the app) and go to your <b>Calendar</b>.</li>
      <li>At the bottom, click <b>Export</b>, then <b>Share Calendar</b>. If you don't see it, look in <b>Account Settings</b> for <b>Share your Schoology calendar</b> and turn it on. The names can be a little different at each school.</li>
      <li>Copy the iCal link it shows (it ends in <b>ical.ics</b>) and paste it here.</li>`,
  },
};
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
  if (!ONLINE || !authed || !linked()) return;
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

// ---------- school schedules ----------
// VCS (Moodle) accounts: A/B/C letters from the VCS calendar, sent by the server.
// "Log your own" accounts: their own schedule — a built-in school file (e.g. Wilcox), or a pattern they set up.
let schedule = null;   // own accounts: { type: 'school'|'weekday'|'rotation'|'daily', ..., off: [dates] }
let schoolCal = null;  // the loaded school file, when schedule.type === 'school'
let schoolList = null; // /schools/index.json, loaded for the setup page
const isOwn = () => me?.kind === 'own';
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function loadSchoolCal() {
  if (schedule?.type !== 'school') { schoolCal = null; return; }
  const key = `hw-school:${schedule.school}`;
  try {
    const r = await fetch(`/schools/${schedule.school}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    schoolCal = await r.json();
    safeSet(key, JSON.stringify(schoolCal));
  } catch {
    try { schoolCal = JSON.parse(safeGet(key)); } catch { schoolCal = null; }
  }
}

function addDaysStr(ds, n) { const d = parseDate(ds); d.setDate(d.getDate() + n); return dateStr(d); }
const isWeekend = (ds) => { const w = parseDate(ds).getDay(); return w === 0 || w === 6; };

// A pattern's label for a school day. skip(d) says whether a day doesn't count (weekend, day off, special day).
function patternLabel(p, ds, skip) {
  if (!p) return null;
  if (p.type === 'daily') return { label: '' };
  if (p.type === 'weekday') return { label: p.days?.[parseDate(ds).getDay()] || '' };
  if (p.type === 'rotation') {
    if (!p.anchor) return null;
    // count the school days from the anchor (which is labels[0])
    let n = 0;
    if (ds > p.anchor) { for (let d = addDaysStr(p.anchor, 1); d <= ds; d = addDaysStr(d, 1)) if (!skip(d)) n++; }
    else if (ds < p.anchor) { for (let d = addDaysStr(p.anchor, -1); d >= ds; d = addDaysStr(d, -1)) if (!skip(d)) n--; }
    return { label: p.labels[((n % 2) + 2) % 2] };
  }
  return null;
}
// The weekly pattern in use: the student's own, or the built-in school's.
function activePattern() {
  const s = schedule;
  if (!s) return null;
  if (s.type !== 'school') return s;
  return s.pattern || (schoolCal?.pattern?.type === 'rotation' && !schoolCal.pattern.anchor ? null : schoolCal?.pattern) || null;
}

// What kind of school day a date is: { off: true } for no school, { label, note } for a school day
// (label '' means a regular day when every class meets), or null when we don't know.
function dayInfo(ds) {
  if (!isOwn()) {
    if (!school?.days) return null;
    const L = school.days[ds];
    return L ? { label: L === 'C' ? '' : L } : { off: true };
  }
  const s = schedule;
  if (!s) return null;
  if (isWeekend(ds) || s.off?.includes(ds)) return { off: true };
  if (s.type !== 'school') return patternLabel(s, ds, (d) => isWeekend(d) || s.off?.includes(d));
  const f = schoolCal;
  if (!f) return null;
  if (ds < f.first) return { off: true };
  let unsure = false;
  if (ds > f.last) {
    // summer break, then (until next year's calendar is added) just the weekly pattern
    if (ds < `${f.last.slice(0, 4)}-08-01`) return { off: true };
    unsure = true;
  } else {
    if (f.off.includes(ds)) return { off: true };
    if (f.special?.[ds]) return { ...f.special[ds] };
  }
  const info = patternLabel(activePattern(), ds,
    (d) => isWeekend(d) || s.off?.includes(d) || f.off.includes(d) || !!f.special?.[d]);
  return info && { ...info, unsure };
}

// The day choices a class can have ("A"/"B", "Odd"/"Even", ...). Empty when classes meet every day.
function classDayOptions() {
  if (!isOwn()) return school ? ['A', 'B'] : [];
  const s = schedule;
  if (!s) return [];
  if (s.type === 'school' && schoolCal?.classDays?.length) return schoolCal.classDays;
  const p = activePattern();
  if (p?.type === 'rotation') return [...p.labels];
  if (p?.type === 'weekday') return [...new Set(Object.values(p.days || {}).filter((l) => l && l !== 'All'))];
  return [];
}
// Does this class meet on that day?
function meets(c, info) {
  if (!info || info.off) return false;
  if (!info.label || info.label === 'All' || info.label === 'Finals' || !c?.day) return true;
  return c.day === info.label || !classDayOptions().includes(info.label);
}
// Next day (after today) the class meets — the natural due date for new homework.
function nextMeeting(c) {
  let ds = dateStr(new Date());
  if (!c?.day || !classDayOptions().length) return tomorrow();
  for (let i = 0; i < 40; i++) {
    ds = addDaysStr(ds, 1);
    const info = dayInfo(ds);
    if (!info) return tomorrow();
    if (meets(c, info)) return ds;
  }
  return tomorrow();
}
// Short text for a day, for the calendar cell and pill.
function dayName(info, long) {
  if (!info || info.off || !info.label) return '';
  if (!isOwn()) return long ? `${info.label} day` : info.label;
  const names = (schedule?.type === 'school' && schoolCal?.labelNames) || {};
  return long ? (names[info.label] || `${info.label} day`) : (schoolCal?.short?.[info.label] || info.label);
}

// ---------- passkeys (browser side) ----------
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const passkeysSupported = () => !!window.PublicKeyCredential && !!navigator.credentials;

async function passkeyCreate(options) {
  const pk = PublicKeyCredential.parseCreationOptionsFromJSON ? PublicKeyCredential.parseCreationOptionsFromJSON(options) : {
    ...options, challenge: fromB64u(options.challenge), user: { ...options.user, id: fromB64u(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey: pk });
  if (cred.toJSON) try { return cred.toJSON(); } catch {}
  const r = cred.response;
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports?.() || [] },
  };
}
async function passkeyGet(options) {
  const pk = PublicKeyCredential.parseRequestOptionsFromJSON ? PublicKeyCredential.parseRequestOptionsFromJSON(options) : {
    ...options, challenge: fromB64u(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })),
  };
  const cred = await navigator.credentials.get({ publicKey: pk });
  if (cred.toJSON) try { return cred.toJSON(); } catch {}
  const r = cred.response;
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : undefined,
    },
  };
}
// Runs both steps of a passkey ceremony with the server.
async function passkeyFlow(kind, extra = {}) {
  const start = await api('POST', '/api/login', { passkey: `${kind}-start`, ...extra });
  let credential;
  try {
    credential = kind === 'login' ? await passkeyGet(start.options) : await passkeyCreate(start.options);
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'AbortError') throw new Error('Cancelled. Try again when you\'re ready.');
    if (e.name === 'InvalidStateError') throw new Error('This device already has a passkey for this account.');
    throw new Error("Your device couldn't make a passkey. Try another browser, or update this one.");
  }
  return api('POST', '/api/login', { passkey: `${kind}-finish`, ticket: start.ticket, credential });
}
async function saveSchedule(s) {
  const r = await api('PUT', '/api/account', { schedule: s });
  schedule = r.schedule;
  await loadSchoolCal();
}

// ---------- schedule setup page (#/setup), "log your own" accounts ----------
let setupMode = null;   // null (ask school) | 'manual' (own pattern) | 'today' (which rotation day is today)
let setupSchool = null; // the school file picked, when it still needs the student's pattern or today's day
function renderSetup() {
  const sch = schoolList?.schools || [];
  const today = dateStr(new Date());
  let nextSchoolDay = today;
  while (isWeekend(nextSchoolDay)) nextSchoolDay = addDaysStr(nextSchoolDay, 1);
  const whenWord = nextSchoolDay === today ? 'Today' : `${WEEKDAY_NAMES[parseDate(nextSchoolDay).getDay()]}`;
  const cur = setupSchool ? (schedule?.pattern || {}) : (schedule || {});
  if (setupMode === 'today' && setupSchool) {
    let d = today;
    while (isWeekend(d) || setupSchool.off.includes(d) || setupSchool.special?.[d] || d < setupSchool.first) d = addDaysStr(d, 1);
    const when = d === today ? 'today' : parseDate(d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    $('#main').innerHTML = `
      <div class="page-header"><h2>${esc(setupSchool.name)}</h2></div>
      <p class="subtitle">Holidays and finals are built in. One question so the days line up:</p>
      <section class="card setup">
        <h3>Is ${when} a ${setupSchool.pattern.labels.map(esc).join(' or ')} day?</h3>
        <div class="row">${setupSchool.pattern.labels.map((l, i) => `<button class="btn" data-action="pick-today" data-i="${i}" data-date="${d}">${esc(l)}</button>`).join('')}</div>
        <p class="hint">If it ever gets out of sync, you can fix it in Settings.</p>
        <button class="link-btn" data-action="setup-back">Back to the school list</button>
      </section>`;
    return;
  }
  const days = cur.type === 'weekday' ? cur.days : { 1: '', 2: '', 3: '', 4: '', 5: '' };
  const labels = cur.type === 'rotation' ? cur.labels : ['A', 'B'];

  $('#main').innerHTML = `
    <div class="page-header"><h2>Your school schedule</h2></div>
    <p class="subtitle">This lets the calendar show which classes meet each day, and new homework default to your next class.</p>
    ${setupMode !== 'manual' ? `
      <section class="card setup">
        <h3>What school do you go to?</h3>
        ${sch.length > 6 ? `<input class="field school-search" type="search" placeholder="Search for your school" aria-label="Search schools" autocomplete="off">` : ''}
        ${sch.length ? `<div class="school-pick">${sch.map((s) => `
          <button class="school-btn ${cur.type === 'school' && cur.school === s.id ? 'on' : ''}" data-action="pick-school" data-school="${s.id}">
            <b>${esc(s.name)}</b><small>${esc(s.place || '')}</small></button>`).join('')}</div>` : '<p class="hint">Loading schools…</p>'}
        <p class="hint">Schools near San Jose are built in so far. Not on the list? Set yours up yourself: it takes a minute.</p>
        <div class="row"><button class="btn" data-action="setup-manual">My school isn't listed</button></div>
      </section>` : `
      <form class="card setup" data-form="setup">
        ${setupSchool ? `<p>${esc(setupSchool.name)}'s holidays and breaks are built in, but not its weekly schedule yet.</p>` : ''}
        <h3>How does your ${setupSchool ? 'week' : 'schedule'} work?</h3>
        <label class="opt"><input type="radio" name="type" value="daily" ${cur.type === 'daily' ? 'checked' : ''}>
          <span><b>Every class, every day</b><small>A normal schedule with no rotation.</small></span></label>
        <label class="opt"><input type="radio" name="type" value="weekday" ${cur.type === 'weekday' ? 'checked' : ''}>
          <span><b>Same pattern every week</b><small>Like odd periods on Tue/Thu, even on Wed/Fri, and all classes Monday.</small></span></label>
        <div class="opt-more" data-for="weekday">
          <div class="wk-grid">${[1, 2, 3, 4, 5].map((d) => `
            <label>${WEEKDAY_NAMES[d].slice(0, 3)}<input name="d${d}" value="${esc(days[d] || '')}" maxlength="12" placeholder="All"></label>`).join('')}</div>
          <p class="hint">Name each day (like Odd, Even, All). Leave a day blank or type All if every class meets.
            <button type="button" class="link-btn" data-action="preset-oddeven">Fill in odd/even with all classes Monday</button></p>
        </div>
        <label class="opt"><input type="radio" name="type" value="rotation" ${cur.type === 'rotation' ? 'checked' : ''}>
          <span><b>Two days that alternate</b><small>A/B, Day 1/Day 2, and so on, switching every school day.</small></span></label>
        <div class="opt-more" data-for="rotation">
          <div class="row">
            <label>Day names <input name="l0" value="${esc(labels[0])}" maxlength="12" required class="field short"></label>
            <label>and <input name="l1" value="${esc(labels[1])}" maxlength="12" required class="field short"></label>
          </div>
          <label>${whenWord} is <select name="now">
            <option value="0">the first one (${esc(labels[0])})</option><option value="1">the second one (${esc(labels[1])})</option>
          </select></label>
          <p class="hint">Days off can throw it off. Mark them in the calendar, or fix it later in Settings.</p>
        </div>
        <div class="row">
          <button class="primary">Save schedule</button>
          <button type="button" class="link-btn" data-action="setup-back">Back to the school list</button>
        </div>
      </form>`}
    ${schedule ? '' : `<p><button class="link-btn" data-action="setup-skip">Skip for now</button></p>`}`;
}

// ---------- calendar (right side, wide screens) ----------
let calMonth = null; // 'YYYY-MM' being shown
let calSel = null;   // 'YYYY-MM-DD' selected day
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// cls: a class to show only its homework, null for everything, undefined to hide the calendar
function renderCalendar(cls) {
  const el = $('#cal');
  if (!el) return;
  if (cls === undefined) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;

  const today = dateStr(new Date());
  calSel ||= today;
  calMonth ||= today.slice(0, 7);
  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();

  const mine = tasks().filter((t) => t.due && classById(t.classId) && (!cls || t.classId === cls.id));
  const byDay = {};
  for (const t of mine) (byDay[t.due] ||= []).push(t);

  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<span class="cal-cell empty"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${calMonth}-${String(d).padStart(2, '0')}`;
    const todo = (byDay[ds] || []).filter((t) => !t.done);
    const big = todo.some((t) => TAGS[t.tag]?.big);
    const dots = todo.slice(0, 3).map((t) => `<i style="background:${classColor(classById(t.classId))}"></i>`).join('')
      + (todo.length > 3 ? '<b>+</b>' : '');
    const info = dayInfo(ds);
    const letter = dayName(info);
    const cl = ['cal-cell', ds === today && 'today', ds === calSel && 'sel', ds < today && todo.length && 'late',
      big && 'big', (info ? info.off : isWeekend(ds)) && 'off'].filter(Boolean).join(' ');
    const label = parseDate(ds).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
      + (todo.length ? `, ${todo.length} due` : '') + (letter ? `, ${dayName(info, true)}` : info?.off ? ', no school' : '');
    cells.push(`<button class="${cl}" data-action="cal-day" data-date="${ds}" aria-label="${esc(label)}" aria-pressed="${ds === calSel}">
      <span class="cal-num">${d}</span>${letter ? `<span class="cal-letter">${esc(letter.slice(0, 4))}</span>` : ''}
      <span class="cal-dots">${dots}</span></button>`);
  }

  const sel = (byDay[calSel] || []).sort((a, b) => a.done - b.done || byDue(a, b));
  const selInfo = dayInfo(calSel);
  const canMark = isOwn() && schedule && !isWeekend(calSel) && !(selInfo?.off && !schedule.off?.includes(calSel));
  const selTitle = calSel === today ? 'Today' : calSel === tomorrow() ? 'Tomorrow'
    : parseDate(calSel).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  el.innerHTML = `
    <div class="cal-inner">
      <div class="cal-head">
        <h3>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
        <button class="icon-btn" data-action="cal-move" data-step="-1" aria-label="Previous month">‹</button>
        <button class="icon-btn" data-action="cal-move" data-step="1" aria-label="Next month">›</button>
      </div>
      ${cls ? `<p class="cal-for"><span class="dot" style="background:${classColor(cls)}"></span>${esc(cls.name)} only</p>` : ''}
      <div class="cal-grid">${WEEKDAYS.map((w) => `<span class="cal-wd">${w}</span>`).join('')}${cells.join('')}</div>
      ${calMonth !== today.slice(0, 7) || calSel !== today ? `<button class="link-btn cal-today" data-action="cal-today">Back to today</button>` : ''}
      <div class="cal-day">
        <h4>${selTitle}${dayName(selInfo) ? ` <span class="cal-pill">${esc(dayName(selInfo, true))}</span>` : selInfo?.off ? ' <span class="cal-pill off">No school</span>' : ''}</h4>
        ${selInfo?.note ? `<p class="cal-note">${esc(selInfo.note)}</p>` : ''}
        ${sel.length ? `<ul class="cal-list">${sel.map((t) => {
          const c = classById(t.classId);
          return `<li data-id="${t.id}" class="${t.done ? 'done' : ''}"><button data-action="open-task">
            <span class="dot" style="background:${classColor(c)}"></span>
            <span class="cal-t">${TAGS[t.tag]?.big ? `<b>${TAGS[t.tag].label}:</b> ` : ''}${esc(t.title)}<small>${esc(c.name)}</small></span></button></li>`;
        }).join('')}</ul>` : `<p class="cal-none">Nothing due.</p>`}
        ${canMark ? `<button class="link-btn cal-mark" data-action="cal-mark-off">${schedule.off?.includes(calSel) ? 'Actually, there is school this day' : 'Mark as no school'}</button>` : ''}
      </div>
    </div>`;
}

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const live = (arr) => arr.filter((x) => !x.deleted);
const classes = () => live(state.classes);
const tasks = () => live(state.tasks);
const classById = (id) => state.classes.find((c) => c.id === id && !c.deleted);
const pending = () => tasks().filter((t) => !t.done && classById(t.classId));

// ---------- celebrations (Settings > Animations; saved on this device) ----------
let anim = { one: true, day: true };
try { anim = { ...anim, ...JSON.parse(safeGet('hw-anim') || '{}') }; } catch {}
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const CONFETTI = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#8b5cf6', '#f78c6b'];

// Call right after checking something off. rect = where the checkbox/button was (before the redraw).
function celebrate(t, rect) {
  if (!t?.done) return;
  const sameDay = t.due ? tasks().filter((x) => x.due === t.due && classById(x.classId)) : [];
  if (anim.day && sameDay.length >= 2 && sameDay.every((x) => x.done)) return celebrateDay(t.due);
  if (!anim.one) return;
  popCheck(t.id);
  if (!reducedMotion() && rect) burst(rect, classColor(classById(t.classId)));
}
function popCheck(id) {
  requestAnimationFrame(() => {
    const box = document.querySelector(`.task[data-id="${CSS.escape(id)}"] input[type=checkbox]`);
    if (box) { box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop'); }
  });
}
function confettiLayer() {
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  return layer;
}
// A small burst from one spot.
function burst(rect, color) {
  const layer = confettiLayer();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('i');
    p.style.left = `${x}px`; p.style.top = `${y}px`;
    p.style.background = i % 3 === 0 ? color : CONFETTI[i % CONFETTI.length];
    layer.append(p);
    const a = (Math.PI * 2 * i) / 16 + Math.random() * 0.4, d = 34 + Math.random() * 30;
    p.animate([
      { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + 18}px)) scale(.6) rotate(${200 + Math.random() * 300}deg)`, opacity: 0 },
    ], { duration: 650 + Math.random() * 200, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' });
  }
  setTimeout(() => layer.remove(), 1000);
}
// Everything due on a day is done: confetti across the whole screen, plus a message.
function celebrateDay(due) {
  const today = dateStr(new Date());
  const name = due === today ? 'today' : due === tomorrow() ? 'tomorrow'
    : new Date(`${due}T12:00`).toLocaleDateString('en-US', { weekday: 'long', ...(due < today || due > addDaysStr(today, 6) ? { month: 'short', day: 'numeric' } : {}) });
  toast(`All done for ${name}! 🎉`);
  if (reducedMotion()) return;
  const layer = confettiLayer();
  const w = window.innerWidth, h = window.innerHeight;
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('i');
    p.className = i % 4 === 0 ? 'strip' : '';
    p.style.left = `${Math.random() * w}px`; p.style.top = '-12px';
    p.style.background = CONFETTI[i % CONFETTI.length];
    layer.append(p);
    const drift = (Math.random() - 0.5) * 160;
    p.animate([
      { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${drift}px, ${h * 0.6}px) rotate(${360 + Math.random() * 360}deg)`, opacity: 1, offset: 0.75 },
      { transform: `translate(${drift * 1.3}px, ${h + 30}px) rotate(${540 + Math.random() * 360}deg)`, opacity: 0 },
    ], { duration: 1600 + Math.random() * 1200, delay: Math.random() * 400, easing: 'cubic-bezier(.25,.6,.5,1)', fill: 'forwards' });
  }
  setTimeout(() => layer.remove(), 3400);
}
function animationsCard() {
  const row = (key, label, hint) => `<label class="check-row"><input type="checkbox" data-anim="${key}" ${anim[key] ? 'checked' : ''}>
      <span><b>${label}</b><small>${hint}</small></span></label>`;
  return `${row('one', 'When you finish an assignment', 'The checkbox pops and a little confetti flies out.')}
    ${row('day', 'When you finish everything due on a day', 'Confetti across the screen and an "All done" message.')}
    <div class="row"><button class="link-btn" data-action="anim-try">Try them</button></div>
    <p class="hint">Saved on this device only.${reducedMotion() ? ' Your device is set to reduce motion, so you\'ll see the message without the confetti.' : ''}</p>`;
}

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
  if (route === '/setup' && isOwn()) {
    renderSetup();
    if (!schoolList) fetch('/schools/index.json').then((r) => r.json()).then((j) => { schoolList = j; render(); }).catch(() => {});
  }
  else if (route === '/settings') renderSettings();
  else if (cls) renderClass(cls);
  else renderDashboard();
  renderCalendar(route === '/settings' || route === '/setup' ? undefined : (cls ? cls : null));
}

let loginMode = 'key';
let loginKind = safeGet('hw-login-kind') || 'vcs'; // 'vcs' (Moodle key) | 'canvas' | 'schoology' (calendar link) | 'own' (log your own, passkey)
function renderLogin() {
  if (loginKind === 'own' && loginMode !== 'code') return renderOwnLogin();
  if ((loginKind === 'canvas' || loginKind === 'schoology') && loginMode !== 'code') return renderFeedLogin(loginKind);
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
      <button type="button" class="link-btn switch" data-action="login-mode" data-mode="key">${loginKind === 'own' ? 'Log in with a passkey instead' : FEED_HOWTO[loginKind] ? `Log in with your ${SOURCE_NAMES[loginKind]} link instead` : 'Log in with your Moodle key instead'}</button>
    </form>`;
  $('#main').innerHTML = `
    <div class="login">
      <h1><span class="hl">Homework</span></h1>
      <p class="lede">Your Moodle assignments, sorted by when they're due.</p>
      ${loginTabs()}
      <div class="beta-note">
        <p><b>Still being tested.</b> It might miss some homework or show the wrong due date, especially for classes with different teachers. Double-check Moodle for anything important, and ${reportLink('report it on GitHub')} if something's off.</p>
        <p><b>Your Moodle key is like a password.</b> This site stores it to read your Moodle account as you. It's run by a student, not VCS, so only use it if you trust whoever runs it. You can cut off access anytime by resetting your key on Moodle.</p>
      </div>
      ${loginMode === 'code' ? codeForm : keyForm}
      <p class="err" id="login-err" role="alert"></p>
    </div>`;
  $('#main input')?.focus();
}

function loginTabs() {
  return `<div class="seg login-tabs" role="tablist">
    <button role="tab" aria-selected="${loginKind === 'vcs'}" data-action="login-kind" data-kind="vcs">Moodle</button>
    <button role="tab" aria-selected="${loginKind === 'canvas'}" data-action="login-kind" data-kind="canvas">Canvas</button>
    <button role="tab" aria-selected="${loginKind === 'schoology'}" data-action="login-kind" data-kind="schoology">Schoology</button>
    <button role="tab" aria-selected="${loginKind === 'own'}" data-action="login-kind" data-kind="own">Log your own</button>
  </div>`;
}
function renderFeedLogin(kind) {
  const name = SOURCE_NAMES[kind];
  $('#main').innerHTML = `
    <div class="login">
      <h1><span class="hl">Homework</span></h1>
      <p class="lede">Your ${name} assignments, sorted by when they're due.</p>
      ${loginTabs()}
      <div class="beta-note">
        <p><b>Still being tested.</b> It might miss some homework or show the wrong due date. Double-check ${name} for anything important, and ${reportLink('report it on GitHub')} if something's off.</p>
        <p><b>Your ${name} link works like a password.</b> Anyone with it can see your ${name} calendar and log in here as you, so don't share it. It can't see your grades or messages, or turn anything in.</p>
      </div>
      <form class="login-form" data-form="login-feed" data-kind="${kind}">
        <label for="feed-link">${name} calendar link</label>
        <input id="feed-link" name="feed" class="field" placeholder="${FEED_HOWTO[kind].placeholder}" autocomplete="off" autocapitalize="off" spellcheck="false" required>
        <button class="primary">Log in</button>
        <details>
          <summary>Where do I find it?</summary>
          <ol>${FEED_HOWTO[kind].steps}</ol>
          The first time, this makes your account. After that, the same link logs you back in.
        </details>
        <details>
          <summary>What can it see?</summary>
          <ul>
            <li>Only your ${name} calendar: assignment names, due dates and instructions. ${name} doesn't share what you've turned in, so you check things off yourself${kind === 'schoology' ? `, which also means nothing gets marked done by mistake. Work from the last 2 weeks shows up too, so you can catch anything missing` : ''}.</li>
            <li>It's stored encrypted, and only you can see your homework list here.</li>
            <li>This site is run by a student, not your school. To cut it off, disconnect ${name} in Settings or delete your account.</li>
          </ul>
        </details>
        <button type="button" class="link-btn switch" data-action="login-mode" data-mode="code">Log in with a code from another device</button>
      </form>
      <p class="err" id="login-err" role="alert"></p>
    </div>`;
  $('#main input')?.focus();
}

function renderOwnLogin() {
  const ok = passkeysSupported();
  $('#main').innerHTML = `
    <div class="login">
      <h1><span class="hl">Homework</span></h1>
      <p class="lede">Keep track of your homework, sorted by when it's due.</p>
      ${loginTabs()}
      <div class="beta-note">
        <p><b>Still being tested.</b> Something might not work quite right. ${reportLink('Report it on GitHub')} if something's off.</p>
        <p><b>No password.</b> You log in with a passkey: your device's Face ID, fingerprint or PIN. The site never sees your face or fingerprint, and there's no password to leak.</p>
      </div>
      ${ok ? `
      <form class="login-form" data-form="signup">
        <label for="own-name">New here? Your name</label>
        <input id="own-name" name="name" class="field" maxlength="40" autocomplete="given-name" required>
        <button class="primary">Create account</button>
      </form>
      <div class="login-or"><span>or</span></div>
      <div class="login-form">
        <button class="btn" data-action="passkey-login">Log in with a passkey</button>
        <button type="button" class="link-btn switch" data-action="login-mode" data-mode="code">Log in with a code from another device</button>
      </div>` : `
      <p class="bad">This browser can't use passkeys. Update it, or try Safari or Chrome.</p>
      <button type="button" class="link-btn switch" data-action="login-mode" data-mode="code">Log in with a code from another device</button>`}
      <p class="err" id="login-err" role="alert"></p>
    </div>`;
}

function renderSidebar(active) {
  const counts = {};
  pending().forEach((t) => (counts[t.classId] = (counts[t.classId] || 0) + 1));

  document.querySelector('[data-route="/"]').classList.toggle('active', active === '/');
  document.querySelector('[data-route="/settings"]').classList.toggle('active', active === '/settings');
  $('#class-list').innerHTML = classes().map((c) => `
    <a href="#/class/${c.id}" class="nav-link ${c.id === active ? 'active' : ''}">
      <span class="dot" style="background:${classColor(c)}"></span>
      <span>${esc(c.name)}</span>
      <span class="count">${counts[c.id] || ''}</span>
    </a>`).join('') || `<p class="subtitle" style="margin:4px 10px;font-size:13px">No classes yet</p>`;
  $('#sync-status').textContent = !linked() ? (ONLINE && !isOwn() ? 'Moodle not connected' : '')
    : meta.lastError ? `⚠️ ${srcName()} sync problem`
    : meta.lastSync ? `${srcName()} checked ${ago(meta.lastSync)}` : '';
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
      <input type="date" name="due" value="${nextMeeting(classId ? classById(classId) : classes()[0])}" aria-label="Due date">
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
  const meta = (showClass && c) || t.notes || t.doneBy === 'moodle' || t.doneBy === 'canvas' || t.doneBy === 'schoology' || t.source === 'lesson' || t.files?.length || t.study?.length ? `<span class="task-meta">
          ${showClass && c ? `<span class="chip"><span class="dot" style="background:${classColor(c)}"></span>${esc(c.name)}</span>` : ''}
          ${t.source === 'lesson' && !t.done ? `<span title="From the lesson plan for ${esc(t.chapter || '')}">Lesson plan</span>` : ''}
          ${!t.done && (t.study?.length) ? `<span>${t.study.length} study file${t.study.length === 1 ? '' : 's'}</span>` : ''}
          ${!t.done && !t.study?.length && t.files?.length ? `<span>${t.files.length} file${t.files.length === 1 ? '' : 's'}</span>` : ''}
          ${t.notes ? `<span title="${esc(t.notes)}">Has notes</span>` : ''}
          ${t.done && t.doneBy === 'moodle' ? `<span>Submitted on Moodle</span>` : ''}
          ${t.done && (t.doneBy === 'canvas' || t.doneBy === 'schoology') ? `<span>Removed from ${SOURCE_NAMES[t.doneBy]}</span>` : ''}
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

// ---------- colors: backdrop + text color (saved on this device only) ----------
// mode: 'plain' | 'color' (one color) | 'gradient' (two colors + direction) | 'photo'
const GRAD_DIRS = { 180: 'Top to bottom', 135: 'Diagonal', 90: 'Left to right', 45: 'Other diagonal', radial: 'From the center' };
const OLD_PRESETS = { // presets from before you could pick your own colors
  sky: ['#a1c4fd', '#c2e9fb'], sunset: ['#ff9a8b', '#ffc796'], mint: ['#84fab0', '#8fd3f4'], lavender: ['#e0c3fc', '#8ec5fc'],
  peach: ['#ffecd2', '#fcb69f'], forest: ['#134e5e', '#71b280'], night: ['#0f2027', '#2c5364'], graph: ['#e8edf8', '#e8edf8'], dots: ['#efece4', '#efece4'],
};
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_STOPS = 6;
let backdrop = { mode: 'plain', color: '#8ec5fc', stops: ['#a1c4fd', '#fbc2eb'], dir: '135', fade: 0.72, textLight: '', textDark: '',
  tintOn: false, tint: '#7c6cf0', tintStrength: 0.85 };
// Text color is saved separately for light and dark mode, so dark text picked in the day
// doesn't vanish when your device switches to dark mode at night.
const darkMq = window.matchMedia?.('(prefers-color-scheme: dark)');
const textKey = () => (darkMq?.matches ? 'textDark' : 'textLight');
const textNow = () => backdrop[textKey()] || '';
try {
  const saved = JSON.parse(safeGet('hw-backdrop') || '{}');
  if (saved.id && !saved.mode) { // old format
    const old = OLD_PRESETS[saved.id];
    Object.assign(saved, saved.id === 'photo' ? { mode: 'photo' } : old ? { mode: 'gradient', stops: old, dir: '135' } : { mode: 'plain' });
  }
  if (!saved.stops && saved.g1 && saved.g2) saved.stops = [saved.g1, saved.g2]; // two-color version
  if (saved.stops && !(Array.isArray(saved.stops) && saved.stops.length >= 2 && saved.stops.every((c) => HEX.test(c)))) delete saved.stops;
  if (saved.stops) saved.stops = saved.stops.slice(0, MAX_STOPS);
  for (const k of ['color', 'textLight', 'textDark', 'tint']) if (saved[k] && !HEX.test(saved[k])) delete saved[k];
  backdrop = { ...backdrop, ...saved };
} catch {}

function backdropCss() {
  const b = backdrop;
  if (b.mode === 'photo') { const photo = safeGet('hw-backdrop-photo'); return photo ? `center / cover no-repeat url("${photo}")` : ''; }
  if (b.mode === 'color') return b.color;
  if (b.mode === 'gradient') return b.dir === 'radial' ? `radial-gradient(circle at center, ${b.stops.join(', ')})` : `linear-gradient(${Number(b.dir) || 135}deg, ${b.stops.join(', ')})`;
  return '';
}
function applyBackdrop() {
  const css = backdropCss();
  const st = document.body.style;
  document.body.classList.toggle('has-bd', !!css);
  st.setProperty('--bd', css || 'none');
  st.setProperty('--bd-fade', `${Math.round(Math.min(0.95, Math.max(0.4, +backdrop.fade || 0.72)) * 100)}%`);
  // Your text color, with lighter shades of it for hints and labels
  const text = textNow();
  // Everything drawn in "ink" follows it: secondary text, dates and labels (slightly softer shades
  // of your color), divider lines, borders and hover highlights.
  const mix = (pct, base = 'var(--paper)') => text && `color-mix(in srgb, ${text} ${pct}%, ${base})`;
  for (const [k, v] of Object.entries({
    '--ink': text, '--ink-2': mix(86), '--ink-3': mix(68), '--rule': mix(48), '--hover': mix(10, 'transparent'),
  })) {
    if (v) st.setProperty(k, v); else st.removeProperty(k);
  }
  const warn = document.getElementById('text-warn');
  if (warn) warn.hidden = !text || contrast() >= 3;
}
function saveBackdrop(changes) {
  backdrop = { ...backdrop, ...changes };
  const { mode, color, stops, dir, fade, textLight, textDark, tintOn, tint, tintStrength } = backdrop;
  safeSet('hw-backdrop', JSON.stringify({ mode, color, stops, dir, fade, textLight, textDark, tintOn, tint, tintStrength }));
  applyBackdrop();
}
applyBackdrop();
let lastDark = darkMq?.matches;
const themeCheck = () => { if (darkMq?.matches === lastDark) return; lastDark = darkMq?.matches; applyBackdrop(); if (location.hash === '#/settings') render(); };
darkMq?.addEventListener?.('change', themeCheck);
document.addEventListener('visibilitychange', themeCheck); // backup, in case the switch happened while the tab was asleep

// Roughly how readable your text color is on the panels (WCAG contrast ratio; 4.5+ is great, under 3 is hard).
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
function contrast() {
  const paperHex = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  const paper = HEX.test(paperHex) ? rgb(paperHex) : [246, 247, 249];
  const b = backdrop;
  const under = b.mode === 'color' ? rgb(b.color) : b.mode === 'gradient' ? [0, 1, 2].map((i) => b.stops.reduce((sum, c) => sum + rgb(c)[i], 0) / b.stops.length) : paper;
  const f = b.mode === 'plain' ? 1 : +b.fade || 0.72;
  const panel = paper.map((v, i) => v * f + under[i] * (1 - f));
  const [x, y] = [lum(rgb(textNow())), lum(panel)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// ---------- class colors: "match to one color" ----------
// Each class color is turned to gray (keeping how light or dark it is), then tinted with the color
// you picked. Lightness is spread across your classes so they stay easy to tell apart, and the
// strength slider keeps colors closer to their originals.
const hexOf = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, sat, l];
}
function hslToRgb([h, sat, l]) {
  if (!sat) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const grayOf = (hex) => { const [r, g, b] = rgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b; };
let tintCache = null;
function classColor(c) {
  const orig = HEX.test(c?.color || '') ? c.color : COLORS[0];
  if (!backdrop.tintOn) return orig;
  const key = `${backdrop.tint}|${backdrop.tintStrength}|${state.classes.map((x) => x.color).join()}`;
  if (tintCache?.key !== key) {
    // rank classes from darkest to lightest, then give them evenly spaced shades of the tint
    const grays = [...new Set(state.classes.filter((x) => !x.deleted && HEX.test(x.color || '')).map((x) => x.color))].sort((a, b) => grayOf(a) - grayOf(b));
    const [h, sat] = rgbToHsl(rgb(backdrop.tint));
    const map = new Map(grays.map((col, i) => {
      const l = grays.length > 1 ? 0.34 + (0.38 * i) / (grays.length - 1) : rgbToHsl(rgb(backdrop.tint))[2];
      const tinted = hslToRgb([h, Math.max(0.35, sat), l]);
      const k = +backdrop.tintStrength || 0.85;
      return [col, hexOf(...rgb(col).map((v, j) => v * (1 - k) + tinted[j] * k))];
    }));
    tintCache = { key, map };
  }
  return tintCache.map.get(orig) || orig;
}

// Recolor the class dots already on screen, so dragging a picker doesn't redraw (and close) it.
function refreshClassColors() {
  for (const a of document.querySelectorAll('#class-list a[href^="#/class/"]')) {
    const c = classById(a.getAttribute('href').slice(8));
    const dot = a.querySelector('.dot');
    if (c && dot) dot.style.background = classColor(c);
  }
  const prev = document.querySelector('.tint-preview');
  if (prev) prev.innerHTML = classes().slice(0, 8).map((c) => `<span class="chip"><span class="dot" style="background:${classColor(c)}"></span>${esc(c.name)}</span>`).join('');
}

function backdropCard() {
  const b = backdrop;
  const photo = safeGet('hw-backdrop-photo');
  const text = textNow();
  const inkNow = text || getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
  const modes = { plain: 'Plain', color: 'Color', gradient: 'Gradient', photo: 'Photo' };
  const pick = (id, label, value) => `<label class="color-pick"><input type="color" id="${id}" value="${esc(value)}"><span>${label}</span></label>`;
  return `
    <h4 class="sub">Backdrop</h4>
    <div class="seg bd-modes" role="group" aria-label="Backdrop">
      ${Object.entries(modes).map(([id, label]) => `<button data-action="bd-mode" data-mode="${id}" aria-pressed="${b.mode === id}">${label}</button>`).join('')}
    </div>
    ${b.mode === 'color' ? `<div class="row">${pick('bd-color', 'Color', b.color)}</div>` : ''}
    ${b.mode === 'gradient' ? `<div class="bd-stops">
      ${b.stops.map((c, i) => `<span class="bd-stop">
        <input type="color" class="bd-stop-color" data-i="${i}" value="${esc(c)}" aria-label="Color ${i + 1}">
        ${b.stops.length > 2 ? `<button class="bd-stop-x" data-action="bd-stop-remove" data-i="${i}" aria-label="Remove color ${i + 1}">×</button>` : ''}
      </span>`).join('')}
      ${b.stops.length < MAX_STOPS ? `<button class="btn bd-stop-add" data-action="bd-stop-add" aria-label="Add a color">+ Add color</button>` : ''}
    </div>
    <div class="row bd-grad">
      <label class="color-pick">Direction <select id="bd-dir" class="field">${Object.entries(GRAD_DIRS).map(([v, n]) => `<option value="${v}" ${String(b.dir) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="link-btn" data-action="bd-swap">Reverse order</button>
    </div>` : ''}
    ${b.mode === 'photo' ? `<div class="row">
      <button class="btn" data-action="bd-upload">${photo ? 'Use a different photo' : 'Choose a photo'}</button>
      ${photo ? `<button class="link-btn" data-action="bd-photo-off">Remove photo</button>` : ''}
    </div>` : ''}
    <input type="file" id="bd-file" accept="image/*" hidden>
    ${b.mode !== 'plain' ? `<label class="bd-fade">How much shows through
      <input type="range" id="bd-fade" min="40" max="95" step="1" value="${Math.round(135 - b.fade * 100)}">
    </label>` : ''}

    <h4 class="sub">Class colors</h4>
    <div class="seg bd-modes" role="group" aria-label="Class colors">
      <button data-action="tint-mode" data-on="0" aria-pressed="${!b.tintOn}">Each class's own</button>
      <button data-action="tint-mode" data-on="1" aria-pressed="${!!b.tintOn}">Match to one color</button>
    </div>
    ${b.tintOn ? `<div class="row">${pick('tint-color', 'Match to', b.tint)}</div>
    <label class="bd-fade">How close to that color
      <input type="range" id="tint-strength" min="30" max="100" step="1" value="${Math.round((b.tintStrength || 0.85) * 100)}">
    </label>
    <div class="tint-preview">${classes().slice(0, 8).map((c) => `<span class="chip"><span class="dot" style="background:${classColor(c)}"></span>${esc(c.name)}</span>`).join('')}</div>
    <p class="hint">Your classes keep their own colors underneath, so you can switch back anytime.</p>` : ''}

    <h4 class="sub">Text color</h4>
    <div class="row">
      ${pick('text-color', text ? 'Your color' : 'Default', inkNow)}
      ${text ? `<button class="link-btn" data-action="text-reset">Back to default</button>` : ''}
    </div>
    <p class="hint">For ${darkMq?.matches ? 'dark' : 'light'} mode. ${darkMq?.matches ? 'Light' : 'Dark'} mode keeps its own text color.</p>
    <p class="bad" id="text-warn" ${!text || contrast() >= 3 ? 'hidden' : ''}>This text color is hard to read on your backdrop. Try a darker or lighter one.</p>
    <p class="hint">Saved on this device only.</p>`;
}

// Shrink photos before saving, so they fit in the browser's storage and load fast.
async function photoToDataUrl(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}

function feedCard() {
  const form = (label, placeholder) => `<form class="row" data-form="feed">
      <input name="feed" placeholder="${placeholder}" autocomplete="off" spellcheck="false" required class="field">
      <button class="btn">${label}</button>
    </form>`;
  if (!feed) return `
    <p>If your school uses Canvas or Schoology, connect it and your assignments show up here on their own, sorted into classes.</p>
    <details><summary class="hint">Where's my Canvas link?</summary><ol class="hint">${FEED_HOWTO.canvas.steps}</ol></details>
    <details><summary class="hint">Where's my Schoology link?</summary><ol class="hint">${FEED_HOWTO.schoology.steps}</ol></details>
    ${form('Connect', 'Paste your Canvas or Schoology calendar link')}
    <p class="hint">The link only shows your calendar. It can't see your grades or messages, or turn anything in. It also can't tell what you've turned in, so check things off yourself.</p>`;
  const name = feed.label;
  return `
    <p>Connected${feed.name ? ` as <b>${esc(feed.name)}</b>` : ''} on ${esc(feed.host)}. ${meta.lastSync ? `Last checked ${ago(meta.lastSync)}${meta.lastCount != null ? `, ${meta.lastCount} upcoming assignment${meta.lastCount === 1 ? '' : 's'}` : ''}.` : 'Not checked yet.'}
       It checks again every 2 hours on its own.</p>
    ${meta.lastError ? `<p class="bad">${esc(meta.lastError)}</p>` : ''}
    <div class="row">
      <button class="btn" data-action="sync-now">Check ${name} now</button>
      <button class="link-btn" data-action="feed-off">Disconnect</button>
    </div>
    <p class="hint">${name} doesn't share what you've turned in, so check things off yourself.${feed.kind === 'schoology' ? ' Anything past its due date stays here as overdue until you do, even if Schoology forgets to list it as missing.' : ''}</p>
    <details ${meta.lastError ? 'open' : ''}>
      <summary class="hint">Use a different ${name} link</summary>
      <ol class="hint">${FEED_HOWTO[feed.kind].steps}</ol>
      ${form('Save link', FEED_HOWTO[feed.kind].placeholder)}
    </details>`;
}

function renderDashboard() {
  const main = $('#main');
  if (!classes().length) {
    main.innerHTML = `
      <div class="page-header"><h2>Dashboard</h2></div>
      <p class="subtitle">Everything you have due, in date order.</p>
      <div class="empty">
        <p>${ONLINE && isOwn() && feed ? `Nothing from ${feed.label} yet. Your classes show up here as soon as teachers post assignments, or you can add them yourself.` : ONLINE && isOwn() ? 'Add your classes to get started, or connect Canvas or Schoology in Settings if your school uses one. Then add homework as you get it.' : ONLINE ? 'Nothing from Moodle yet. Your classes show up here as soon as teachers post assignments, or you can add them yourself.' : 'Start by adding your classes.'}</p>
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
  const todayInfo = dayInfo(dateStr(now));
  const letter = isOwn() ? dayName(todayInfo) : (school?.today === dateStr(now) ? school.letter : null);
  const dayBadge = !todayInfo && isOwn() ? ''
    : letter
    ? `<span class="day-badge day-${esc(letter)} ${letter.length > 2 ? 'wide' : ''}" title="${esc(isOwn() ? dayName(todayInfo, true) : `${letter} day on the VCHS calendar`)}">${esc(letter)}<small>day</small></span>`
    : todayInfo && !todayInfo.off ? `<span class="day-badge day-reg" title="Regular school day">✓<small>school</small></span>`
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
      ${ONLINE && (school || schedule) ? dayBadge : ''}
    </header>`;
}

// Classes from Moodle lesson plans need to know if you're in the A-day or B-day section.
function dayPicker() {
  if (isOwn()) {
    if (!schedule) return `
      <section class="day-setup">
        <h3>Set up your school schedule</h3>
        <p class="hint">Tell us your school or how your days work, so the calendar shows which classes meet each day.</p>
        <div class="row"><a class="btn" href="#/setup">Set up schedule</a></div>
      </section>`;
    const opts = classDayOptions();
    const need = opts.length ? classes().filter((c) => !c.day && !c.everyDay) : [];
    if (!need.length) return '';
    return `
    <section class="day-setup">
      <h3>Which days does each class meet?</h3>
      <p class="hint">So the calendar and due dates know when you have each class. You can change it later under Edit class.</p>
      <ul>
        ${need.map((c) => `
          <li>
            <span class="chip"><span class="dot" style="background:${classColor(c)}"></span>${esc(c.name)}</span>
            <span class="seg" role="group" aria-label="${esc(c.name)} day">
              ${opts.map((o) => `<button data-action="set-day" data-class="${c.id}" data-day="${esc(o)}">${esc(o)}</button>`).join('')}
              <button data-action="set-day" data-class="${c.id}" data-day="">Every day</button>
            </span>
          </li>`).join('')}
      </ul>
    </section>`;
  }
  const need = classes().filter((c) => c.moodleId && !c.day && !c.singleDay && tasks().some((t) => t.classId === c.id && t.source === 'lesson'));
  if (!need.length) return '';
  return `
    <section class="day-setup">
      <h3>Which day do you have each class?</h3>
      <p class="hint">Lesson plans list two dates, one for A days and one for B days. Pick yours so homework shows the right due date. You can change it later under Edit class.</p>
      <ul>
        ${need.map((c) => `
          <li>
            <span class="chip"><span class="dot" style="background:${classColor(c)}"></span>${esc(c.name)}</span>
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
      <span class="dot" style="background:${classColor(c)};width:14px;height:14px"></span>
      <h2>${esc(c.name)}</h2>
      <div class="actions"><button class="btn" data-action="edit-class" data-class="${c.id}">Edit class</button></div>
    </div>
    <p class="subtitle">${todo.length ? `${todo.length} to do` : "You're all caught up"}${late ? `, <span class="bad">${late} overdue</span>` : ''}.${c.moodleId ? ' Synced from Moodle.' : ''}</p>
    ${quickAddForm(c.id)}
    ${filterBar(allTodo)}
    ${todo.length ? group('To do', todo, false) : `<div class="empty"><p>No homework for ${esc(c.name)} right now.</p></div>`}
    ${completedSection(mine.filter((t) => t.done), false)}`;
}

function scheduleCard() {
  const s = schedule;
  if (!s) return `<p>Not set up yet.</p><div class="row"><a class="btn" href="#/setup">Set up schedule</a></div>`;
  let what;
  if (s.type === 'school') what = `${esc(schoolCal?.name || s.school)}'s ${esc(schoolCal?.year || '')} calendar, with its holidays built in.`
    + (s.pattern?.type === 'weekday' ? ` Your week: ${[1, 2, 3, 4, 5].map((d) => `${WEEKDAY_NAMES[d].slice(0, 3)} ${esc(s.pattern.days[d] || 'all')}`).join(', ')}.` : '')
    + (s.pattern?.type === 'daily' ? ' Every class meets every day.' : '');
  else if (s.type === 'daily') what = 'Every class meets every day.';
  else if (s.type === 'weekday') what = [1, 2, 3, 4, 5].map((d) => `${WEEKDAY_NAMES[d].slice(0, 3)}: ${esc(s.days[d] || 'all')}`).join(', ') + '.';
  else what = `${esc(s.labels[0])} and ${esc(s.labels[1])} days alternate.`;
  const info = dayInfo(dateStr(new Date()));
  const rot = activePattern()?.type === 'rotation' ? activePattern() : null;
  const fix = rot && info && !info.off && rot.labels.includes(info.label) ? `
    <p class="hint">Out of sync? Today shows as ${esc(info.label)}.
      <button class="link-btn" data-action="fix-rotation">Today is actually ${esc(rot.labels.find((l) => l !== info.label))}</button></p>` : '';
  const stale = s.type === 'school' && schoolCal && dateStr(new Date()) > schoolCal.last ? `<p class="bad">This calendar is for ${esc(schoolCal.year)}. Holidays for this year aren't added yet, so only the weekly pattern is used.</p>` : '';
  return `<p>${what}</p>${stale}${fix}
    ${s.off?.length ? `<p class="hint">${s.off.length} day${s.off.length === 1 ? '' : 's'} marked as no school. Change them by clicking the day in the calendar.</p>` : ''}
    <div class="row"><a class="btn" href="#/setup">Change schedule</a></div>`;
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
    <p class="hint">${linked() ? `You'll get a ping when new homework shows up on ${srcName()}, and a reminder at 6pm listing what's due tomorrow.` : `You'll get a reminder at 6pm listing what's due tomorrow.`}</p>`;

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
    ${isOwn() ? `<section class="card"><h3>School schedule</h3>${scheduleCard()}</section>
    ${ONLINE ? `<section class="card"><h3>${feed ? feed.label : 'Canvas or Schoology'}</h3>${feedCard()}</section>` : ''}` : `<section class="card"><h3>Moodle</h3>${moodleCard}</section>`}
    <section class="card"><h3>Colors</h3>${backdropCard()}</section>
    <section class="card"><h3>Animations</h3>${animationsCard()}</section>
    <section class="card"><h3>Backup</h3>
      <div class="row">
        <button class="btn" data-action="export">Export backup</button>
        <button class="btn" data-action="import">Import backup</button>
      </div>
      <p class="hint">Import adds everything from a backup file to what's already here.</p>
    </section>
    ${ONLINE ? `<section class="card"><h3>Share with a friend</h3>
      <p>Send a friend the link. VCS students log in with their Moodle key, students at Canvas or Schoology schools with their calendar link, and anyone else can log their own homework. Everyone only sees their own list.</p>
      <div class="row"><button class="btn" data-action="share">Share the link</button></div>
    </section>` : ''}
    <section class="card"><h3>About</h3>
      <p>Made by a student. The code is open on GitHub, and you can report a problem or ask for a feature there.</p>
      <div class="row">
        <a class="btn" href="${GITHUB}/issues/new" target="_blank" rel="noopener">Report a problem</a>
        <a class="btn" href="${GITHUB}" target="_blank" rel="noopener">See the code</a>
      </div>
    </section>
    ${ONLINE && me ? `<section class="card"><h3>Account</h3>
      <div class="row account-name">
        <p>Logged in as <b>${esc(me.name)}</b></p>
        <button class="btn" data-action="rename-open">${PENCIL} Change name</button>
      </div>
      <form class="row" data-form="rename" hidden>
        <input name="name" class="field" maxlength="40" value="${esc(me.name)}" autocomplete="given-name" aria-label="Your name" required>
        <button class="btn">Save</button>
        <button type="button" class="link-btn" data-action="rename-cancel">Cancel</button>
      </form>
      ${me.kind === 'moodle' ? `<p class="hint">This only changes your name here. ${me.nameSet && me.moodleName ? `Moodle calls you ${esc(me.moodleName)}. <button class="link-btn" data-action="rename-moodle">Use that instead</button>` : 'Moodle keeps your real name.'}</p>` : ''}
      <div class="row"><button class="primary" data-action="link-device">Log in on another device</button></div>
      <div id="link-code"></div>
      ${isOwn() && passkeysSupported() ? `<p class="hint">You have ${me.passkeys || 0} passkey${me.passkeys === 1 ? '' : 's'}. After logging in on a new device with a code, add a passkey there so you can log in on it directly.</p>
      <div class="row"><button class="btn" data-action="add-passkey">Add a passkey on this device</button></div>` : ''}
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
      ${c ? `<span class="chip"><span class="dot" style="background:${classColor(c)}"></span>${esc(c.name)}</span>` : ''}
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
      ${(t.source === 'canvas' || t.source === 'schoology') && t.url ? `<a class="link-btn" href="${esc(t.url)}" target="_blank" rel="noopener">Open on ${SOURCE_NAMES[t.source]}</a>` : ''}
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
  if (href) { link.href = href; link.textContent = t.link ? 'Open linked file' : SOURCE_NAMES[t.source] && t.source !== 'moodle' ? `Open in ${SOURCE_NAMES[t.source]}` : 'Open in Moodle'; }
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
  const opts = classDayOptions();
  $('#class-day-row').hidden = !opts.length || (!isOwn() && !c?.moodleId);
  f.day.innerHTML = `<option value="">${isOwn() ? 'Every day' : 'Not set'}</option>`
    + opts.map((o) => `<option value="${esc(o)}">${esc(isOwn() ? o : `${o} days`)}</option>`).join('');
  f.day.value = c?.day || '';
  const used = new Set(classes().map((x) => x.color));
  const color = c ? c.color : COLORS.find((x) => !used.has(x)) || COLORS[classes().length % COLORS.length];
  $('#color-swatches').innerHTML = `<label class="color-pick class-color"><input type="color" name="color" value="${esc(color)}"><span>Pick any color</span></label>`;
  $('#class-dialog').showModal();
}
$('#class-dialog').addEventListener('close', () => {
  const dlg = $('#class-dialog');
  if (dlg.returnValue === 'save') {
    const f = $('#class-form');
    const name = f.name.value.trim();
    const color = /^#[0-9a-f]{6}$/i.test(f.color?.value || '') ? f.color.value.toLowerCase() : COLORS[0];
    if (name) {
      if (editingClassId) {
        const c = classById(editingClassId);
        if (name !== c.name) c.renamed = true; // the sync won't touch names you chose
        touch(Object.assign(c, { name, color }));
        if (f.day.value && f.day.value !== c.day) setClassDay(c, f.day.value);
        else if (isOwn() && !f.day.value && c.day) touch(Object.assign(c, { day: '', everyDay: true }));
        commit();
      } else {
        const id = uid();
        const day = isOwn() ? f.day.value : '';
        state.classes.push(touch({ id, name, color, ...(isOwn() && classDayOptions().length ? { day, everyDay: !day } : {}) }));
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
    case 'cal-day': calSel = el.dataset.date; render(); break;
    case 'cal-today': calSel = calMonth = null; render(); break;
    case 'cal-move': {
      const [y, m] = calMonth.split('-').map(Number);
      const d = new Date(y, m - 1 + Number(el.dataset.step), 1);
      calMonth = dateStr(d).slice(0, 7);
      render();
      break;
    }
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
        const rect = el.getBoundingClientRect();
        $('#detail-dialog').close();
        commit();
        if (t.done) { toast('Marked done'); celebrate(t, rect); }
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
        toast(`Couldn't check ${srcName()}: ${err.message}`);
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
    case 'feed-off': {
      if (!confirm(`Disconnect ${feed?.label}? Homework it already added stays, but new assignments won't show up on their own. Your other devices will be logged out.`)) break;
      try { const name = feed?.label; await api('PUT', '/api/account', { feed: null }); feed = null; await pull(); toast(`${name} disconnected`); render(); }
      catch (err) { toast(err.message); }
      break;
    }
    case 'bd-mode':
      saveBackdrop({ mode: el.dataset.mode });
      if (el.dataset.mode === 'photo' && !safeGet('hw-backdrop-photo')) $('#bd-file')?.click();
      render(); break;
    case 'bd-swap': saveBackdrop({ stops: [...backdrop.stops].reverse() }); render(); break;
    case 'bd-stop-add': { // new color: a blend of the last two, so the gradient stays smooth until you change it
      const [a, z] = backdrop.stops.slice(-2).map(rgb);
      const mid = '#' + a.map((v, i) => Math.round((v + z[i]) / 2).toString(16).padStart(2, '0')).join('');
      saveBackdrop({ stops: [...backdrop.stops, mid].slice(0, MAX_STOPS) }); render(); break;
    }
    case 'bd-stop-remove':
      if (backdrop.stops.length > 2) saveBackdrop({ stops: backdrop.stops.filter((_, i) => i !== +el.dataset.i) });
      render(); break;
    case 'bd-upload': $('#bd-file')?.click(); break;
    case 'bd-photo-off': safeSet('hw-backdrop-photo', null); saveBackdrop({ mode: 'plain' }); render(); break;
    case 'text-reset': saveBackdrop({ [textKey()]: '' }); render(); break;
    case 'anim-try': {
      const rect = el.getBoundingClientRect();
      if (anim.one && !reducedMotion()) burst(rect, CONFETTI[4]);
      if (anim.day) setTimeout(() => celebrateDay(dateStr(new Date())), anim.one ? 700 : 0);
      if (!anim.one && !anim.day) toast('Both animations are off');
      break;
    }
    case 'tint-mode': saveBackdrop({ tintOn: el.dataset.on === '1' }); render(); break;
    case 'rename-open': {
      const f = document.querySelector('[data-form=rename]');
      f.hidden = false; el.closest('.account-name').hidden = true;
      f.name.focus(); f.name.select();
      break;
    }
    case 'rename-cancel': render(); break;
    case 'rename-moodle':
      try { const r = await api('PUT', '/api/account', { name: null }); me = { ...me, name: r.name, nameSet: false }; toast('Using your Moodle name'); render(); }
      catch (err) { toast(err.message); }
      break;
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
    case 'login-kind': loginKind = el.dataset.kind; loginMode = 'key'; safeSet('hw-login-kind', loginKind); render(); break;
    case 'passkey-login': {
      el.disabled = true;
      try { await passkeyFlow('login'); await boot(true); }
      catch (err) { $('#login-err').textContent = err.message; el.disabled = false; }
      break;
    }
    case 'add-passkey': {
      try { await passkeyFlow('add'); me.passkeys = (me.passkeys || 0) + 1; toast('Passkey added. You can log in with it on this device now.'); render(); }
      catch (err) { toast(err.message); }
      break;
    }
    case 'pick-school': {
      try {
        const id = el.dataset.school;
        const f = await (await fetch(`/schools/${id}.json`)).json();
        if (!f.pattern || (f.pattern.type === 'rotation' && !f.pattern.anchor)) {
          setupSchool = f;
          setupMode = f.pattern ? 'today' : 'manual';
          render();
          break;
        }
        await saveSchedule({ type: 'school', school: id, off: [] });
        toast(`Using ${schoolCal?.name || 'that school'}'s calendar`);
        location.hash = '#/';
      } catch (err) { toast(err.message); }
      break;
    }
    case 'pick-today': {
      const labels = setupSchool.pattern.labels;
      const i = Number(el.dataset.i);
      try {
        await saveSchedule({ type: 'school', school: setupSchool.id, off: [], pattern: { type: 'rotation', labels: [labels[i], labels[1 - i]], anchor: el.dataset.date } });
        toast(`Using ${setupSchool.name}'s calendar`);
        setupSchool = null; setupMode = null;
        location.hash = '#/';
      } catch (err) { toast(err.message); }
      break;
    }
    case 'setup-manual': setupMode = 'manual'; setupSchool = null; render(); break;
    case 'setup-back': setupMode = null; setupSchool = null; render(); break;
    case 'setup-skip': location.hash = '#/'; break;
    case 'preset-oddeven': {
      const f = el.closest('form');
      f.type.value = 'weekday';
      ['All', 'Odd', 'Even', 'Odd', 'Even'].forEach((v, i) => { f[`d${i + 1}`].value = v; });
      break;
    }
    case 'cal-mark-off': {
      const off = new Set(schedule.off || []);
      off.has(calSel) ? off.delete(calSel) : off.add(calSel);
      try { await saveSchedule({ ...schedule, off: [...off] }); render(); }
      catch (err) { toast(err.message); }
      break;
    }
    case 'fix-rotation': {
      const info = dayInfo(dateStr(new Date()));
      const rot = activePattern();
      const now = rot.labels.find((l) => l !== info.label);
      const fixed = { type: 'rotation', labels: [now, info.label], anchor: dateStr(new Date()) };
      try { await saveSchedule(schedule.type === 'school' ? { ...schedule, pattern: fixed } : { ...schedule, ...fixed }); toast(`Today is ${now} now`); render(); }
      catch (err) { toast(err.message); }
      break;
    }
    case 'set-day': {
      const c = classById(el.dataset.class);
      if (c) {
        if (el.dataset.day) setClassDay(c, el.dataset.day);
        else touch(Object.assign(c, { day: '', everyDay: true }));
        commit();
        toast(el.dataset.day ? `${c.name}: ${el.dataset.day}` : `${c.name}: every day`);
      }
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
      const text = 'I use this to keep track of homework. It sorts everything by due date, has a calendar, and can remind you at 6pm what\'s due tomorrow. It can pull homework straight from Moodle, Canvas or Schoology, or you can log your own.';
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

document.addEventListener('input', (e) => {
  // range 40–95 → panels 95%–40% solid
  if (e.target.id === 'bd-fade') { saveBackdrop({ fade: (135 - +e.target.value) / 100 }); return; }
  if (e.target.id === 'tint-strength') { saveBackdrop({ tintStrength: +e.target.value / 100 }); refreshClassColors(); return; }
  if (e.target.id === 'tint-color' && HEX.test(e.target.value)) { saveBackdrop({ tint: e.target.value.toLowerCase() }); refreshClassColors(); return; }
  // color pickers update live as you drag, without redrawing the page (that would close the picker)
  if (e.target.matches('.bd-stop-color') && HEX.test(e.target.value)) {
    const stops = [...backdrop.stops];
    stops[+e.target.dataset.i] = e.target.value.toLowerCase();
    saveBackdrop({ stops });
    return;
  }
  const colorKey = { 'bd-color': 'color', 'text-color': textKey() }[e.target.id];
  if (colorKey && HEX.test(e.target.value)) { saveBackdrop({ [colorKey]: e.target.value.toLowerCase() }); return; }
  if (!e.target.matches('.school-search')) return;
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.school-btn').forEach((b) => { b.hidden = !!q && !b.textContent.toLowerCase().includes(q); });
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'bd-dir') { saveBackdrop({ dir: e.target.value }); return; }
  if (e.target.id === 'text-color') { render(); return; } // show "Back to default" once you've picked one
  if (e.target.id === 'bd-file') {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await photoToDataUrl(file);
      localStorage.setItem('hw-backdrop-photo', data);
      saveBackdrop({ mode: 'photo' });
      render();
    } catch {
      toast("That photo couldn't be used. Try a smaller JPG or PNG.");
    }
    return;
  }
  const qa = e.target.closest('.quick-add');
  if (qa && e.target.name === 'classId' && !qa.due.dataset.touched) qa.due.value = nextMeeting(classById(e.target.value));
  if (qa && e.target.name === 'due') qa.due.dataset.touched = '1';
  if (e.target.dataset.action === 'toggle') {
    const t = state.tasks.find((x) => x.id === e.target.closest('[data-id]').dataset.id);
    const rect = e.target.getBoundingClientRect(); // before the redraw replaces the checkbox
    t.done = e.target.checked;
    t.doneAt = t.done ? Date.now() : null;
    t.doneBy = t.done ? 'you' : null;
    touch(t);
    commit();
    celebrate(t, rect);
  }
  if (e.target.dataset.anim) { anim = { ...anim, [e.target.dataset.anim]: e.target.checked }; safeSet('hw-anim', JSON.stringify(anim)); }
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
  if (f.dataset.form === 'rename') {
    e.preventDefault();
    try {
      const r = await api('PUT', '/api/account', { name: f.name.value });
      me = { ...me, name: r.name, nameSet: r.nameSet };
      toast('Name changed');
      render();
    } catch (err) { toast(err.message); }
    return;
  }
  if (f.dataset.form === 'login-feed') {
    e.preventDefault();
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    btn.textContent = `Checking with ${SOURCE_NAMES[f.dataset.kind]}…`;
    try {
      const r = await api('POST', '/api/login', { feed: f.feed.value, kind: f.dataset.kind });
      if (r.created) justSignedUp = true;
      await boot(true);
    } catch (err) {
      $('#login-err').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
    return;
  }
  if (f.dataset.form === 'signup') {
    e.preventDefault();
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    btn.textContent = 'Making your passkey…';
    try {
      await passkeyFlow('signup', { name: f.name.value });
      justSignedUp = true;
      await boot(true);
    } catch (err) {
      $('#login-err').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Create account';
    }
    return;
  }
  if (f.dataset.form === 'setup') {
    e.preventDefault();
    const type = f.type.value;
    let s;
    if (type === 'daily') s = { type };
    else if (type === 'weekday') {
      s = { type, days: {} };
      for (let d = 1; d <= 5; d++) s.days[d] = f[`d${d}`].value.trim();
    } else if (type === 'rotation') {
      const l = [f.l0.value.trim(), f.l1.value.trim()];
      if (!l[0] || !l[1] || l[0] === l[1]) return toast('Give the two days different names.');
      let anchor = dateStr(new Date());
      while (isWeekend(anchor)) anchor = addDaysStr(anchor, 1);
      s = { type, labels: f.now.value === '1' ? [l[1], l[0]] : l, anchor };
    } else return toast('Pick how your schedule works.');
    try {
      if (setupSchool) await saveSchedule({ type: 'school', school: setupSchool.id, off: [], pattern: s });
      else await saveSchedule({ ...s, off: schedule?.type === type ? schedule.off : [] });
      setupMode = null; setupSchool = null;
      toast('Schedule saved');
      location.hash = '#/';
    } catch (err) { toast(err.message); }
    return;
  }
  if (f.dataset.form === 'feed') {
    e.preventDefault();
    const btn = f.querySelector('button');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const r = await api('PUT', '/api/account', { feed: f.feed.value });
      feed = r.feed;
      await pull();
      toast(r.added ? `Connected. Found ${r.added} assignment${r.added === 1 ? '' : 's'}.` : `Connected to ${feed?.label}`);
      render();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = label;
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

let justSignedUp = false;
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
    schedule = s.schedule || null;
    moodle = me?.kind === 'moodle' ? { connected: true, name: me.moodleName || me.name } : { connected: false };
    feed = me?.feed || null;
  } catch {
    return; // offline — keep showing the cached copy
  }
  if (!authed) { forgetDevice(); return; }
  if (userChanged(me.id)) state = loadLocal();
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  await loadSchoolCal();
  if (isOwn() && !schedule && justSignedUp) { justSignedUp = false; location.hash = '#/setup'; }
  render();
  registerSW();
  await pull();
  syncIfStale();
}
boot();
