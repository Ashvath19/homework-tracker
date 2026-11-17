// GET  /api/state → your classes + homework
// PUT  /api/state → merge this device's changes in, returns the merged result
import { getState, putState, mergeState, requireUser } from './_lib.js';

export default async function handler(req, res) {
  const uid = await requireUser(req, res);
  if (!uid) return;
  if (req.method === 'GET') return res.json(await getState(uid));
  if (req.method === 'PUT') {
    const body = req.body || {};
    if (!Array.isArray(body.classes) || !Array.isArray(body.tasks)) return res.status(400).json({ error: 'bad state' });
    if (JSON.stringify(body).length > 900_000) return res.status(413).json({ error: 'too much data' });
    const cur = await getState(uid);
    const merged = mergeState(cur, { classes: body.classes, tasks: body.tasks });
    merged.meta = cur.meta;
    await putState(uid, merged);
    return res.json(merged);
  }
  res.status(405).end();
}
