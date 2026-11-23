// GET    /api/session → who am I? (+ public push key)
// DELETE /api/session → log out of this device
import { currentUser, getProfile, endSession, ymd } from './_lib.js';
import { dayLetter, nextClassDay } from './_lessons.js';
import SCHOOL from './_schoolDays.json' with { type: 'json' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const uid = await currentUser(req);
    const p = uid ? await getProfile(uid) : null;
    return res.json({
      authed: !!p,
      user: p ? {
        id: uid, name: p.name, kind: p.moodle ? 'moodle' : 'own', passkeys: (p.passkeys || []).length,
        canvas: !p.moodle && p.canvas ? { host: p.canvas.host, name: p.canvas.name || '' } : null,
      } : null,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
      // VCS's A/B calendar is only for VCS (Moodle) accounts. "Log your own" accounts use their own schedule.
      school: !p || p.moodle ? schoolDays() : null,
      schedule: p && !p.moodle ? p.schedule || null : null,
    });
  }
  if (req.method === 'DELETE') {
    await endSession(req, res);
    return res.json({ ok: true });
  }
  res.status(405).end();
}

// Today's A/B/C letter plus the next A day and B day, for the dashboard header.
function schoolDays() {
  const today = ymd(new Date());
  return { today, letter: dayLetter(today), nextA: nextClassDay(today, 'A'), nextB: nextClassDay(today, 'B'), days: SCHOOL.days };
}
