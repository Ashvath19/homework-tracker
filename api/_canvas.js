// Reads homework from a Canvas calendar feed (Canvas → Calendar → "Calendar Feed").
// The feed link only shows your calendar, so it can't see grades, messages or submit anything,
// unlike a full Canvas access key. The downside: it can't tell when you've turned something in.
import { COLORS } from './_lib.js';
import { guessTag, cleanCourseName, dueFromTimestamp } from './_moodle.js';

// Only real Canvas sites, so the server never fetches an address someone made up.
const FEED = /^https:\/\/([a-z0-9-]{2,63})\.instructure\.com\/feeds\/calendars\/user_([A-Za-z0-9]{20,80})\.ics$/;

export function cleanFeedUrl(raw) {
  const url = String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://').replace(/^http:\/\//i, 'https://');
  const m = FEED.exec(url);
  return m ? { url, host: `${m[1]}.instructure.com` } : null;
}

export async function fetchFeed(url) {
  if (!cleanFeedUrl(url)) throw new Error('bad feed link');
  const r = await fetch(url, { redirect: 'error', headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(20000) });
  if (r.status === 400 || r.status === 401 || r.status === 404) throw new Error('Canvas feed link stopped working');
  if (!r.ok) throw new Error(`Canvas answered ${r.status}`);
  const text = await r.text();
  if (text.length > 8_000_000) throw new Error('Canvas feed is too big');
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Canvas feed link stopped working');
  return parseIcs(text);
}

// Minimal iCalendar reader: unfolds long lines and collects each event's fields.
export function parseIcs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let name = '', ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') { if (ev) events.push(ev); ev = null; continue; }
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [key, ...params] = line.slice(0, i).split(';');
    const value = line.slice(i + 1);
    if (!ev) { if (key === 'X-WR-CALNAME') name = unescape(value); continue; }
    ev[key] = { value, params: params.join(';') };
  }
  return { name: name.replace(/\s*Calendar\s*\(Canvas\)\s*$/i, '').replace(/\s*\(Canvas\)\s*$/i, '').trim(), events };
}

const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// "20261201T075900Z" → seconds; "20261201" (all day) → that date.
function readWhen(f) {
  const v = f?.value || '';
  let m = /^(\d{4})(\d\d)(\d\d)$/.exec(v);
  if (m || /VALUE=DATE(?!-)/.test(f?.params || '')) {
    m = m || /^(\d{4})(\d\d)(\d\d)/.exec(v);
    return m && { due: `${m[1]}-${m[2]}-${m[3]}`, sec: Date.UTC(+m[1], +m[2] - 1, +m[3], 20) / 1000 };
  }
  m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/.exec(v);
  if (!m) return null;
  // Canvas always sends UTC times ("Z"). Without the Z, treat it as UTC too; it's off by hours at most.
  const sec = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  return { due: dueFromTimestamp(sec), sec };
}

// One assignment per event: "Essay draft [English 10]" with a link to the course.
export function readAssignment(ev) {
  const uid = ev.UID?.value || '';
  const m = /^event-assignment-(?:override-)?(\d+)$/.exec(uid);
  if (!m) return null; // regular calendar events (assemblies, office hours…) aren't homework
  const when = readWhen(ev.DTSTART) || readWhen(ev.DTEND);
  if (!when) return null;
  const summary = unescape(ev.SUMMARY?.value || 'Untitled');
  const sm = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(summary);
  const url = (ev.URL?.value || '').trim();
  const course = /include_contexts=course_(\d+)/.exec(url)?.[1] || null;
  const assignment = /#assignment_(\d+)/.exec(url)?.[1] || m[1];
  const host = /^https:\/\/([a-z0-9-]+\.instructure\.com)\//.exec(url)?.[1];
  return {
    id: assignment,
    title: (sm ? sm[1] : summary).trim() || 'Untitled',
    courseName: sm ? sm[2].trim() : 'Canvas',
    courseId: course || (sm ? `n-${sm[2].trim().toLowerCase()}` : 'none'),
    due: when.due, dueAt: when.sec,
    url: host && course ? `https://${host}/courses/${course}/assignments/${assignment}` : (host ? url : ''),
    desc: unescape(ev.DESCRIPTION?.value || '').trim().slice(0, 4000),
  };
}

// Compares the feed with our saved state and returns only the items that changed.
export function diffWithCanvas(state, feed, todayYmd) {
  const now = Date.now();
  const items = new Map();
  for (const ev of feed.events) {
    const a = readAssignment(ev);
    if (a) items.set(a.id, a); // overrides for the same assignment: keep the last one
  }

  const classes = new Map(state.classes.filter((c) => c.canvasId).map((c) => [c.canvasId, c]));
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const usedColors = new Set(state.classes.filter((c) => !c.deleted).map((c) => c.color));
  const changedClasses = [], changedTasks = [], newTasks = [];
  const seen = new Set();
  // The feed has the whole year, including old work. Only bring in things due from yesterday on,
  // so the first connect doesn't fill the list with old "overdue" homework.
  const from = addDaysYmd(todayYmd, -1);
  let upcoming = 0;

  for (const a of items.values()) {
    const id = `canvas-${a.id}`;
    seen.add(id);
    const existing = tasks.get(id);
    if (!existing && a.due < from) continue;
    if (a.due >= todayYmd) upcoming++;

    let cls = classes.get(a.courseId);
    if (cls?.deleted) continue; // you deleted this class — leave it alone
    if (!cls) {
      const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[classes.size % COLORS.length];
      usedColors.add(color);
      cls = { id: `canvas-c${a.courseId}`, canvasId: a.courseId, name: cleanCourseName(a.courseName), color, everyDay: true, updatedAt: now };
      classes.set(a.courseId, cls);
      changedClasses.push(cls);
    }

    if (!existing) {
      const t = {
        id, source: 'canvas', classId: cls.id, title: a.title, canvasTitle: a.title, tag: guessTag(null, a.title),
        due: a.due, dueAt: a.dueAt, url: a.url, desc: a.desc, files: [], notes: '', done: false, doneAt: null, updatedAt: now,
      };
      changedTasks.push(t);
      newTasks.push(t);
    } else if (!existing.deleted) {
      const reopened = existing.done && existing.doneBy === 'canvas'; // it came back
      const renamedByYou = existing.title !== existing.canvasTitle;
      if (existing.due !== a.due || existing.canvasTitle !== a.title || existing.url !== a.url || existing.desc !== a.desc || reopened) {
        changedTasks.push({
          ...existing, due: a.due, dueAt: a.dueAt, url: a.url, desc: a.desc, canvasTitle: a.title,
          title: renamedByYou ? existing.title : a.title,
          ...(reopened ? { done: false, doneAt: null, doneBy: null } : {}),
          updatedAt: now,
        });
      }
    }
  }

  // An upcoming assignment that vanished from the feed was deleted or hidden by the teacher.
  for (const t of state.tasks) {
    if (t.source === 'canvas' && !t.deleted && !t.done && !seen.has(t.id) && t.due >= todayYmd) {
      changedTasks.push({ ...t, done: true, doneAt: now, doneBy: 'canvas', updatedAt: now });
    }
  }
  return { changedClasses, changedTasks, newTasks, eventCount: upcoming };
}

function addDaysYmd(d, n) {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
