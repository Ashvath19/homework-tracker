// Reads homework from a school calendar link: Canvas ("Calendar Feed") or Schoology (calendar
// "Export"/share link). A calendar link only shows your calendar, so it can't see grades or
// messages, or turn anything in. The downside: it can't tell when you've turned something in,
// so students check things off themselves.
import crypto from 'node:crypto';
import { COLORS, redis, K, getProfile, saveProfile, fingerprint, encrypt } from './_lib.js';
import { guessTag, cleanCourseName, dueFromTimestamp } from './_moodle.js';

// Only real Canvas / Schoology addresses, so the server never fetches an address someone made up.
export const FEEDS = {
  canvas: {
    name: 'Canvas',
    url: /^https:\/\/([a-z0-9-]{2,63}\.instructure\.com)\/feeds\/calendars\/user_[A-Za-z0-9]{20,80}\.ics$/,
    // Canvas feeds hold the whole year. Bring in work due from yesterday on, so connecting
    // doesn't fill the list with old homework that was already turned in.
    backDays: 1,
  },
  schoology: {
    name: 'Schoology',
    url: /^https:\/\/((?:[a-z0-9-]{2,63}\.)?schoology\.com)\/calendar\/feed\/ical\/\d{1,20}\/[A-Za-z0-9]{10,80}\/ical\.ics$/,
    // Schoology's own "overdue" list is unreliable, which is the point of using this, so also
    // bring in the last 2 weeks: anything still not done shows up as overdue until you check it off.
    backDays: 14,
  },
};
export const feedKinds = Object.keys(FEEDS);
const feedLabel = (kind) => FEEDS[kind]?.name || 'calendar';
// What the app shows about a connected link (never the link itself).
export function feedInfo(p) {
  const kind = feedKinds.find((k) => p?.[k]);
  return kind ? { kind, label: feedLabel(kind), host: p[kind].host, name: p[kind].name || '' } : null;
}

export function cleanFeedUrl(kind, raw) {
  const url = String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://').replace(/^http:\/\//i, 'https://');
  const m = FEEDS[kind]?.url.exec(url);
  return m ? { url, host: m[1] } : null;
}
// Which kind of link is this? (so pasting a Schoology link in the Canvas box still works)
export const feedKindOf = (raw) => feedKinds.find((k) => cleanFeedUrl(k, raw)) || null;

