// GET    /api/session → who am I? (+ public push key)
// DELETE /api/session → log out of this device
import { currentUser, getProfile, endSession } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const uid = await currentUser(req);
    const p = uid ? await getProfile(uid) : null;
    return res.json({
      authed: !!p,
      user: p ? { id: uid, email: p.email, name: p.name, picture: p.picture } : null,
      moodle: p?.moodle ? { connected: true, name: p.moodle.name } : { connected: false },
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    });
  }
  if (req.method === 'DELETE') {
    await endSession(req, res);
    return res.json({ ok: true });
  }
  res.status(405).end();
}
