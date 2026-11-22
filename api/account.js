// PUT    /api/account { name?, schedule? } → change your name or school schedule ("log your own" accounts)
// DELETE /api/account → permanently delete your account and all your data
import { requireUser, deleteUser, endSession, getProfile, saveProfile } from './_lib.js';
import { cleanName } from './_passkey.js';

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
  const on = Array.isArray(s.on) ? [...new Set(s.on.filter((d) => DATE.test(d)))].sort().slice(-300) : [];
  const base = { off, on };
  if (s.type === 'daily') return { type: 'daily', ...base };
  if (s.type === 'school') {
    if (!/^[a-z0-9-]{1,40}$/.test(s.school || '')) return null;
    return { type: 'school', school: s.school, ...base };
  }
  if (s.type === 'weekday') {
    const days = {};
    for (const d of ['1', '2', '3', '4', '5']) days[d] = label(s.days?.[d]);
    return { type: 'weekday', days, ...base };
  }
  if (s.type === 'rotation') {
    const labels = (Array.isArray(s.labels) ? s.labels : []).map(label).filter(Boolean).slice(0, 2);
    if (labels.length !== 2 || labels[0] === labels[1] || !DATE.test(s.anchor || '')) return null;
    return { type: 'rotation', labels, anchor: s.anchor, ...base };
  }
  return null;
}