// Checks a calendar link, then either logs into the account that owns it (uid = null) or
// connects it to the account you're logged in to. The link is secret to each student, so it
// works like a password, the same way a Moodle key does.
export async function connectFeed(kind, raw, uid = null) {
  const label = feedLabel(kind);
  const feed = cleanFeedUrl(kind, raw);
  if (!feed) {
    return { error: kind === 'schoology'
      ? "That isn't a Schoology calendar link. It should look like https://yourschool.schoology.com/calendar/feed/ical/…/ical.ics."
      : "That isn't a Canvas calendar feed link. It should start with https:// and end in .ics." };
  }
  let cal;
  try { cal = await fetchFeed(kind, feed.url); } catch {
    return { error: `${label} didn't accept that link. Copy it again from ${label}.` };
  }
  if (kind === 'schoology') logShape(cal); // see logShape: no names, titles or links, just the layout

  const fp = fingerprint(feed.url);
  const ownerId = await redis.get(K.feed(kind, fp));
  const ownerP = ownerId ? await getProfile(ownerId) : null;
  const owner = ownerP?.[kind]?.fp === fp ? ownerId : null;
  const data = { feedEnc: encrypt(feed.url), fp, host: feed.host, name: cal.name || '', connectedAt: Date.now() };

  if (uid) {
    if (owner && owner !== uid) return { error: `That ${label} link is already connected to a different account here.` };
    const p = await getProfile(uid);
    if (p.moodle) return { error: 'Your homework already comes from Moodle.' };
    const other = feedKinds.find((k) => k !== kind && p[k]);
    if (other) return { error: `Disconnect ${feedLabel(other)} first. An account can use one of them at a time.` };
    if (p[kind]?.fp && p[kind].fp !== fp) await redis.del(K.feed(kind, p[kind].fp));
    p[kind] = data;
    await saveProfile(uid, p);
    await redis.set(K.feed(kind, fp), uid);
    return { uid, profile: p };
  }
  if (owner) {
    ownerP[kind] = { ...ownerP[kind], name: cal.name || ownerP[kind].name };
    await saveProfile(owner, ownerP);
    return { uid: owner, profile: ownerP, created: false };
  }
  const newUid = `${kind === 'canvas' ? 'c' : 's'}${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
  const profile = {
    name: cal.name || `${label} student`, kind: 'own', createdAt: Date.now(),
    own: { fp: crypto.randomBytes(10).toString('hex') }, [kind]: data, passkeys: [],
  };
  await saveProfile(newUid, profile);
  await redis.set(K.feed(kind, fp), newUid);
  await redis.sadd(K.users, newUid);
  return { uid: newUid, profile, created: true };
}

export async function fetchFeed(kind, url) {
  const label = feedLabel(kind);
  if (!cleanFeedUrl(kind, url)) throw new Error('bad feed link');
  let r;
  // Follow at most 2 redirects, and only to another real link of the same kind.
  for (let hop = 0; ; hop++) {
    r = await fetch(url, { redirect: 'manual', headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(20000) });
    const next = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!next) break;
    const to = new URL(next, url).href;
    if (hop >= 2 || !cleanFeedUrl(kind, to)) throw new Error(`${label} feed link stopped working`);
    url = to;
  }
  if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) throw new Error(`${label} feed link stopped working`);
  if (!r.ok) throw new Error(`${label} answered ${r.status}`);
  const text = await r.text();
  if (text.length > 8_000_000) throw new Error(`${label} feed is too big`);
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error(`${label} feed link stopped working`);
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
  name = name.replace(/\s*Calendar\s*\((Canvas|Schoology)\)\s*$/i, '').replace(/\s*\((Canvas|Schoology)\)\s*$/i, '')
    .replace(/^Schoology\s*(Calendar)?\s*[-–:]?\s*/i, '').replace(/\s*(Schoology\s*)?Calendar$/i, '').trim();
  return { name, events };
}

const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// "20261201T075900Z" (UTC) → that moment in school time; "20261201T235900" (school's local
// time) → that day; "20261201" (all day) → that date. 12:00 AM counts as the day before.
function readWhen(f) {
  const v = f?.value || '';
  let m = /^(\d{4})(\d\d)(\d\d)$/.exec(v);
  if (m || /VALUE=DATE(?!-)/.test(f?.params || '')) {
    m = m || /^(\d{4})(\d\d)(\d\d)/.exec(v);
    return m && { due: `${m[1]}-${m[2]}-${m[3]}`, sec: Date.UTC(+m[1], +m[2] - 1, +m[3], 20) / 1000 };
  }
  m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/.exec(v);
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  if (m[7] === 'Z') return { due: dueFromTimestamp(utc), sec: utc };
  const midnight = m[4] === '00' && m[5] === '00';
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - (midnight ? 1 : 0))).toISOString().slice(0, 10);
  return { due: day, sec: utc + 8 * 3600 }; // local time; within an hour of the real moment
}

const shortHash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// Canvas: "Essay draft [English 10]", UID event-assignment-123, URL with course_456.
function readCanvas(ev) {
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

// Schoology: we haven't seen a real feed yet, so this reads every place the class name and
// link could plausibly be, and falls back to one "Schoology" class you can sort by hand.
const HOMEWORKISH = /\b(due|hw|homework|assignment|quiz|test|exam|midterm|final|project|essay|lab|read|reading|worksheet|packet|problems?|questions|write|draft|submit|turn in|study|review|presentation|notes)\b/i;
function readSchoology(ev) {
  const when = readWhen(ev.DTSTART) || readWhen(ev.DTEND);
  if (!when) return null;
  const summary = unescape(ev.SUMMARY?.value || '').trim() || 'Untitled';
  const desc = unescape(ev.DESCRIPTION?.value || '').trim();
  const linkIn = (s) => /https:\/\/(?:[a-z0-9-]+\.)?schoology\.com\/[^\s"<>]+/i.exec(s)?.[0] || '';
  const url = (/^https:\/\//i.test(ev.URL?.value || '') ? ev.URL.value.trim() : '') || linkIn(desc);
  const okUrl = /^https:\/\/(?:[a-z0-9-]+\.)?schoology\.com\//i.test(url) ? url : '';
  const kindM = /\/(assignment|assessment|discussion|event|page|document)s?\/(\d+)/i.exec(okUrl)
    || /\/course\/\d+\/materials\/(discussion|gp)\/view\/(\d+)/i.exec(okUrl);
  const kind = (kindM?.[1] || '').toLowerCase();
  const uidRaw = ev.UID?.value || '';
  const uidKind = /(assignment|assessment|discussion|event)/i.exec(uidRaw)?.[1]?.toLowerCase();
  const type = kind || uidKind || 'event';
  // Plain calendar events (rallies, "no school") aren't homework, unless they sound like it.
  if ((type === 'event' || type === 'page' || type === 'document') && !HOMEWORKISH.test(summary)) return null;

  // Class name: "Title [Class]", "Class: Title", CATEGORIES or LOCATION.
  let title = summary, courseName = '';
  const br = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(summary);
  if (br) { title = br[1]; courseName = br[2]; }
  courseName ||= unescape(ev.CATEGORIES?.value || '').split(',')[0].trim()
    || unescape(ev.LOCATION?.value || '').trim()
    || /^(?:Course|Class|Section)\s*:\s*(.+)$/im.exec(desc)?.[1]?.trim() || '';
  const courseNum = /\/(?:course|section)s?\/(\d+)/i.exec(okUrl)?.[1];
  const id = kindM?.[2] ? `${type}-${kindM[2]}` : `u-${shortHash(uidRaw || `${summary}|${when.due}`)}`;
  return {
    id,
    title: title.trim() || 'Untitled',
    courseName: courseName.slice(0, 80) || 'Schoology',
    courseId: courseNum || (courseName ? `n-${courseName.toLowerCase().slice(0, 80)}` : 'none'),
    due: when.due, dueAt: when.sec,
    url: okUrl,
    desc: desc.replace(/https:\/\/\S+/g, '').trim().slice(0, 4000),
    tagHint: type === 'assessment' ? 'quiz' : null,
  };
}

// Logs only the *shape* of a Schoology feed (which fields appear, link patterns with numbers
// blanked out), so the class-sorting above can be fixed once a real feed connects. Never logs
// names, titles, descriptions or the link itself.
function logShape(cal) {
  const fields = {}, paths = {}, uids = {};
  let brackets = 0, colons = 0;
  for (const ev of cal.events.slice(0, 300)) {
    for (const k of Object.keys(ev)) fields[k] = (fields[k] || 0) + 1;
    const u = /^https?:\/\/[^/]+(\/[^?#\s]*)/.exec(ev.URL?.value || '')?.[1];
    if (u) { const p = u.replace(/\d+/g, 'N'); paths[p] = (paths[p] || 0) + 1; }
    const uid = (ev.UID?.value || '').replace(/[0-9a-f]{6,}/gi, 'X').replace(/\d+/g, 'N').slice(0, 40);
    uids[uid] = (uids[uid] || 0) + 1;
    const s = ev.SUMMARY?.value || '';
    if (/\[[^\]]+\]\s*$/.test(s)) brackets++;
    if (/^[^:]{2,60}:\s/.test(s)) colons++;
  }
  console.log('schoology feed shape', JSON.stringify({ events: cal.events.length, hasName: !!cal.name, fields, paths, uids, brackets, colons }));
}

const READERS = { canvas: readCanvas, schoology: readSchoology };

// Compares the feed with our saved state and returns only the items that changed.
export function diffWithFeed(kind, state, feed, todayYmd) {
  const now = Date.now();
  const items = new Map();
  for (const ev of feed.events) {
    const a = READERS[kind](ev);
    if (a) items.set(a.id, a); // repeats of the same assignment: keep the last one
  }

  const idKey = `${kind}Id`, titleKey = `${kind}Title`;
  const classes = new Map(state.classes.filter((c) => c[idKey]).map((c) => [c[idKey], c]));
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const usedColors = new Set(state.classes.filter((c) => !c.deleted).map((c) => c.color));
  const changedClasses = [], changedTasks = [], newTasks = [];
  const seen = new Set();
  const from = addDaysYmd(todayYmd, -FEEDS[kind].backDays);
  let upcoming = 0;

  for (const a of items.values()) {
    const id = `${kind}-${a.id}`;
    seen.add(id);
    const existing = tasks.get(id);
    if (!existing && a.due < from) continue;
    if (a.due >= todayYmd) upcoming++;

    let cls = classes.get(a.courseId);
    if (cls?.deleted) continue; // you deleted this class — leave it alone
    if (!cls) {
      const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[classes.size % COLORS.length];
      usedColors.add(color);
      cls = { id: `${kind}-c${shortHash(String(a.courseId))}`, [idKey]: a.courseId, name: cleanCourseName(a.courseName), color, everyDay: true, updatedAt: now };
      if (kind === 'canvas') cls.id = `canvas-c${a.courseId}`; // keep ids from before Schoology existed
      classes.set(a.courseId, cls);
      changedClasses.push(cls);
    }

    if (!existing) {
      const t = {
        id, source: kind, classId: cls.id, title: a.title, [titleKey]: a.title, tag: a.tagHint || guessTag(null, a.title),
        due: a.due, dueAt: a.dueAt, url: a.url, desc: a.desc, files: [], notes: '', done: false, doneAt: null, updatedAt: now,
      };
      changedTasks.push(t);
      newTasks.push(t);
    } else if (!existing.deleted) {
      const reopened = existing.done && existing.doneBy === kind; // it came back
      const renamedByYou = existing.title !== existing[titleKey];
      if (existing.due !== a.due || existing[titleKey] !== a.title || existing.url !== a.url || existing.desc !== a.desc || reopened) {
        changedTasks.push({
          ...existing, due: a.due, dueAt: a.dueAt, url: a.url, desc: a.desc, [titleKey]: a.title,
          title: renamedByYou ? existing.title : a.title,
          ...(reopened ? { done: false, doneAt: null, doneBy: null } : {}),
          updatedAt: now,
        });
      }
    }
  }

  // An upcoming assignment that vanished from the feed was deleted or hidden by the teacher.
  for (const t of state.tasks) {
    if (t.source === kind && !t.deleted && !t.done && !seen.has(t.id) && t.due >= todayYmd) {
      changedTasks.push({ ...t, done: true, doneAt: now, doneBy: kind, updatedAt: now });
    }
  }
  return { changedClasses, changedTasks, newTasks, eventCount: upcoming };
}

function addDaysYmd(d, n) {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
