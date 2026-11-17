// POST /api/moodle { token } → replace your Moodle key (e.g. after resetting it on Moodle).
// Other devices get logged out, since they were logged in with the old key.
import { requireUser, startSession } from './_lib.js';
import { connectKey } from './login.js';
import { syncUser } from './sync.js';

export default async function handler(req, res) {
  const uid = await requireUser(req, res);
  if (!uid) return;
  if (req.method !== 'POST') return res.status(405).end();
  const result = await connectKey(String(req.body?.token || '').trim(), uid);
  if (result.error) return res.status(400).json({ error: result.error });
  await startSession(res, uid, result.fp); // keep *this* device logged in
  let sync = {};
  try { sync = await syncUser(uid, { notify: false }); } catch (e) { sync = { syncError: e.message }; }
  res.json({ ok: true, name: result.name, ...sync });
}
