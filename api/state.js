// GET  /api/state → all classes + homework
// PUT  /api/state → merge this device's changes in, returns the merged result
import { getState, putState, mergeState, requireAuth } from './_lib.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method === 'GET') return res.json(await getState());
  if (req.method === 'PUT') {
    const body = req.body || {};
    if (!Array.isArray(body.classes) || !Array.isArray(body.tasks)) return res.status(400).json({ error: 'bad state' });
    const cur = await getState();
    const merged = mergeState(cur, { classes: body.classes, tasks: body.tasks });
    merged.meta = cur.meta;
    await putState(merged);
    return res.json(merged);
  }
  res.status(405).end();
}
