// DELETE /api/account → permanently delete your account and all your data
import { requireUser, deleteUser, endSession } from './_lib.js';

export default async function handler(req, res) {
  const uid = await requireUser(req, res);
  if (!uid) return;
  if (req.method !== 'DELETE') return res.status(405).end();
  await deleteUser(uid);
  await endSession(req, res);
  res.json({ ok: true });
}
