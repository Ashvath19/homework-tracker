// POST /api/link → make a 6-digit code for logging in on another device (good for 10 minutes)
import crypto from 'node:crypto';
import { redis, K, requireUser } from './_lib.js';

export default async function handler(req, res) {
  const uid = await requireUser(req, res);
  if (!uid) return;
  if (req.method !== 'POST') return res.status(405).end();
  for (let i = 0; i < 5; i++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const ok = await redis.set(K.link(code), uid, { ex: 600, nx: true }); // nx: never reuse a live code
    if (ok) return res.json({ code, expiresAt: Date.now() + 600_000 });
  }
  res.status(503).json({ error: 'Try again' });
}
