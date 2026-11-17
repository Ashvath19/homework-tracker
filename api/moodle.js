// POST   /api/moodle { token } → check the key works, save it (encrypted), and do a first sync
// DELETE /api/moodle           → forget your key (your homework list stays)
import { requireUser, getProfile, saveProfile, encrypt } from './_lib.js';
import { ws, MOODLE_BASE } from './_moodle.js';
import { syncUser } from './sync.js';

export default async function handler(req, res) {
  const uid = await requireUser(req, res);
  if (!uid) return;
  const profile = await getProfile(uid);

  if (req.method === 'POST') {
    const token = String(req.body?.token || '').trim();
    if (!/^[a-zA-Z0-9]{20,64}$/.test(token)) return res.status(400).json({ error: "That doesn't look like a Moodle key. It should be a long string of letters and numbers." });
    let info;
    try {
      info = await ws(token, 'core_webservice_get_site_info');
    } catch {
      return res.status(400).json({ error: "Moodle didn't accept that key. Double-check you copied the whole thing." });
    }
    if (info.siteurl && info.siteurl.replace(/\/$/, '') !== MOODLE_BASE) {
      return res.status(400).json({ error: `That key is for ${info.siteurl}, not ${MOODLE_BASE}.` });
    }
    await saveProfile(uid, { ...profile, moodle: { tokenEnc: encrypt(token), name: info.fullname, userid: info.userid, connectedAt: Date.now() } });
    let result = {};
    try { result = await syncUser(uid, { notify: false }); } catch (e) { result = { error: e.message }; }
    return res.json({ ok: true, name: info.fullname, ...result });
  }

  if (req.method === 'DELETE') {
    const { moodle, ...rest } = profile || {};
    await saveProfile(uid, rest);
    return res.json({ ok: true });
  }
  res.status(405).end();
}
