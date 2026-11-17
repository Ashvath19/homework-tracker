// POST   /api/push           → save this device's push subscription
// POST   /api/push?test=1    → send a test notification to every device
// DELETE /api/push           → remove { endpoint }
import { requireAuth, addSubscription, removeSubscription, sendPush } from './_lib.js';

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method === 'POST' && req.query.test) {
    const sent = await sendPush({ title: 'Homework Tracker', body: 'Notifications are working 🎉', url: '/' });
    return res.json({ ok: true, sent });
  }
  if (req.method === 'POST') {
    const sub = req.body;
    if (!sub?.endpoint || !sub?.keys) return res.status(400).json({ error: 'bad subscription' });
    await addSubscription(sub);
    return res.json({ ok: true });
  }
  if (req.method === 'DELETE') {
    if (req.body?.endpoint) await removeSubscription(req.body.endpoint);
    return res.json({ ok: true });
  }
  res.status(405).end();
}
