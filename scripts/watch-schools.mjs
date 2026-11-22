// Weekly check: has any school changed the calendar or bell schedule the site's school files were built from?
// For each source it follows the document link on the school's page (or reads one section of the page),
// fingerprints it, and compares with scripts/school-watch-state.json.
// Usage: node scripts/watch-schools.mjs            → check, print a report, update the state file
//        node scripts/watch-schools.mjs --show ID  → print a section's text (to pick markers)
// It never changes public/schools: a person reads the change and updates scripts/build-schools.py.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const STATE = path.join(DIR, 'school-watch-state.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; homework-tracker calendar check)' };
const FAILS_BEFORE_ALERT = 3; // a site being down for a week or two isn't worth an alert

// link: find <a> on `page` whose text or href matches (document ids, so a new upload shows up as a missing link), follow it, fingerprint the file.
// section: fingerprint the page text between `from` and `to`.
const SOURCES = [
  { id: 'scusd-calendar', schools: 'Wilcox, Santa Clara High', kind: 'link', page: 'https://www.santaclarausd.org/calendar', match: /feb73074-4ec2-437c-bf50-34ec334231c7/ },
  { id: 'wilcox-bell', schools: 'Wilcox', kind: 'section', page: 'https://wilcox.santaclarausd.org/about/bell-schedule', from: 'Regular Bell Schedule', to: null },
  { id: 'schs-bell', schools: 'Santa Clara High', kind: 'section', page: 'https://santaclara.santaclarausd.org/about-us/bell-schedule', from: 'STANDARD BELL SCHEDULE', to: null },
  { id: 'fuhsd-calendar', schools: 'Lynbrook, Monta Vista, Cupertino, Homestead, Fremont', kind: 'link', page: 'https://www.fuhsd.org/about-us/general-information/calendar', match: /6ee85765-22a0-40ab-a863-e227d30d3d72/ },
  { id: 'fuhsd-calendar-page', schools: 'Lynbrook, Monta Vista, Cupertino, Homestead, Fremont', kind: 'section', page: 'https://www.fuhsd.org/about-us/general-information/calendar', from: 'Academic Calendar', to: 'Instructional' },
  ...[['lynbrook', 'lhs', 'bell-schedule'], ['monta-vista', 'mvhs', 'bell-schedule'], ['cupertino', 'chs', 'bell-schedules'], ['homestead', 'hhs', 'bell-schedule'], ['fremont', 'fhs', 'bell-schedule']]
    .map(([id, host, slug]) => ({ id: `${id}-bell`, schools: id, kind: 'section', page: `https://${host}.fuhsd.org/about-us/general-information/${slug}`, from: 'Monday', to: null })),
  { id: 'lgsuhsd-calendar', schools: 'Los Gatos, Saratoga', kind: 'link', page: 'https://www.lgsuhsd.org/resources/calendars-schedules', match: /8917e921-2139-4b2c-9d3a-536b2f19a42b/ },
  { id: 'lghs-orange-black', schools: 'Los Gatos', kind: 'link', page: 'https://www.lgsuhsd.org/resources/calendars-schedules', match: /130a5fb3-6fe8-435e-b58c-a22a727d172a/ },
  { id: 'lghs-bell', schools: 'Los Gatos', kind: 'link', page: 'https://www.lghs.net/about-us/calendarschedules', match: /Block_Bell_Schedule/ },
  { id: 'shs-red-blue', schools: 'Saratoga', kind: 'link', page: 'https://www.lgsuhsd.org/resources/calendars-schedules', match: /1f1b32c9-00e1-4c8a-9dde-0248d6301b2f/ },
  { id: 'shs-bell', schools: 'Saratoga', kind: 'link', page: 'https://www.saratogahigh.org/about-us/calendars-and-schedules', match: /2026-2027_Bell_Schedule/ },
  { id: 'sjusd-calendar', schools: 'Leland, San José High, Lincoln, Willow Glen, Pioneer, Gunderson', kind: 'link', page: 'https://www.sjusd.org/calendar', match: /570d295b-315c-4fcf-ba30-68f358ea9c24/ },
  { id: 'leland-bell', schools: 'Leland', kind: 'link', page: 'https://leland.sjusd.org/about/bell-schedule', match: /649fdcde-8792-43b5-8736-8bc64184741e/ },
  { id: 'sjhs-bell', schools: 'San José High', kind: 'link', page: 'https://sjhs.sjusd.org/about/bell-schedule', match: /75b9515f-b21b-49d9-a19d-d86bfa9b5e68/ },
  { id: 'pausd-calendar', schools: 'Gunn, Palo Alto High', kind: 'link', page: 'https://www.pausd.org/school-life/calendar', match: /64908bef-89c3-49eb-9a8e-65cd801189a6/ },
  { id: 'gunn-bell', schools: 'Gunn', kind: 'link', page: 'https://gunn.pausd.org/campus-life/bell-schedule', match: /060ffb24-de7e-4177-89ac-4e891e7e5df5/ },
  { id: 'paly-bell', schools: 'Palo Alto High', kind: 'link', page: 'https://www.paly.net/campus-life/daily-bell-schedule', match: /PalyWeeklyBellSchedule/ },
  { id: 'esuhsd-calendar', schools: 'East Side Union high schools', kind: 'link', page: 'https://www.esuhsd.org/', match: /2026-27 Instructional Calendar/ },
  { id: 'bcp-dates', schools: 'Bellarmine', kind: 'link', page: 'https://www.bcp.org/important-student-dates', match: /ImportantStudentDates/ },
  { id: 'bcp-schedule', schools: 'Bellarmine', kind: 'section', page: 'https://bcp.org/academics/daily-class-schedule', from: 'Monday', to: null },
  { id: 'mitty-dates', schools: 'Archbishop Mitty', kind: 'section', page: 'https://www.mitty.com/about-amhs/amhs-holidays-and-important-dates', from: '2026-27', to: null },
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
async function get(url) {
  const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}
// Page text without menus' markup, scripts or styles; one line per block.
function pageText(html) {
  return html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h\d|td|th|section|br)\s*>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
// The main content only: finalsite pages wrap it in <main>; this drops the site-wide header, footer and news.
const mainPart = (html) => (html.match(/<main\b[\s\S]*?<\/main>/i) || [html])[0];

async function fingerprint(src) {
  const page = await (await get(src.page)).text();
  if (src.kind === 'section') {
    const text = pageText(mainPart(page));
    const a = text.indexOf(src.from);
    if (a < 0) throw new Error(`can't find "${src.from}" on the page anymore (the page was probably redone)`);
    const b = src.to ? text.indexOf(src.to, a + src.from.length) : -1;
    const part = text.slice(a, b > a ? b : undefined);
    return { hash: sha(part), text: part };
  }
  const links = [...page.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const hit = links.find((m) => src.match.test(m[0]));
  if (!hit) return { gone: true }; // the page loaded but the document isn't linked anymore: usually a new version
  const href = new URL(hit[1].replace(/&amp;/g, '&'), src.page).href;
  const file = await get(href);
  const buf = Buffer.from(await file.arrayBuffer());
  return { hash: sha(buf), url: file.url, bytes: buf.length };
}

if (process.argv[2] === '--show') {
  const src = SOURCES.find((s) => s.id === process.argv[3]);
  const r = await fingerprint(src);
  console.log(r.text ?? r);
  process.exit(0);
}

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const changed = [], broken = [], fresh = [];
for (const src of SOURCES) {
  const old = state[src.id];
  try {
    const r = await fingerprint(src);
    if (r.gone) {
      if (!old?.gone) changed.push({ src, note: 'the document link is gone from the page, so the school probably posted a new version' });
      state[src.id] = { ...old, gone: true, fails: 0 };
      continue;
    }
    if (!old?.hash) fresh.push(src);
    else if (old.hash !== r.hash || old.gone) changed.push({ src, url: r.url });
    state[src.id] = { hash: r.hash, url: r.url, fails: 0 };
  } catch (e) {
    const fails = (old?.fails || 0) + 1;
    state[src.id] = { ...old, fails, lastError: String(e.message || e) };
    if (fails === FAILS_BEFORE_ALERT || (!old?.hash && fails === 1)) broken.push({ src, error: state[src.id].lastError });
    console.error(`${src.id}: ${e.message} (${fails} in a row)`);
  }
}
fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n');

let report = '';
if (changed.length) {
  report += '## Changed\nThese school pages or documents are different from last time. Check what changed, update `scripts/build-schools.py` if the days off or schedule moved, then rebuild and deploy.\n\n';
  for (const c of changed) report += `- **${c.src.schools}** (\`${c.src.id}\`): ${c.src.page}${c.url && c.url !== c.src.page ? ` → [document](${c.url})` : ''}${c.note ? ` (${c.note})` : ''}\n`;
}
if (broken.length) {
  report += `\n## Couldn't check\nThese failed ${FAILS_BEFORE_ALERT} weeks in a row (or on the first try). The page may have moved; the source list in \`scripts/watch-schools.mjs\` needs updating.\n\n`;
  for (const b of broken) report += `- **${b.src.schools}** (\`${b.src.id}\`): ${b.src.page} — ${b.error}\n`;
}
console.log(report || `No changes. ${fresh.length ? `Started watching ${fresh.length} new source(s).` : ''}`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `alert=${report ? 'yes' : 'no'}\n`);
  fs.writeFileSync(path.join(DIR, '..', 'school-watch-report.md'), report);
}
