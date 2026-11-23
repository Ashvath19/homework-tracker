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
    // The personal calendar link and each class calendar's export link (formats differ a little).
    url: /^https:\/\/((?:[a-z0-9-]{2,63}\.)?schoology\.com)\/(?=[^?#]*(?:ical|calendar))[A-Za-z0-9_\/.%-]{5,250}\.ics$/,
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
  return kind ? {
    kind, label: feedLabel(kind), host: p[kind].host, name: p[kind].name || '',
    ...(kind === 'schoology' ? {
      classes: (p.schoologyClasses || []).map(({ key, name }) => ({ key, name })),
      synced: p.schoologyMap ? { at: p.schoologyMap.at, classes: p.schoologyMap.courses.length, ids: p.schoologyMap.courses.reduce((n, c) => n + c.ids.length, 0) } : null,
    } : {}),
  } : null;
}

export function cleanFeedUrl(kind, raw) {
  const url = String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://').replace(/^http:\/\//i, 'https://');
  const m = !url.includes('..') && FEEDS[kind]?.url.exec(url);
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

// Schoology: calendars differ in where (and whether) they say which class something is for.
// Instead of guessing one spot, look at the whole calendar and pick the field that splits the
// homework into a sensible handful of groups, like real classes would.
const HOMEWORKISH = /\b(due|hw|homework|assignment|quiz|test|exam|midterm|final|project|essay|lab|read|reading|worksheet|packet|problems?|questions|write|draft|submit|turn in|study|review|presentation|notes)\b/i;
const sgyLink = (ev) => {
  const desc = unescape(ev.DESCRIPTION?.value || '');
  const url = (/^https:\/\//i.test(ev.URL?.value || '') ? ev.URL.value.trim() : '')
    || /https:\/\/(?:[a-z0-9-]+\.)?schoology\.com\/[^\s"<>]+/i.exec(desc)?.[0] || '';
  return /^https:\/\/(?:[a-z0-9-]+\.)?schoology\.com\//i.test(url) ? url : '';
};
// "… - Word: value" at the very end of a description. The value is often a link.
const TAG_RE = /[-–]\s*([A-Za-z]{2,12})\s*:\s*(\S[^\n]{0,300}?)\s*$/;
const descTag = (ev) => TAG_RE.exec(unescape(ev.DESCRIPTION?.value || '').trim());
// Schoology links anywhere in the description (not just the entry's own link).
const descLinks = (ev) => unescape(ev.DESCRIPTION?.value || '').match(/https:\/\/(?:[a-z0-9-]+\.)?schoology\.com\/[^\s"<>)]+/gi) || [];
const clip = (s) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length >= 2 && s.length <= 80 ? s : ''; };
// Every place a class name could be. Each returns { name, title? } (title = the summary without the class part).
const CLASS_SPOTS = {
  bracket: (ev, sum) => { const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(sum); return m && clip(m[2]) ? { name: clip(m[2]), title: m[1] } : null; },
  categories: (ev) => { const v = clip(unescape(ev.CATEGORIES?.value || '').split(',')[0]); return v ? { name: v } : null; },
  location: (ev) => { const v = clip(unescape(ev.LOCATION?.value || '')); return v ? { name: v } : null; },
  courseLink: (ev) => { const n = /\/(?:course|section)s?\/(\d+)/i.exec(sgyLink(ev))?.[1]; return n ? { name: `Class ${n}`, id: n } : null; },
  organizer: (ev) => { const v = clip(unescape(/CN="?([^";:]+)/i.exec(ev.ORGANIZER?.params || '')?.[1] || '')); return v ? { name: v } : null; },
  prefix: (ev, sum) => { const m = /^([^:]{2,60}):\s+(.+)$/.exec(sum); return m ? { name: clip(m[1]), title: m[2] } : null; },
  dashSuffix: (ev, sum) => { const m = /^(.+?)\s+[-–]\s+([^-–]{2,60})$/.exec(sum); return m ? { name: clip(m[2]), title: m[1] } : null; },
  parenSuffix: (ev, sum) => { const m = /^(.+?)\s*\(([^()]{2,60})\)\s*$/.exec(sum); return m ? { name: clip(m[2]), title: m[1] } : null; },
  descFirstLine: (ev) => { const v = clip(unescape(ev.DESCRIPTION?.value || '').split('\n')[0]); return v && !/^https?:/i.test(v) ? { name: v } : null; },
  // "… - Word: CODE" at the very end of the description (a teacher or class tag some schools add)
  descTag: (ev) => { const m = descTag(ev); return m && !/^https?:/i.test(m[2]) && clip(m[2]) && m[2].length <= 30 ? { name: clip(m[2]) } : null; },
  // a course or section number in any Schoology link inside the description (like the "- Link: …" tag)
  descCourseLink: (ev) => { for (const l of descLinks(ev)) { const n = /\/(?:course|section)s?\/(\d+)/i.exec(l)?.[1]; if (n) return { name: `Class ${n}`, id: n }; } return null; },
  descLabel: (ev) => { const v = clip(/^\s*(?:Course|Class|Section)\s*[:\-]\s*(.+)$/im.exec(unescape(ev.DESCRIPTION?.value || ''))?.[1]); return v ? { name: v } : null; },
  descLastLine: (ev) => { const v = clip(unescape(ev.DESCRIPTION?.value || '').trim().split('\n').pop()); return v && !/^https?:/i.test(v) ? { name: v } : null; },
};
// Numbers in each entry's ID and link (Schoology may include a section number). The class has
// no name there, so these become "Schoology class 1, 2, …", which students can rename once.
const numbersIn = (s) => (String(s || '').match(/\d{3,}/g) || []);
function numberSpots(items) {
  const out = {};
  for (const [src, get] of [['uid', (ev) => ev.UID?.value], ['link', (ev) => sgyLink(ev).replace(/^https:\/\/[^/]+/, '')],
    ['descLink', (ev) => descLinks(ev).filter((l) => l !== sgyLink(ev)).map((l) => l.replace(/^https:\/\/[^/]+/, '')).join(' ')]]) {
    for (let k = 0; k < 4; k++) {
      const vals = items.map((h) => numbersIn(get(h.ev))[k]).filter(Boolean);
      const order = [...new Set(vals)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      out[`${src}Number${k + 1}`] = (ev) => {
        const n = numbersIn(get(ev))[k];
        return n ? { name: `Schoology class ${order.indexOf(n) + 1 || order.length + 1}`, id: `${src}${k}-${n}` } : null;
      };
    }
  }
  return out;
}
const xSpots = (events) => [...new Set(events.flatMap((e) => Object.keys(e).filter((k) => k.startsWith('X-'))))]
  .reduce((o, k) => ({ ...o, [k]: (ev) => { const v = clip(unescape(ev[k]?.value || '')); return v ? { name: v } : null; } }), {});

function schoologyHomework(ev) {
  const when = readWhen(ev.DTSTART) || readWhen(ev.DTEND);
  if (!when) return null;
  const summary = unescape(ev.SUMMARY?.value || '').trim() || 'Untitled';
  const okUrl = sgyLink(ev);
  const kindM = /\/(assignment|assessment|discussion|event|page|document)s?\/(\d+)/i.exec(okUrl)
    || /\/course\/\d+\/materials\/(discussion|gp)\/view\/(\d+)/i.exec(okUrl);
  const uidRaw = ev.UID?.value || '';
  const type = (kindM?.[1] || '').toLowerCase() || /(assignment|assessment|discussion|event)/i.exec(uidRaw)?.[1]?.toLowerCase() || 'event';
  // Plain calendar events (rallies, "no school") aren't homework, unless they sound like it.
  if ((type === 'event' || type === 'page' || type === 'document') && !HOMEWORKISH.test(summary)) return null;
  return { ev, when, summary, okUrl, type, kindM, uidRaw };
}

// The spot that groups the homework most like classes: present on most items, 2-20 different
// values, and several items per value. Returns null if nothing looks like classes.
export function pickClassSpot(items) {
  const spots = { ...CLASS_SPOTS, ...xSpots(items.map((h) => h.ev)), ...numberSpots(items) };
  let best = null;
  for (const [key, fn] of Object.entries(spots)) {
    const names = items.map((h) => fn(h.ev, h.summary)?.name).filter(Boolean);
    const distinct = new Set(names.map((n) => n.toLowerCase())).size;
    const coverage = items.length ? names.length / items.length : 0;
    if (coverage < 0.6 || distinct < 2 || distinct > 20 || names.length / distinct < 1.5) continue;
    if (!best || coverage > best.coverage + 0.05) best = { key, fn, coverage, distinct };
  }
  return best;
}

const sgyId = (h) => (h.kindM?.[2] ? `${h.type}-${h.kindM[2]}` : `u-${shortHash(h.uidRaw || `${h.summary}|${h.when.due}`)}`);

function readSchoology(ev, ctx) {
  const h = schoologyHomework(ev);
  if (!h) return null;
  const { when, summary, okUrl, type } = h;
  // A class calendar the student added says exactly which class this is.
  const known = ctx?.classOf?.get(sgyId(h));
  const spot = known || ctx?.spot?.fn(ev, summary) || CLASS_SPOTS.bracket(ev, summary);
  const courseNum = /\/(?:course|section)s?\/(\d+)/i.exec(okUrl)?.[1];
  const courseName = spot?.name || '';
  const id = sgyId(h);
  const desc = unescape(ev.DESCRIPTION?.value || '').trim();
  return {
    id,
    title: (spot?.title || summary).trim() || 'Untitled',
    courseName: courseName.slice(0, 80) || 'Schoology',
    courseId: spot?.id || (courseName ? `n-${courseName.toLowerCase().slice(0, 80)}` : courseNum || 'none'),
    due: when.due, dueAt: when.sec,
    url: okUrl,
    desc: desc.replace(/https:\/\/\S+/g, '').trim().slice(0, 4000),
    tagHint: type === 'assessment' ? 'quiz' : null,
  };
}

// Logs only the *shape* of a Schoology feed, so class sorting can be fixed if the pick above
// misses: which fields appear, how many different values each has, and masked examples where
// every letter becomes a/A and every digit 9 ("Aaaa 9: Aaaa aaa"). Never names, titles or links.
const mask = (s) => String(s || '').replace(/https?:\/\/\S+/g, 'LINK').replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a')
  .replace(/\d/g, '9').replace(/a{3,}/g, 'aa').replace(/A{3,}/g, 'AA').replace(/9{3,}/g, '99').slice(0, 60);
function logShape(cal, items, spot, extra = {}) {
  const fields = {};
  for (const ev of cal.events.slice(0, 400)) {
    for (const [k, f] of Object.entries(ev)) {
      const x = (fields[k] ||= { n: 0, values: new Set(), samples: new Set(), params: new Set() });
      x.n++; x.values.add(f.value);
      if (x.samples.size < 4) x.samples.add(mask(unescape(f.value).split('\n')[0]));
      if (f.params) x.params.add(f.params.replace(/"[^"]*"/g, '"…"').slice(0, 40));
    }
  }
  const out = Object.fromEntries(Object.entries(fields).map(([k, x]) => [k, { n: x.n, distinct: x.values.size, samples: [...x.samples], params: [...x.params].slice(0, 3) }]));
  delete out.DTSTART?.samples;
  // IDs and link paths with letters kept (they're Schoology's words, like "assignment") and numbers blanked.
  const shapeOf = (v) => String(v || '').replace(/^https?:\/\/[^/]+/, '').replace(/\d+/g, 'N').slice(0, 60);
  const tally = (vals) => Object.entries(vals.reduce((o, v) => ({ ...o, [v]: (o[v] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (out.UID) out.UID.shapes = tally(cal.events.slice(0, 400).map((e) => shapeOf(e.UID?.value)));
  if (out.URL) out.URL.shapes = tally(cal.events.slice(0, 400).map((e) => shapeOf(e.URL?.value)));
  // How many numbers each ID / link has, and how many different values each position takes across homework.
  const numStats = (get) => [0, 1, 2, 3].map((k) => new Set(items.map((h) => numbersIn(get(h.ev))[k]).filter(Boolean)).size);
  out.numbers = { uid: numStats((ev) => ev.UID?.value), link: numStats((ev) => sgyLink(ev).replace(/^https:\/\/[^/]+/, '')) };
  // Description lines: count, and masked last lines (where some systems put the class).
  const lines = items.map((h) => unescape(h.ev.DESCRIPTION?.value || '').trim().split('\n'));
  // The trailing "- Word: CODE" tag: how many different codes, and their masked shapes.
  const tags = items.map((h) => descTag(h.ev)).filter(Boolean);
  // A link's shape: which site, and its path with numbers as N and long IDs as ID. Never the link itself.
  const linkShape = (u) => { const m = /^https?:\/\/([^/]+)(\/[^?#\s]*)?/i.exec(u) || [];
    const site = /schoology\.com$/i.test(m[1] || '') ? 'schoology' : /google\.com$/i.test(m[1] || '') ? 'google' : /youtube|youtu\.be/i.test(m[1] || '') ? 'youtube' : 'other';
    return site + (m[2] || '').replace(/[A-Za-z0-9_-]{20,}/g, 'ID').replace(/\d+/g, 'N').slice(0, 50); };
  out.descTag = { found: tags.length, distinctValues: new Set(tags.map((m) => m[2])).size,
    words: tally(tags.map((m) => m[1].toLowerCase())),
    links: tally(tags.filter((m) => /^https?:/i.test(m[2])).map((m) => linkShape(m[2]))) };
  out.descLinkShapes = tally(items.flatMap((h) => descLinks(h.ev)).map(linkShape));
  out.descLines = { avg: +(lines.reduce((a, l) => a + l.length, 0) / (lines.length || 1)).toFixed(1),
    lastDistinct: new Set(lines.map((l) => l[l.length - 1])).size, lastSamples: [...new Set(lines.map((l) => mask(l[l.length - 1])))].slice(0, 5) };
  console.log('schoology feed shape', JSON.stringify({ ...extra, events: cal.events.length, homework: items.length, picked: spot ? { key: spot.key, classes: spot.distinct, coverage: +spot.coverage.toFixed(2) } : null, fields: out }));
}

const READERS = { canvas: readCanvas, schoology: readSchoology };

// Compares the feed with our saved state and returns only the items that changed.
// classFeeds (Schoology): [{ key, name, feed }] — one calendar per class, added by the student.
// classMap (Schoology): [{ name, ids }] — which assignment numbers belong to which class, sent by
// the sync bookmark from the student's own Schoology pages.
export function diffWithFeed(kind, state, feed, todayYmd, { classFeeds = [], classMap = [] } = {}) {
  const now = Date.now();
  let ctx = null;
  if (kind === 'schoology') {
    const classOf = new Map();
    for (const c of classMap) {
      const cls = { name: c.name, id: `map-${shortHash(c.name.toLowerCase())}` };
      for (const n of c.ids) for (const type of ['assignment', 'assessment', 'discussion', 'event']) classOf.set(`${type}-${n}`, cls);
    }
    for (const cf of classFeeds) {
      for (const ev of cf.feed.events) {
        const h = schoologyHomework(ev);
        if (h) classOf.set(sgyId(h), { name: cf.name, id: `cal-${cf.key}` });
      }
    }
    // Class calendars may also hold homework the main calendar doesn't; read those too.
    feed = { ...feed, events: [...feed.events, ...classFeeds.flatMap((cf) => cf.feed.events)] };
    const hw = feed.events.map(schoologyHomework).filter(Boolean);
    ctx = { classOf, spot: classOf.size ? null : pickClassSpot(hw) };
    logShape(feed, hw, ctx.spot, { classFeeds: classFeeds.length, mapClasses: classMap.length, matched: hw.filter((h) => classOf.has(sgyId(h))).length });
  }
  const items = new Map();
  for (const ev of feed.events) {
    const a = READERS[kind](ev, ctx);
    if (a) items.set(a.id, a); // repeats of the same assignment: keep the last one
  }

  const idKey = `${kind}Id`, titleKey = `${kind}Title`;
  const classes = new Map(state.classes.filter((c) => c[idKey]).map((c) => [c[idKey], c]));
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const usedColors = new Set(state.classes.filter((c) => !c.deleted).map((c) => c.color));
  const changedClasses = [], changedTasks = [], newTasks = [];
  const seen = new Set();
  const fallbackId = `${kind}-c${shortHash('none')}`; // the catch-all class, when a class isn't known
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
      // Sitting in the catch-all class (from before its real class was known)? Move it to its class.
      const move = existing.classId === fallbackId && cls.id !== fallbackId;
      if (existing.due !== a.due || existing[titleKey] !== a.title || existing.url !== a.url || existing.desc !== a.desc || reopened || move) {
        changedTasks.push({
          ...existing, due: a.due, dueAt: a.dueAt, url: a.url, desc: a.desc, [titleKey]: a.title,
          ...(move ? { classId: cls.id } : {}),
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
  // Once everything has moved out of the catch-all class, remove it (unless you renamed it).
  const fallback = state.classes.find((c) => c.id === fallbackId && !c.deleted);
  if (fallback && !fallback.renamed) {
    const final = new Map(state.tasks.map((t) => [t.id, t]));
    for (const t of changedTasks) final.set(t.id, t);
    if (![...final.values()].some((t) => !t.deleted && t.classId === fallbackId)) {
      changedClasses.push({ ...fallback, deleted: true, updatedAt: now });
    }
  }
  // Schoology: the "- Word: CODE" tags at the end of descriptions, so the student can see them in
  // Settings (stored in their own account only; never logged).
  let feedTags;
  if (kind === 'schoology') {
    const counts = new Map();
    for (const ev of feed.events) {
      const h = schoologyHomework(ev);
      const m = h && descTag(ev);
      if (m) { const k = `${m[1]}\u0000${m[2]}`; counts.set(k, (counts.get(k) || 0) + 1); }
    }
    feedTags = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, count]) => { const [label, code] = k.split('\u0000'); return { label, code, count }; });
  }
  return { changedClasses, changedTasks, newTasks, eventCount: upcoming, classSpot: ctx?.spot?.key || null, feedTags };
}

function addDaysYmd(d, n) {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
