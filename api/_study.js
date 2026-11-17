// Study materials for quizzes and tests: practice, review, notes and slides that the teacher posted
// anywhere on the course page, matched to what the quiz/test covers.
//   "Quiz on 3.1-3.4"  → only materials for sections 3.1–3.4 (+ quiz reviews in chapter 3)
//   "Ch. 3 test"       → everything for chapter 3, study guides and practice first
import { cleanFileUrl, linksIn, isMoodleFile } from './_details.js';

const num = (s) => Number(s);

// Section numbers ("3.1", ranges like "3.1-3.4" or "4.1-4.3") and chapter/unit numbers in some text.
export function scopeOf(text) {
  const t = ` ${text.toLowerCase().replace(/–|—/g, '-')} `;
  const sections = new Set();
  for (const m of t.matchAll(/\b(\d{1,2})\.(\d{1,2})\s*(?:-|to|through|thru)\s*(?:(\d{1,2})\.)?(\d{1,2})\b/g)) {
    const ch = num(m[1]);
    if (m[3] && num(m[3]) !== ch) continue; // crosses chapters; handled as single numbers below
    for (let k = num(m[2]); k <= num(m[4]) && k - num(m[2]) < 15; k++) sections.add(`${ch}.${k}`);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\.(\d{1,2})\b/g)) sections.add(`${num(m[1])}.${num(m[2])}`);
  const chapters = new Set(), units = new Set();
  // "Ch. 3", "Chapter 5-7", "Ch 2, 3, 4", "Chapters 8 & 9"
  for (const m of t.matchAll(/\b(?:ch(?:apter|apt|p)?s?\.?)\s*#?\s*(\d{1,2}(?:\s*(?:-|&|and|,|\/)\s*\d{1,2}(?!\.\d))*)/g)) {
    const parts = m[1].split(/\s*(?:&|and|,|\/)\s*/);
    for (const p of parts) {
      const [a, b] = p.split(/\s*-\s*/).map(num);
      for (let k = a; k <= (b || a) && k - a < 6; k++) chapters.add(k);
    }
  }
  for (const m of t.matchAll(/\b(?:unit|module)\s*#?\s*(\d{1,2})\b/g)) units.add(num(m[1]));
  return { sections, chapters, units };
}

const STUDY_FIRST = /(study|review|practice|prep|guide|sample|extra|remediation|warm ?-?up|vocab|flash|frq|mcq|definitions|theorems|formula|video)/i;
const SKIP = /(syllabus|zoom|survey|sign|permission|back to school|join|club|submission|turn in|insert your|data here|upload)/i;

// Every file/link on the course page, with the chapter/unit it belongs to.
export function courseMaterials(contents) {
  const out = [];
  for (const sec of contents || []) {
    const secName = (sec.name || '').replace(/&amp;/g, '&');
    if (/lesson\s*plan/i.test(secName)) continue;
    const secScope = scopeOf(secName);
    // a section named "Ch. 3 …" belongs to chapter 3; "Unit 2 …" to unit 2
    const secChapter = /^\s*(ch|chapter)\b/i.test(secName) ? [...secScope.chapters][0] : null;
    const secUnit = [...secScope.units][0] ?? null;
    const add = (name, url) => {
      if (!url || SKIP.test(name)) return;
      const sc = scopeOf(name);
      out.push({ name, url: isMoodleFile(url) ? cleanFileUrl(url) : url, section: secName, sections: sc.sections, chapters: sc.chapters, units: sc.units, secChapter, secUnit });
    };
    for (const m of sec.modules || []) {
      if (m.visible === 0 || m.uservisible === false) continue;
      const name = (m.name || '').replace(/&amp;/g, '&');
      if (m.modname === 'resource' && m.contents?.[0]) add(name, m.contents[0].fileurl);
      else if (m.modname === 'url' && m.contents?.[0]?.fileurl) add(name, m.contents[0].fileurl);
      else if (m.modname === 'folder') for (const f of m.contents || []) add(`${name}: ${f.filename}`, f.fileurl);
      else if (m.modname === 'page' || (m.modname === 'quiz' && /practice|review/i.test(name))) add(name, m.url);
      else if (m.modname === 'label') {
        // review videos are often "Mitosis Review Video — HERE": name vague links after the label text
        const labelText = (m.description || '').replace(/<a\b[\s\S]*?<\/a>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
        for (const l of linksIn(m.description || '')) {
          const vague = /^(here|link|linked here|click here|this|video|https?:)/i.test(l.name) || l.name.length < 4;
          add(vague && labelText ? labelText.slice(0, 70) : l.name, l.url);
        }
      }
    }
  }
  return out;
}

// Pick the materials for one quiz/test.
export function studyFor(task, materials) {
  const text = `${task.title} ${task.desc || ''}`.slice(0, 400);
  const scope = scopeOf(text);
  const isTest = task.tag === 'test';
  const chapterOfSections = new Set([...scope.sections].map((s) => num(s.split('.')[0])));
  let picked = [];

  if (scope.sections.size && !(isTest && scope.chapters.size)) {
    // section quiz: only those sections, plus quiz reviews/practice from that chapter
    picked = materials.filter((m) =>
      [...m.sections].some((s) => scope.sections.has(s))
      || (/quiz/i.test(m.name) && /review|practice|remediation/i.test(m.name)
        && ([...m.chapters].some((c) => chapterOfSections.has(c)) || chapterOfSections.has(m.secChapter))));
  } else if (scope.chapters.size || scope.units.size) {
    // chapter/unit quiz or test: everything for that chapter
    picked = materials.filter((m) =>
      [...m.chapters].some((c) => scope.chapters.has(c))
      || (scope.chapters.has(m.secChapter) && !m.chapters.size)
      || [...m.units].some((u) => scope.units.has(u))
      || (scope.units.has(m.secUnit) && !m.chapters.size)
      || [...m.sections].some((s) => scope.chapters.has(num(s.split('.')[0]))));
  }

  // Also bring along the unit's general review material (videos, practice) that has no chapter
  // number, from the same course sections the matches came from.
  if (picked.length && !scope.sections.size) {
    const secs = new Set(picked.map((m) => m.section));
    picked.push(...materials.filter((m) => secs.has(m.section) && !m.chapters.size && !m.sections.size && STUDY_FIRST.test(m.name)));
  }

  // study guides / practice / review first, then notes & slides, solutions right after what they solve
  const rank = (m) => (STUDY_FIRST.test(m.name) ? 0 : /notes|slides|lecture/i.test(m.name) ? 1 : 2) + (/solution|key|answers/i.test(m.name) ? 0.5 : 0);
  const seen = new Set();
  return picked
    .filter((m) => !seen.has(m.url) && seen.add(m.url))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 24)
    .map((m) => ({ name: m.name, url: m.url }));
}
