// POST /api/sync             → check Moodle now (you: just your account; scheduler: everyone,
//                                then the 6pm "due tomorrow" reminder once it's 6pm or later)
// POST /api/sync?mode=remind → only the reminder (scheduler only)
// POST /api/sync?force=1     → scheduler: run even if another run happened in the last ~2 hours
import { waitUntil } from '@vercel/functions';
import {
  redis, K, getState, putState, mergeState, getProfile, saveProfile, currentUser, isCron,
  decrypt, sendPush, ymd, addDays, dueLabel, TZ,
} from './_lib.js';
import { diffWithMoodle } from './_moodle.js';
import { diffLessonPlans, LP_VERSION } from './_lessons.js';

const ICONS = { homework: '📄', reading: '📖', essay: '✍️', lab: '🧪', project: '🛠️', quiz: '❓', test: '🚨' };
const CRON_LOCK = 'hw:cron:last';
const CRON_GAP_MIN = 100; // a bit under 2 hours, so a slightly early run still counts

// Everyone, a few at a time: one person's sync takes ~15-20 seconds and a run must finish
// within Vercel's 5-minute limit. 3 at a time keeps the load on the school's Moodle gentle.
// A problem with one person never blocks the rest.
const PARALLEL = 3;
async function runAll(mode) {
  const users = (await redis.smembers(K.users)) || [];
  const results = [];
  const queue = [...users];
  const worker = async () => {
    for (let uid; (uid = queue.shift()); ) {
      const r = {};
      try { if (mode === 'sync') r.sync = await syncUser(uid, { notify: true }); }
      catch (e) { r.sync = { error: String(e.message || e) }; }
      try { r.remind = await remindUser(uid); } // does nothing before 6pm or if already sent today
      catch (e) { r.remind = { error: String(e.message || e) }; }
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, users.length) }, worker));
  return { users: users.length, results };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const mode = req.query.mode === 'remind' ? 'remind' : 'sync';

  if (isCron(req)) {
    // Two schedulers call this (cron-job.org, with GitHub Actions as a backup). Only the first
    // call in each ~2-hour window does anything, so they never double-check or double-notify.
    if (mode === 'sync') {
      const fresh = await redis.set(CRON_LOCK, Date.now(), { nx: true, ex: CRON_GAP_MIN * 60 });
      if (!fresh && !req.query.force) return res.status(200).json({ ok: true, skipped: 'checked recently' });
      if (!fresh) await redis.set(CRON_LOCK, Date.now(), { ex: CRON_GAP_MIN * 60 });
    }
    // Reply right away and keep working in the background: checking everyone takes longer than
    // cron-job.org waits for an answer (30 seconds).
    waitUntil(runAll(mode).then((r) => console.log('scheduled run', mode, JSON.stringify(r))));
    return res.status(202).json({ ok: true, started: mode });
  }

  const uid = await currentUser(req);
  if (!uid) return res.status(401).json({ error: 'login' });
  if (mode !== 'sync') return res.status(403).json({ error: 'not allowed' });
  try {
    res.json({ ok: true, ...(await syncUser(uid, { notify: false })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

export async function syncUser(uid, { notify }) {
  const profile = await getProfile(uid);
  if (!profile?.moodle?.tokenEnc) return { skipped: 'no moodle' };
  const token = decrypt(profile.moodle.tokenEnc);

  let diff;
  try {
    const before = await getState(uid);
    diff = await diffWithMoodle(before, token);
    // Lesson plans see the classes the timeline just created, so colors don't collide.
    const withTimeline = mergeState(before, { classes: diff.changedClasses, tasks: diff.changedTasks });
    withTimeline.meta = before.meta;
    try {
      const lp = await diffLessonPlans(withTimeline, token, profile.moodle.userid);
      diff.changedClasses.push(...lp.changedClasses);
      diff.changedTasks.push(...lp.changedTasks);
      diff.newTasks.push(...lp.newTasks);
      diff.lpSeen = lp.lpSeen;
      diff.lpAssign = lp.lpAssign;
    } catch (e) {
      console.error('lesson plans failed', e); // never let this block the regular Moodle sync
    }
  } catch (e) {
    const s = await getState(uid);
    const msg = /invalid|token/i.test(e.message) ? 'Your Moodle key stopped working. Reconnect it in Settings.' : String(e.message || e);
    s.meta = { ...s.meta, lastError: msg, lastErrorAt: Date.now() };
    await putState(uid, s);
    throw e;
  }
  const { changedClasses, changedTasks, newTasks, eventCount } = diff;

  // re-read right before writing so we don't clobber edits made while Moodle was loading
  const fresh = await getState(uid);
  const merged = mergeState(fresh, { classes: changedClasses, tasks: changedTasks });
  const firstSync = !fresh.meta.lastSync;
  merged.meta = {
    ...fresh.meta, lastSync: Date.now(), lastError: null, lastCount: eventCount,
    ...(diff.lpSeen ? { lpSeen: diff.lpSeen, lpAssign: diff.lpAssign, lpInitialized: true, lpVersion: LP_VERSION } : {}),
  };
  await putState(uid, merged);

  // don't spam on the very first sync, when *everything* is new
  if (notify && newTasks.length && !firstSync) {
    const className = (id) => merged.classes.find((c) => c.id === id)?.name || 'Moodle';
    if (newTasks.length === 1) {
      const t = newTasks[0];
      await sendPush(uid, { title: `New in ${className(t.classId)}`, body: `${ICONS[t.tag] || ''} ${t.title} — due ${dueLabel(t.due)}`, url: '/', tag: 'new' });
    } else {
      const lines = newTasks.slice(0, 4).map((t) => `${className(t.classId)}: ${t.title} (${dueLabel(t.due)})`);
      if (newTasks.length > 4) lines.push(`+${newTasks.length - 4} more`);
      await sendPush(uid, { title: `${newTasks.length} new assignments`, body: lines.join('\n'), url: '/', tag: 'new' });
    }
  }
  return { checked: eventCount, changed: changedTasks.length, added: newTasks.length };
}

const REMIND_HOUR = 18; // 6pm school time

async function remindUser(uid) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hour < REMIND_HOUR) return { skipped: `too early (${hour}:00)` };
  const s = await getState(uid);
  const today = ymd(new Date());
  if (s.meta.lastRemind === today) return { skipped: 'already sent today' };
  const tomorrow = addDays(today, 1);
  const liveClass = new Set(s.classes.filter((c) => !c.deleted).map((c) => c.id));
  const live = s.tasks.filter((t) => !t.deleted && !t.done && liveClass.has(t.classId));
  const dueTomorrow = live.filter((t) => t.due === tomorrow);
  const overdue = live.filter((t) => t.due && t.due < today);
  const className = (id) => s.classes.find((c) => c.id === id)?.name || '';

  let sent = 0;
  if (dueTomorrow.length || overdue.length) {
    const lines = dueTomorrow.slice(0, 5).map((t) => `${ICONS[t.tag] || '📄'} ${className(t.classId)}: ${t.title}`);
    if (dueTomorrow.length > 5) lines.push(`+${dueTomorrow.length - 5} more`);
    if (overdue.length) lines.push(`⚠️ ${overdue.length} overdue`);
    sent = await sendPush(uid, {
      title: dueTomorrow.length ? `${dueTomorrow.length} due tomorrow` : 'Overdue homework',
      body: lines.join('\n'), url: '/', tag: 'remind',
    });
  }
  s.meta = { ...s.meta, lastRemind: today };
  await putState(uid, s);
  return { dueTomorrow: dueTomorrow.length, overdue: overdue.length, sent };
}
