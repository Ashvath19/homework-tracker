// GET    /api/session → who am I? (+ public push key)
// DELETE /api/session → log out of this device
import { currentUser, getProfile, endSession, ymd } from './_lib.js';
import { dayLetter, nextClassDay } from './_lessons.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const uid = await currentUser(req);
    const p = uid ? await getProfile(uid) : null;
    return res.json({
      authed: !!p,
      user: p ? { id: uid, name: p.name } : null,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
      school: schoolDays(),
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
  return { today, letter: dayLetter(today), nextA: nextClassDay(today, 'A'), nextB: nextClassDay(today, 'B') };
}
