// Descriptions and files for homework: what the teacher wrote, and the handouts attached to it.
import { MOODLE_BASE } from './_moodle.js';

export function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Teacher HTML → readable plain text (paragraphs and "• " bullets), capped in length.
export function htmlToText(html, max = 1500) {
  if (!html) return '';
  let t = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/?(br|p|div|tr|ul|ol|table|h[1-6]|li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  t = decode(t).split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s && s !== '•').join('\n');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Moodle file links: store the normal (non-webservice) address without any key in it.
export function cleanFileUrl(u) {
  try {
    const url = new URL(u, MOODLE_BASE + '/');
    url.pathname = url.pathname.replace(/^\/webservice\/pluginfile\.php/, '/pluginfile.php');
    url.searchParams.delete('token');
    url.searchParams.delete('forcedownload');
    return url.href;
  } catch { return u; }
}
export const isMoodleFile = (u) => /^https:\/\/[^/]+\/(webservice\/)?pluginfile\.php\//.test(u) && u.startsWith(MOODLE_BASE);
const fileName = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()); } catch { return 'File'; } };

// Links inside teacher HTML → [{ name, url }]
export function linksIn(html, base) {
  const out = [];
  for (const m of (html || '').matchAll(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decode(m[1]);
    if (!href || /^(mailto|javascript|#)/i.test(href)) continue;
    let url;
    try { url = new URL(href, base || MOODLE_BASE + '/').href; } catch { continue; }
    const name = decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || fileName(url);
    out.push({ name: safeDecode(name), url: isMoodleFile(url) ? cleanFileUrl(url) : url });
  }
  return out;
}
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function dedupeFiles(files) {
  const seen = new Set();
  return files.filter((f) => f && f.url && !seen.has(f.url) && seen.add(f.url)).slice(0, 10);
}

// Assignment + quiz descriptions and attachments for some courses.
// Returns a Map keyed by "assign-<id>", "quiz-<id>" and "cm-<course module id>".
export async function activityDetails(ws, token, courseIds) {
  const map = new Map();
  if (!courseIds.length) return map;
  const params = Object.fromEntries(courseIds.map((id, i) => [`courseids[${i}]`, id]));
  const put = (keyA, cmid, name, intro, attachments) => {
    const files = dedupeFiles([
      ...(attachments || []).map((f) => ({ name: f.filename, url: cleanFileUrl(f.fileurl) })),
      ...linksIn(intro),
    ]);
    const d = { name, desc: htmlToText(intro), files, cmid };
    map.set(keyA, d);
    if (cmid) map.set(`cm-${cmid}`, d);
  };
  try {
    const r = await ws(token, 'mod_assign_get_assignments', params);
    for (const c of r.courses || []) for (const a of c.assignments || []) put(`assign-${a.id}`, a.cmid, a.name, a.intro, a.introattachments);
  } catch (e) { console.error('assign details', e.message); }
  try {
    const r = await ws(token, 'mod_quiz_get_quizzes_by_courses', params);
    for (const q of r.quizzes || []) put(`quiz-${q.id}`, q.coursemodule, q.name, q.intro, q.introfiles);
  } catch (e) { console.error('quiz details', e.message); }
  return map;
}

export const cmidFromUrl = (u) => Number((u || '').match(/[?&]id=(\d+)/)?.[1]) || null;
