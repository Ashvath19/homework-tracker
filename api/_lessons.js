// Reads homework out of the "Lesson Plans & Homework" books that VCS teachers post in each course.
// Each book chapter is one class day (titled like "November 17/18" for the two sections),
// and has a "Homework" heading followed by a list.
import crypto from 'node:crypto';
import { COLORS, ymd, addDays } from './_lib.js';
import { ws, MOODLE_BASE, guessTag, cleanCourseName, tidyName } from './_moodle.js';
import { courseMaterials, studyFor } from './_study.js';
import { activityDetails, linksIn, cleanFileUrl, isMoodleFile, dedupeFiles, cmidFromUrl } from './_details.js';
import SCHOOL from './_schoolDays.json' with { type: 'json' };

// A/B/C letter for each school day, from the VCHS campus calendar. Days off aren't listed.
export const dayLetter = (d) => SCHOOL.days[d] || null;
// The next A (or B) day after `d`, skipping weekends, holidays and breaks.
export function nextClassDay(d, letter) {
  for (let i = 1; i <= 45; i++) {
    const dd = addDays(d, i);
    if (SCHOOL.days[dd] === letter) return dd;
  }
  return null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
const LOOKBACK_DAYS = 10;
export const LP_VERSION = 5; // 2: files, descriptions, lesson-plan links. 3: borrow matching links

const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m, d));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};
const hash = (s) => crypto.createHash('sha1').update(s.toLowerCase().replace(/\W+/g, '')).digest('hex').slice(0, 10);

// "November 13/ 16" → ['2026-11-13', '2026-11-16'];  "December 4" → ['2026-12-04', '2026-12-04']
// "October 15 A /20 B", "October 30/Nov 2" also work. Ranges ("Aug 17 - Sept 11") return null.
export function parseChapterDates(title, startYear) {
  const t = title.replace(/\s+/g, ' ');
  if (new RegExp(`\\d\\s*[-–]\\s*${MONTH_RE}`, 'i').test(t)) return null;
  const m = t.match(new RegExp(`\\b${MONTH_RE}\\s*(\\d{1,2})(?:\\s*[AB]\\b)?(?:\\s*\\/\\s*(?:${MONTH_RE}\\s*)?(\\d{1,2}))?`, 'i'));
  if (!m) return null;
  const mo1 = MONTHS[m[1].toLowerCase().slice(0, 3)];
  const d1 = Number(m[2]);
  const d2 = m[4] ? Number(m[4]) : d1;
  let mo2 = m[3] ? MONTHS[m[3].toLowerCase().slice(0, 3)] : mo1;
  if (!m[3] && d2 < d1) mo2 = (mo1 + 1) % 12; // "October 30/2" → Nov 2
  const yearFor = (mo) => (mo >= 6 ? startYear : startYear + 1); // school year: Jul–Dec, then Jan–Jun
  if (d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) return null;
  return [ymdOf(yearFor(mo1), mo1, d1), ymdOf(yearFor(mo2), mo2, d2)];
}

