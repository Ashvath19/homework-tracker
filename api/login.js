// POST /api/login { token } → log in (or sign up) with your Moodle key
// POST /api/login { code }  → log in with a 6-digit code from a device you're already logged in on
import { redis, K, getProfile, saveProfile, startSession, encrypt, decrypt, fingerprint, tooManyFailures } from './_lib.js';
import { ws, MOODLE_BASE } from './_moodle.js';
import { syncUser } from './sync.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  const { token, code } = req.body || {};

  if (code != null) {
    const limit = await tooManyFailures(req, 'code', 10);
    if (limit.blocked) return res.status(429).json({ error: 'Too many wrong codes. Wait an hour and try again.' });
    const clean = String(code).replace(/\D/g, '');
    const uid = clean.length === 6 ? await redis.getdel(K.link(clean)) : null; // codes work once
    const profile = uid ? await getProfile(uid) : null;
    if (!profile?.moodle) {
      await limit.record();
      return res.status(400).json({ error: "That code didn't work. Codes expire after 10 minutes and only work once." });
    }
    await startSession(res, uid, profile.moodle.fp);
    return res.json({ ok: true });
  }

  const limit = await tooManyFailures(req, 'key', 20);
  if (limit.blocked) return res.status(429).json({ error: 'Too many tries. Wait an hour and try again.' });
  const result = await connectKey(String(token || '').trim());
  if (result.error) { await limit.record(); return res.status(400).json({ error: result.error }); }
  await startSession(res, result.uid, result.fp);

  let sync = {};
  try { sync = await syncUser(result.uid, { notify: false }); } catch (e) { sync = { syncError: e.message }; }
  res.json({ ok: true, name: result.name, ...sync });
}

// Checks a Moodle key with Moodle, then creates or updates that student's account.
// If `expectUid` is given (reconnecting), the key must belong to that same student.
export async function connectKey(token, expectUid) {
  if (!/^[a-zA-Z0-9]{20,64}$/.test(token)) {
    return { error: "That doesn't look like a Moodle key. It should be a long string of letters and numbers." };
  }
  let info;
  try {
    info = await ws(token, 'core_webservice_get_site_info');
  } catch {
    return { error: "Moodle didn't accept that key. Make sure you copied the whole thing." };
  }
  if (!info?.userid || (info.siteurl && info.siteurl.replace(/\/$/, '') !== MOODLE_BASE)) {
    return { error: `That key isn't for ${MOODLE_BASE}.` };
  }
  const uid = `m${info.userid}`;
  if (expectUid && uid !== expectUid) return { error: "That key belongs to a different Moodle account." };

  const fp = fingerprint(token);
  const existing = await getProfile(uid);
  // Logging in with the same key you already use keeps your other devices logged in.
  const sameKey = existing?.moodle?.tokenEnc && safeDecrypt(existing.moodle.tokenEnc) === token;
  await saveProfile(uid, {
    ...existing,
    name: info.fullname,
    createdAt: existing?.createdAt || Date.now(),
    moodle: { tokenEnc: sameKey ? existing.moodle.tokenEnc : encrypt(token), fp, userid: info.userid, connectedAt: Date.now() },
  });
  await redis.sadd(K.users, uid);
  return { uid, fp, name: info.fullname };
}

function safeDecrypt(blob) {
  try { return decrypt(blob); } catch { return null; }
}
