// GET /api/file?u=<moodle file address> → streams a Moodle file using *your* Moodle key,
// so handouts open without logging in to learn.vcs.net. Only Moodle file addresses are allowed.
import { Readable } from 'node:stream';
import { requireUser, getProfile, decrypt } from './_lib.js';
import { MOODLE_BASE } from './_moodle.js';

export default async function handler(req, res) {
  const uid = await requireUser(req, res);
  if (!uid) return;
  let url;
  try { url = new URL(String(req.query.u || '')); } catch { return res.status(400).send('Bad file address'); }
  if (url.origin !== new URL(MOODLE_BASE).origin || !/^\/(webservice\/)?pluginfile\.php\//.test(url.pathname)) {
    return res.status(400).send('Only Moodle files can be opened here');
  }
  const profile = await getProfile(uid);
  if (!profile?.moodle?.tokenEnc) return res.status(401).send('Log in again');

  url.pathname = url.pathname.replace(/^\/pluginfile\.php/, '/webservice/pluginfile.php');
  url.searchParams.set('token', decrypt(profile.moodle.tokenEnc));
  url.searchParams.delete('forcedownload');

  const r = await fetch(url);
  if (!r.ok || (r.headers.get('content-type') || '').includes('application/json')) {
    return res.status(404).send("Moodle wouldn't share that file. It may have been removed.");
  }
  const name = decodeURIComponent(url.pathname.split('/').pop() || 'file');
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  if (r.headers.get('content-length')) res.setHeader('Content-Length', r.headers.get('content-length'));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, max-age=600');
  Readable.fromWeb(r.body).pipe(res);
}