function schoolYearStart(bookName) {
  const m = bookName.match(/(20\d\d)\s*[-–]\s*(?:20)?\d\d/);
  if (m) return Number(m[1]);
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

function addWeekdays(ymdStr, n) {
  let d = ymdStr;
  while (n > 0) {
    d = addDays(d, 1);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) n--;
  }
  return d;
}

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Turn chapter HTML into lines: { text, heading, links, linkOnly }.
// Links are kept so homework can open the handout/packet it mentions.
function htmlToLines(h) {
  const t = h
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<p[^>]*>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '\n¶\n') // an empty paragraph = a visible gap
    .replace(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => `⟬${txt}⟭⟦${href}⟧`)
    .replace(/<h[1-6][^>]*>/gi, '\n§').replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n•')
    .replace(/<\/?(br|p|div|tr|ul|ol|table|li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(t).split('\n').map((raw) => {
    const links = [...raw.matchAll(/⟦([^⟧]*)⟧/g)].map((m) => m[1]);
    const bare = raw.replace(/⟬[^⟭]*⟭/g, '').replace(/⟦[^⟧]*⟧/g, '').replace(/[§•\s]/g, '');
    const text = raw.replace(/⟦[^⟧]*⟧/g, '').replace(/[⟬⟭]/g, '').replace(/^[\s§•]+/, '').replace(/\s+/g, ' ').trim();
    let shown = text;
    try { shown = decodeURIComponent(text); } catch {}
    const blank = raw.trim() === '¶';
    return { text: blank ? '' : shown, heading: raw.trim().startsWith('§'), links, linkOnly: !!links.length && !bare, blank };
  }).filter((l) => l.text || l.blank); // keep visible gaps: a big gap ends an item's attachments
}

// friendly notes, not homework: "Enjoy your Thanksgiving break!"
const NOT_HOMEWORK = /^(enjoy|have a (great|good|nice|wonderful|restful|blessed)|happy |rest up|relax|merry|good luck|see you|no (homework|hw)\b)/i;
const FILLER = /^(n\/?a|none|no homework|nothing|tbd|tba|-+|—|complete\s*\.{2,}|\.{2,}|…)\.?$/i;
const DUE_RE = new RegExp(`\\bdue\\s*:?\\s*(?:by\\s+|on\\s+)?(?:[a-z]+day,?\\s*)?${MONTH_RE}\\s*\\d{1,2}`, 'i');

// Pulls homework out of a chapter. Returns [{ text, links }]:
//  - every line under a "Homework" heading
//  - any other line that says "Due: <date>" (Spanish lists projects this way)
export function extractHomework(html, baseUrl = '') {
  const resolve = (href) => {
    if (!href || /^(mailto|javascript):/i.test(href)) return null;
    try { return new URL(href, baseUrl || MOODLE_BASE + '/').href; } catch { return null; }
  };
  const lines = htmlToLines(html);
  const out = [];
  let inHw = false;
  let last = null; // the item a following link-only line belongs to
  const add = (text, links) => {
    text = text.length > 200 ? `${text.slice(0, 197)}…` : text;
    if (out.some((o) => o.text === text)) { last = null; return; }
    last = { text, links: links.map(resolve).filter(Boolean) };
    out.push(last);
  };

  let blanks = 0;
  for (const l of lines) {
    if (l.blank) { if (++blanks >= 2) last = null; continue; }
    blanks = 0;
    const hw = l.text.match(/^(home\s*work|hw)\s*(?:assignments?)?\s*[:\-–]?\s*(.*)$/i);
    if (hw && (l.heading || l.text.length < 40 || /^(home\s*work|hw)\s*:/i.test(l.text))) {
      inHw = true;
      last = null;
      if (hw[2] && !FILLER.test(hw[2])) add(hw[2], l.links);
      continue;
    }
    // a line that's only a link (like a project handout) belongs to the item above it
    if (l.linkOnly) {
      if (last) last.links.push(...l.links.map(resolve).filter(Boolean));
      else if (inHw) add(l.text, l.links);
      continue;
    }
    if (inHw && (l.heading || (/:$/.test(l.text) && l.text.length < 45))) { inHw = false; last = null; continue; }
    if (inHw) {
      if (FILLER.test(l.text) || NOT_HOMEWORK.test(l.text) || l.text.length < 3) continue;
      if (/^(lesson plans?|homework|class ?work)( and| &)? .{0,30}subject to change/i.test(l.text)) continue;
      add(l.text, l.links);
      continue;
    }
    if (DUE_RE.test(l.text)) {
      add(l.text, l.links);
      continue;
    }
    last = null;
  }
  // Lines elsewhere in the chapter that have links ("Answer Prelab Questions - Student Lab Packet"),
  // so homework without its own link can borrow the matching one.
  const related = lines.filter((l) => !l.blank && l.links.length && !l.linkOnly).map((l) => ({ text: l.text, links: l.links.map(resolve).filter(Boolean) }));
  const items = out.slice(0, 10);
  for (const it of items) {
    if (it.links.length) continue;
    const mine = sigWords(it.text);
    const match = related.find((r) => r.text !== it.text && [...sigWords(r.text)].filter((w) => mine.has(w)).length >= 2);
    if (match) it.links.push(...match.links);
  }
  return items;
}

const GENERIC = new Set(['complete', 'finish', 'class', 'next', 'from', 'with', 'this', 'that', 'your', 'have', 'will', 'today', 'students', 'homework', 'read', 'page', 'pages', 'work', 'quiz', 'test', 'study', 'turn', 'here', 'answer']);
function sigWords(text) {
  return new Set(text.toLowerCase().replace(/pre-/g, 'pre').replace(/[^a-z0-9 ]+/g, ' ').split(' ')
    .filter((w) => (w.length >= 4 || /^\d+$/.test(w)) && !GENERIC.has(w)));
}

// "Projecto-Pintores Espanoles Due: Nov.18th" → "Projecto-Pintores Espanoles"
function titleWithoutDue(text) {
  const t = text.replace(/[(\[]?\s*\bdue\b[\s\S]*$/i, '').replace(/[\s\-–—:,(]+$/, '').trim();
  return t.length >= 3 ? t : text;
}

// "(due Nov 20, 8pm)" → '2026-11-20'
function explicitDue(text, startYear) {
  const m = text.match(new RegExp(`due[:\\s]+(?:by\\s+)?(?:[a-z]+day,?\\s*)?${MONTH_RE}\\s*(\\d{1,2})`, 'i'));
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
  return ymdOf(mo >= 6 ? startYear : startYear + 1, mo, Number(m[2]));
}

async function fetchFile(fileurl, token) {
  const url = `${fileurl}${fileurl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`chapter fetch ${r.status}`);
  return r.text();
}

// "Session 2 Reflection HERE (due Nov 20)" vs the Moodle assignment "HNTRB Session 2 Reflection":
// same thing if most of the meaningful words match.
const STOP = new Set(['the', 'and', 'for', 'here', 'due', 'turn', 'submit', 'your', 'with', 'complete', 'finish', 'class', 'next', 'end', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);
const words = (x) => x.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => (w.length >= 3 || /^\d+$/.test(w)) && !STOP.has(w) && !/^\d+(am|pm)$/.test(w));
function isSameAsAssignment(text, assignmentNames) {
  const mine = words(text);
  if (!mine.length) return false;
  return assignmentNames.some((n) => {
    const theirs = new Set(words(n));
    if (!theirs.size) return false;
    const hits = mine.filter((w) => theirs.has(w)).length;
    return hits / mine.length >= 0.7 || hits / theirs.size >= 0.8;
  });
}

// Compare lesson-plan homework with our saved state; returns only what changed.
export async function diffLessonPlans(state, token, moodleUserId) {
  const now = Date.now();
  const today = ymd(new Date());
  const since = addDays(today, -LOOKBACK_DAYS);
  // chapter → timemodified we last read. Bump LP_VERSION when what we pull out of chapters changes.
  const cache = state.meta.lpVersion === LP_VERSION ? { ...(state.meta.lpSeen || {}) } : {};
  const lessonLinks = { ...(state.meta.lpAssign || {}) }; // assignment cmid → lesson plan that links it
  const firstRun = !state.meta.lpInitialized;

  const courses = await ws(token, 'core_enrol_get_users_courses', { userid: moodleUserId });
  // Moodle's course end dates are often stale (AP CS A says 2021), so a course counts as current
  // if it has a lesson-plan book for this school year.
  const active = courses.filter((c) => c.visible !== 0);
  const thisYear = schoolYearStart('');

  const classes = new Map(state.classes.filter((c) => c.moodleId).map((c) => [c.moodleId, c]));
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const usedColors = new Set(state.classes.filter((c) => !c.deleted).map((c) => c.color));
  const changedClasses = [], changedTasks = [], newTasks = [];
  // newest version of an item in this sync (so later passes build on earlier ones)
  const latest = (id) => { for (let i = changedTasks.length - 1; i >= 0; i--) if (changedTasks[i].id === id) return changedTasks[i]; return tasks.get(id); };

  for (const course of active) {
    let contents;
    try { contents = await ws(token, 'core_course_get_contents', { courseid: course.id }); } catch { continue; }
    if (!Array.isArray(contents)) continue;
    const books = contents
      .filter((s) => /lesson\s*plan/i.test(s.name || ''))
      .flatMap((s) => (s.modules || []).filter((m) => m.modname === 'book' && m.visible !== 0 && m.uservisible !== false))
      .filter((b) => schoolYearStart(b.name) === thisYear);
    if (!books.length) continue;

    // course modules by id, so "mod/resource/view.php?id=…" links can become the actual file
    const modules = new Map(contents.flatMap((sec) => sec.modules || []).map((m) => [m.id, m]));
    let detailsP = null;
    const details = () => (detailsP ||= activityDetails(ws, token, [course.id]).catch(() => new Map()));

    // A homework link → files to show + (if it points at a Moodle assignment) its description
    const resolveLinks = async (links, names = []) => {
      const files = []; let desc = '';
      for (const [i, href] of links.entries()) {
        const cmid = /\/mod\/(resource|url|assign|quiz|page|folder)\/view\.php/.test(href) && href.startsWith(MOODLE_BASE) ? cmidFromUrl(href) : null;
        const mod = cmid && modules.get(cmid);
        if (mod?.modname === 'resource' && mod.contents?.[0]) {
          files.push({ name: mod.contents[0].filename || mod.name, url: cleanFileUrl(mod.contents[0].fileurl) });
        } else if (mod?.modname === 'url' && mod.contents?.[0]?.fileurl) {
          files.push({ name: mod.name, url: mod.contents[0].fileurl });
        } else if (mod && (mod.modname === 'assign' || mod.modname === 'quiz')) {
          const d = (await details()).get(`cm-${cmid}`);
          if (d) { desc ||= d.desc; files.push(...d.files); }
        } else if (isMoodleFile(href)) {
          files.push({ name: names[i] || decodeURIComponent(href.split('/').pop().split('?')[0]), url: cleanFileUrl(href) });
        } else {
          files.push({ name: names[i] || href.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60), url: href });
        }
      }
      return { files: dedupeFiles(files), desc };
    };

    let cls = classes.get(course.id);
    if (cls?.deleted) continue; // you deleted this class
    if (!cls) {
      const color = COLORS.find((c) => !usedColors.has(c)) || COLORS[classes.size % COLORS.length];
      usedColors.add(color);
      cls = { id: `moodle-c${course.id}`, moodleId: course.id, name: cleanCourseName(course.fullname), color, updatedAt: now };
      classes.set(course.id, cls);
      changedClasses.push(cls);
    }
    const tidy = cls && tidyName(cls, course.fullname);
    if (tidy) { cls = { ...cls, name: tidy, updatedAt: now }; classes.set(course.id, cls); changedClasses.push(cls); }
    const ab = cls?.day === 'B' ? 1 : 0; // chapter titles list the A-day date first, then the B-day date

    const courseChapters = []; // every dated chapter from every quarter's book
    for (const book of books) {
      const files = book.contents || [];
      const structureFile = files.find((f) => f.filename === 'structure');
      if (!structureFile?.content) continue;
      let chapters;
      try { chapters = JSON.parse(structureFile.content); } catch { continue; }
      const startYear = schoolYearStart(book.name);
      const chapterFiles = new Map(files.filter((f) => f.filename === 'index.html').map((f) => [f.filepath.replace(/\//g, ''), f]));

      const dated = chapters
        .filter((c) => c.hidden !== '1' && c.level === 0)
        .map((c) => ({ ...c, chapId: c.href.split('/')[0], dates: parseChapterDates(c.title, startYear) }))
        .filter((c) => c.dates);

      const chapterUrl = (c) => `${MOODLE_BASE}/mod/book/view.php?id=${book.id}&chapterid=${c.chapId}`;
      courseChapters.push(...dated.map((c) => ({ ...c, url: chapterUrl(c) })));

      for (let i = 0; i < dated.length; i++) {
        const ch = dated[i];
        const myDate = ch.dates[ab];
        if (myDate < since || myDate > addDays(today, 21)) continue;
        const file = chapterFiles.get(ch.chapId);
        if (!file) continue;
        const cacheKey = `${book.id}-${ch.chapId}`;
        const prefix = `lp-${cacheKey}-`;
        const next = dated[i + 1];
        // Homework is due next class. Use the school calendar to find the next A day (for the
        // A section) and next B day (for the B section). Fall back to the next chapter's date,
        // then to a 2-school-day guess, if the calendar doesn't cover that date.
        const nextDates = ch.dates.map((d, k) => {
          const letter = dayLetter(d) || (k === 0 ? 'A' : 'B');
          return nextClassDay(d, letter)
            || (next && next.dates[k] > d ? next.dates[k] : addWeekdays(d, 2));
        });
        const estimated = !ch.dates.every((d) => dayLetter(d));
        const unchanged = cache[cacheKey] === file.timemodified;

        if (unchanged) {
          // text didn't change, but the due date may have (the next chapter got posted)
          for (const t of state.tasks) {
            if (!t.id.startsWith(prefix) || t.deleted || t.dueAuto === false || !t.lpDates) continue;
            if (t.lpDates.join() !== nextDates.join() || t.due !== nextDates[ab]) {
              changedTasks.push({ ...t, lpDates: nextDates, due: nextDates[ab], dueEstimated: estimated, updatedAt: now });
            }
          }
          continue;
        }

        let items;
        const pageBase = file.fileurl.replace('/webservice/pluginfile.php', '/pluginfile.php'); // opens with your normal Moodle login
        let html;
        try { html = await fetchFile(file.fileurl, token); } catch { continue; }
        items = extractHomework(html, pageBase);
        for (const l of linksIn(html, pageBase)) {
          const cm = /\/mod\/(assign|quiz)\/view\.php/.test(l.url) ? cmidFromUrl(l.url) : null;
          if (cm) lessonLinks[cm] = { u: chapterUrl(ch), t: ch.title.trim() };
        }
        cache[cacheKey] = file.timemodified;

        // Moodle assignments in this class, to avoid listing the same thing twice
        const assignmentNames = [...tasks.values(), ...changedTasks]
          .filter((t) => t.source === 'moodle' && t.classId === cls.id && !t.deleted && (t.moodleTitle || t.title).length >= 8)
          .map((t) => t.moodleTitle || t.title);

        const seen = new Set();
        for (const { text: rawText, links } of items) {
          const text = titleWithoutDue(rawText);
          const { files, desc: linkedDesc } = await resolveLinks(links);
          // only show the original line as instructions if it says more than the title + due date
          const extra = rawText.replace(text, '').replace(/[(\[]?\s*\bdue\b[\s\S]*$/i, '').trim();
          const desc = linkedDesc || (extra.length > 10 ? rawText : '');
          const link = files[0]?.url || null;
          const id = prefix + hash(text);
          if (seen.has(id)) continue;
          seen.add(id);
          const fixedDue = explicitDue(rawText, startYear);
          const existing = tasks.get(id);
          if (existing) {
            if (existing.deleted) continue;
            if (JSON.stringify(existing.files || []) !== JSON.stringify(files) || (existing.desc || '') !== desc) {
              changedTasks.push({ ...existing, files, desc, link, lessonUrl: existing.url, lessonTitle: existing.chapter, updatedAt: now });
            }
            if (existing.dueAuto === false || fixedDue) continue;
            if (existing.due !== nextDates[ab] || existing.lpDates?.join() !== nextDates.join()) {
              changedTasks.push({ ...existing, lpDates: nextDates, due: nextDates[ab], dueEstimated: estimated, updatedAt: now });
            }
            continue;
          }
          const due = fixedDue || nextDates[ab];
          if (due < today) continue; // already past — you've handled it
          if (isSameAsAssignment(text, assignmentNames)) continue; // already a Moodle assignment
          const t = {
            id, source: 'lesson', classId: cls.id, title: text, moodleTitle: text, tag: guessTag('lesson', text),
            due, lpDates: fixedDue ? null : nextDates, dueAuto: true, dueEstimated: !fixedDue && estimated,
            link, files, desc, chapter: ch.title.trim(), lessonTitle: ch.title.trim(), lessonUrl: chapterUrl(ch), url: `${MOODLE_BASE}/mod/book/view.php?id=${book.id}&chapterid=${ch.chapId}`,
            notes: '', done: false, doneAt: null, updatedAt: now,
          };
          changedTasks.push(t);
          if (!firstRun) newTasks.push(t);
        }
        // the teacher removed or reworded something: drop the old unfinished version
        for (const t of state.tasks) {
          if (t.id.startsWith(prefix) && !seen.has(t.id) && !t.done && !t.deleted && t.title === t.moodleTitle) {
            changedTasks.push({ ...t, deleted: true, updatedAt: now });
          }
        }
      }
    }

    // Every Moodle assignment in this class gets a link to its lesson plan: the chapter that
    // links to it, or else the last class day on/before it's due.
    if (cls && courseChapters.length) {
      const ordered = courseChapters.slice().sort((a, b) => a.dates[ab].localeCompare(b.dates[ab]));
      for (const id of new Set([...tasks.keys(), ...changedTasks.map((x) => x.id)])) {
        const t = latest(id);
        if (t.classId !== cls.id || t.source !== 'moodle' || t.deleted || !t.due) continue;
        const named = t.cmid && lessonLinks[t.cmid];
        const byDate = [...ordered].reverse().find((c) => c.dates[ab] <= t.due && c.dates[ab] >= addDays(t.due, -14));
        const pick = named || (byDate && { u: byDate.url, t: byDate.title.trim() });
        if (pick && (t.lessonUrl !== pick.u || t.lessonTitle !== pick.t)) {
          changedTasks.push({ ...t, lessonUrl: pick.u, lessonTitle: pick.t, updatedAt: now });
        }
      }
    }

    // Classes whose lesson plans use one date per day (AP CS A) don't need the A/B question.
    const single = courseChapters.length > 0 && courseChapters.every((c) => c.dates[0] === c.dates[1]);
    if (!!cls.singleDay !== single) {
      cls = { ...cls, singleDay: single, updatedAt: now };
      classes.set(course.id, cls);
      changedClasses.push(cls);
    }

    // Quizzes and tests: practice + study material from anywhere on the course page.
    const materials = courseMaterials(contents);
    for (const id of new Set([...tasks.keys(), ...changedTasks.map((x) => x.id)])) {
      const t = latest(id);
      if (!t || t.classId !== cls.id || t.deleted || t.done || (t.tag !== 'quiz' && t.tag !== 'test')) continue;
      const study = studyFor(t, materials);
      if (JSON.stringify(study) !== JSON.stringify(t.study || [])) changedTasks.push({ ...t, study, updatedAt: now });
    }
  }
  // keep only the newest version of each item
  const final = [...new Map(changedTasks.map((t) => [t.id, t])).values()];
  return { changedClasses: [...new Map(changedClasses.map((c) => [c.id, c])).values()], changedTasks: final, newTasks, lpSeen: cache, lpAssign: lessonLinks };
}
