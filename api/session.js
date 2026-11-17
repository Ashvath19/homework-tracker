// GET    /api/session → am I logged in? (+ the public push key)
// POST   /api/session → log in with { password }
// DELETE /api/session → log out
import { isAuthed, checkPassword, setSession, redis } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.json({ authed: isAuthed(req), vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null });
  }
  if (req.method === 'POST') {
    // slow down password guessing: 10 wrong tries per hour
    const key = `hw:loginfail:${new Date().toISOString().slice(0, 13)}`;
    const fails = Number(await redis.get(key)) || 0;
    if (fails >= 10) return res.status(429).json({ error: 'Too many tries. Wait an hour.' });
    if (!checkPassword(req.body?.password)) {
      await redis.incr(key);
      await redis.expire(key, 3600);
      return res.status(401).json({ error: 'Wrong password' });
    }
    setSession(res, true);
    return res.json({ ok: true });
  }
  if (req.method === 'DELETE') {
    setSession(res, false);
    return res.json({ ok: true });
  }
  res.status(405).end();
}
