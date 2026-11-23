// PUT    /api/account { name?, schedule? } → change your name or school schedule ("log your own" accounts)
// PUT    /api/account { canvas: link | null } → connect (or disconnect) a Canvas calendar feed
// DELETE /api/account → permanently delete your account and all your data
import { requireUser, deleteUser, endSession, getProfile, saveProfile, encrypt, getState, putState, tooManyFailures } from './_lib.js';
import { cleanName } from './_passkey.js';
import { cleanFeedUrl, fetchFeed } from './_canvas.js';
import { syncUser } from './sync.js';

export default async function handler(req, res) {
  const uid = await requireUser(req, res);
  if (!uid) return;
  if (req.method === 'PUT') {
    const p = await getProfile(uid);
    const body = req.body || {};
    if (body.name !== undefined) {
      if (p.moodle) return res.status(400).json({ error: 'Your name comes from Moodle.' });
      const name = cleanName(body.name);
      if (!name) return res.status(400).json({ error: 'Type a name.' });
      p.name = name;
    }
    if (body.schedule !== undefined) {
      if (p.moodle) return res.status(400).json({ error: 'Your schedule comes from the VCS calendar.' });
      const s = cleanSchedule(body.schedule);
      if (!s) return res.status(400).json({ error: "That schedule doesn't look right." });
      p.schedule = s;
    }
    if (body.canvas !== undefined) {
      if (p.moodle) return res.status(400).json({ error: 'Your homework already comes from Moodle.' });
      if (body.canvas === null) {
        delete p.canvas;
        await saveProfile(uid, p);
        const s = await getState(uid);
        s.meta = { ...s.meta, lastSync: null, lastError: null, lastCount: null };
        await putState(uid, s);
        return res.json({ ok: true, canvas: null });
      }
      const limit = await tooManyFailures(req, 'canvas', 20);
      if (limit.blocked) return res.status(429).json({ error: 'Too many tries. Wait an hour and try again.' });
      const feed = cleanFeedUrl(body.canvas);
      if (!feed) { await limit.record(); return res.status(400).json({ error: "That isn't a Canvas calendar feed link. It should start with https:// and end in .ics." }); }
      let cal;
      try { cal = await fetchFeed(feed.url); } catch {
        await limit.record();
        return res.status(400).json({ error: "Canvas didn't accept that link. Copy it again from Calendar Feed on Canvas." });
      }
      p.canvas = { feedEnc: encrypt(feed.url), host: feed.host, name: cal.name || '', connectedAt: Date.now() };
      await saveProfile(uid, p);
      let sync = {};
      try { sync = await syncUser(uid, { notify: false }); } catch (e) { sync = { syncError: e.message }; }
      return res.json({ ok: true, canvas: { host: feed.host, name: p.canvas.name }, ...sync });
    }
    await saveProfile(uid, p);
    return res.json({ ok: true, name: p.name, schedule: p.schedule || null });
  }
  if (req.method !== 'DELETE') return res.status(405).end();
  await deleteUser(uid);
  await endSession(req, res);
  res.json({ ok: true });
}

// Only keep the fields the app understands, with sane sizes.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const label = (x) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);
function cleanSchedule(s) {
  if (!s || typeof s !== 'object') return null;
  const off = Array.isArray(s.off) ? [...new Set(s.off.filter((d) => DATE.test(d)))].sort().slice(-300) : [];
  if (s.type === 'school') {
    if (!/^[a-z0-9-]{1,40}$/.test(s.school || '')) return null;
    // the student's own pattern, for schools whose weekly pattern isn't built in (or to say which rotation day today is)
    const pattern = s.pattern ? cleanPattern(s.pattern) : null;
    if (s.pattern && !pattern) return null;
    return { type: 'school', school: s.school, off, ...(pattern ? { pattern } : {}) };
  }
  const p = cleanPattern(s);
  return p && { ...p, off };
}
function cleanPattern(s) {
  if (s.type === 'daily') return { type: 'daily' };
  if (s.type === 'weekday') {
    const days = {};
    for (const d of ['1', '2', '3', '4', '5']) days[d] = label(s.days?.[d]);
    return { type: 'weekday', days };
  }
  if (s.type === 'rotation') {
    const labels = (Array.isArray(s.labels) ? s.labels : []).map(label).filter(Boolean).slice(0, 2);
    if (labels.length !== 2 || labels[0] === labels[1] || !DATE.test(s.anchor || '')) return null;
    return { type: 'rotation', labels, anchor: s.anchor };
  }
  return null;
}
