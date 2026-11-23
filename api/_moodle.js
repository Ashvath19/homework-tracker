// Reads upcoming work from Moodle using the same web service the Moodle mobile app uses.
import { COLORS, ymd, TZ } from './_lib.js';
import { activityDetails, cmidFromUrl } from './_details.js';

export const MOODLE_BASE = (process.env.MOODLE_URL || 'https://learn.vcs.net').replace(/\/$/, '');

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else if (v !== undefined) out.append(key, String(v));
  }
  return out;
}

export async function ws(token, fn, params = {}) {
  const body = flatten(params, '', new URLSearchParams({
    wstoken: token, wsfunction: fn, moodlewsrestformat: 'json',
  }));
  const r = await fetch(`${MOODLE_BASE}/webservice/rest/server.php`, { method: 'POST', body });
  const j = await r.json();
  if (j && j.exception) throw new Error(`${fn}: ${j.message}`);
  return j;
}

// Everything on the Moodle "Timeline": things you still need to do, from 2 weeks ago onward.
export async function fetchTimeline(token, fromSec) {
  const events = [];
  let after;
  for (let page = 0; page < 6; page++) {
    const res = await ws(token, 'core_calendar_get_action_events_by_timesort', {
      timesortfrom: fromSec, limitnum: 50, ...(after ? { aftereventid: after } : {}),
    });
    events.push(...(res.events || []));
    if (!res.events || res.events.length < 50) break;
    after = res.lastid;
  }
  return events;
}

export function guessTag(modname, title) {
  const t = title.toLowerCase();
  if (/\b(test|exam|midterm|final)s?\b/.test(t)) return 'test';
  if (modname === 'quiz' || /\bquiz/.test(t)) return 'quiz';
  if (/\blab\b/.test(t)) return 'lab';
  if (/\b(essay|paper|draft|dbq|frq|writing)\b/.test(t)) return 'essay';
  if (/\bproject\b/.test(t)) return 'project';
  if (/\b(read|reading|chapter|ch\.)\b/.test(t)) return 'reading';
  return 'homework';
}

export function cleanCourseName(name) {
  return name
    .replace(/&amp;/g, '&')
    .replace(/\s+[-–]\s+(mr|mrs|ms|miss|dr|mx|coach|sr|sra|srta|prof)\.?\s.*$/i, '') // "Biology Honors - Dr. Noren"
    .replace(/\s*[([]?\b(20)?\d\d\s*[-–/]\s*(20)?\d\d\b[)\]]?\s*/g, ' ') // "2026-2027", "26-27"
    .replace(/\s{2,}/g, ' ')
    .trim() || name;
}

// Classes made before we stripped teacher names ("Biology Honors - Dr. Noren") get tidied,
// unless you renamed them yourself.
export function tidyName(cls, fullname) {
  const clean = cleanCourseName(fullname);
  if (cls.renamed || cls.name === clean) return null;
  const raw = fullname.replace(/&amp;/g, '&');
  return cls.name === raw || cls.name.startsWith(`${clean} - `) || cls.name.startsWith(`${clean} – `) ? clean : null;
}

// Moodle often uses 12:00 AM to mean "end of the previous day".
export function dueFromTimestamp(sec) {
  const d = new Date(sec * 1000);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return ymd(hm === '00:00' ? new Date(d.getTime() - 60000) : d);
}

// Compares Moodle's timeline with our saved state and returns only the items that changed.
export async function diffWithMoodle(state, token) {
  const now = Date.now();
  const fromSec = Math.floor(now / 1000) - 14 * 86400;
  const events = await fetchTimeline(token, fromSec);

  const classes = new Map(state.classes.filter((c) => c.moodleId).map((c) => [c.moodleId, c]));
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const usedColors = new Set(state.classes.filter((c) => !c.deleted).map((c) => c.color));
  const changedClasses = [], changedTasks = [], newTasks = [];
  const seen = new Set();

  // descriptions + attached files for the assignments/quizzes on the timeline
  const courseIds = [...new Set(events.filter((e) => e.course?.id).map((e) => e.course.id))];
  const details = await activityDetails(ws, token, courseIds).catch(() => new Map());

  for (const ev of events) {
    if (!ev.course?.id || !ev.instance || !ev.modulename) continue;
    const id = `moodle-${ev.modulename}-${ev.instance}`;
    if (seen.has(id)) continue;
    seen.add(id);

    let cls = classes.get(ev.course.id);
    if (cls?.deleted) continue; // you deleted this class — leave it alone
    const tidy = cls && tidyName(cls, ev.course.fullname);
    if (tidy) { cls = { ...cls, name: tidy, updatedAt: now }; classes.set(ev.course.id, cls); changedClasses.push(cls); }
    if (!cls) {
      const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[classes.size % COLORS.length];
      usedColors.add(color);
      cls = { id: `moodle-c${ev.course.id}`, moodleId: ev.course.id, name: cleanCourseName(ev.course.fullname), color, updatedAt: now };
      classes.set(ev.course.id, cls);
      changedClasses.push(cls);
    }

    const title = (ev.activityname || ev.name || 'Untitled').replace(/\s+(is due|closes|is due to be graded)$/i, '').trim();
    const due = dueFromTimestamp(ev.timesort);
    const url = ev.url || ev.action?.url || '';
    const existing = tasks.get(id);
    const d = details.get(`cm-${cmidFromUrl(url)}`) || details.get(`${ev.modulename}-${ev.instance}`) || details.get(`cm-${ev.instance}`);
    const info = { desc: d?.desc || '', files: d?.files || [], cmid: d?.cmid || cmidFromUrl(url) };

    if (!existing) {
      const t = {
        id, source: 'moodle', classId: cls.id, title, moodleTitle: title, tag: guessTag(ev.modulename, title),
        due, dueAt: ev.timesort, url, ...info, notes: '', done: false, doneAt: null, updatedAt: now,
      };
      changedTasks.push(t);
      newTasks.push(t);
    } else if (!existing.deleted) {
      const reopened = existing.done && existing.doneBy === 'moodle'; // it came back, so it isn't finished
      const renamedByYou = existing.title !== existing.moodleTitle;
      const infoChanged = d && (existing.desc !== info.desc || JSON.stringify(existing.files || []) !== JSON.stringify(info.files));
      if (existing.due !== due || existing.moodleTitle !== title || existing.url !== url || reopened || infoChanged || !existing.cmid) {
        changedTasks.push({
          ...existing, due, dueAt: ev.timesort, url, moodleTitle: title, ...(d ? info : { cmid: info.cmid }),
          title: renamedByYou ? existing.title : title,
          ...(reopened ? { done: false, doneAt: null, doneBy: null } : {}),
          updatedAt: now,
        });
      }
    }
  }

  // Moodle drops things from the timeline once you submit them — check them off for you.
  for (const t of state.tasks) {
    if (t.source === 'moodle' && !t.deleted && !t.done && !seen.has(t.id) && (t.dueAt || 0) >= fromSec) {
      changedTasks.push({ ...t, done: true, doneAt: now, doneBy: 'moodle', updatedAt: now });
    }
  }

  return { changedClasses, changedTasks, newTasks, eventCount: events.length };
}
