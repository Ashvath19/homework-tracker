// POST /api/sync             → check Moodle for new/changed homework (runs hourly)
// POST /api/sync?mode=remind → send the evening "due tomorrow" notification
import { getState, putState, mergeState, requireAuth, sendPush, ymd, addDays, dueLabel } from './_lib.js';
import { diffWithMoodle } from './_moodle.js';

const ICONS = { homework: '📄', reading: '📖', essay: '✍️', lab: '🧪', project: '🛠️', quiz: '❓', test: '🚨' };

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  const mode = req.query.mode === 'remind' ? 'remind' : 'sync';
  try {
    const result = mode === 'remind' ? await remind() : await sync();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    if (mode === 'sync') {
      const s = await getState();
      s.meta = { ...s.meta, lastError: String(e.message || e), lastErrorAt: Date.now() };
      await putState(s);
    }
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

async function sync() {
  const before = await getState();
  const { changedClasses, changedTasks, newTasks, eventCount } = await diffWithMoodle(before);

  // re-read right before writing so we don't clobber edits made while Moodle was loading
  const fresh = await getState();
  const merged = mergeState(fresh, { classes: changedClasses, tasks: changedTasks });
  const firstSync = !fresh.meta.lastSync;
  merged.meta = { ...fresh.meta, lastSync: Date.now(), lastError: null, lastCount: eventCount };
  await putState(merged);

  // don't spam on the very first sync, when *everything* is new
  if (newTasks.length && !firstSync) {
    const className = (id) => merged.classes.find((c) => c.id === id)?.name || 'Moodle';
    if (newTasks.length === 1) {
      const t = newTasks[0];
      await sendPush({ title: `New in ${className(t.classId)}`, body: `${ICONS[t.tag] || ''} ${t.title} — due ${dueLabel(t.due)}`, url: '/', tag: 'new' });
    } else {
      const lines = newTasks.slice(0, 4).map((t) => `${className(t.classId)}: ${t.title} (${dueLabel(t.due)})`);
      if (newTasks.length > 4) lines.push(`+${newTasks.length - 4} more`);
      await sendPush({ title: `${newTasks.length} new assignments`, body: lines.join('\n'), url: '/', tag: 'new' });
    }
  }
  return { checked: eventCount, changed: changedTasks.length, added: newTasks.length };
}

async function remind() {
  const s = await getState();
  const today = ymd(new Date());
  if (s.meta.lastRemind === today) return { skipped: 'already sent today' };
  const tomorrow = addDays(today, 1);
  const live = s.tasks.filter((t) => !t.deleted && !t.done);
  const dueTomorrow = live.filter((t) => t.due === tomorrow);
  const overdue = live.filter((t) => t.due && t.due < today);
  const className = (id) => s.classes.find((c) => c.id === id)?.name || '';

  let sent = 0;
  if (dueTomorrow.length || overdue.length) {
    const lines = dueTomorrow.slice(0, 5).map((t) => `${ICONS[t.tag] || '📄'} ${className(t.classId)}: ${t.title}`);
    if (dueTomorrow.length > 5) lines.push(`+${dueTomorrow.length - 5} more`);
    if (overdue.length) lines.push(`⚠️ ${overdue.length} overdue`);
    sent = await sendPush({
      title: dueTomorrow.length ? `${dueTomorrow.length} due tomorrow` : 'Overdue homework',
      body: lines.join('\n'), url: '/', tag: 'remind',
    });
  }
  s.meta = { ...s.meta, lastRemind: today };
  await putState(s);
  return { dueTomorrow: dueTomorrow.length, overdue: overdue.length, sent };
}
