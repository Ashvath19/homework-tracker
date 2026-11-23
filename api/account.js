// PUT    /api/account { name?, schedule? } → change the name the site calls you (null = back to your Moodle name),
//                                           or your school schedule ("log your own" accounts)
// PUT    /api/account { feed: link | null } → connect (or disconnect) a Canvas or Schoology calendar link
// DELETE /api/account → permanently delete your account and all your data
import crypto from 'node:crypto';
import { redis, K, requireUser, deleteUser, endSession, startSession, sessionFp, getProfile, saveProfile, getState, putState, tooManyFailures, encrypt, fingerprint } from './_lib.js';
import { cleanName } from './_passkey.js';
import { connectFeed, feedKindOf, feedKinds, FEEDS, feedInfo, cleanFeedUrl, fetchFeed } from './_feeds.js';
import { syncUser } from './sync.js';

export default async function handler(req, res) {
  const uid = await requireUser(req, res);
  if (!uid) return;
  if (req.method === 'PUT') {
    const p = await getProfile(uid);
    const body = req.body || {};
    if (body.name !== undefined) {
      // Moodle accounts can go back to their Moodle name by sending null.
      if (body.name === null && p.moodle) {
        p.name = p.moodle.fullname || p.name;
        delete p.nameSet;
      } else {
        const name = cleanName(body.name);
        if (!name) return res.status(400).json({ error: 'Type a name.' });
        p.name = name;
        p.nameSet = true; // logging in with Moodle again keeps the name you picked
      }
    }
    if (body.schedule !== undefined) {
      if (p.moodle) return res.status(400).json({ error: 'Your schedule comes from the VCS calendar.' });
      const s = cleanSchedule(body.schedule);
      if (!s) return res.status(400).json({ error: "That schedule doesn't look right." });
      p.schedule = s;
    }
    // Schoology class calendars: { sgyClass: link, name? } adds one; { sgyClassRemove: key } removes one.
    if (body.sgyClass !== undefined || body.sgyClassRemove !== undefined) {
      if (!p.schoology) return res.status(400).json({ error: 'Connect your Schoology calendar first.' });
      const list = p.schoologyClasses || [];
      if (body.sgyClassRemove !== undefined) {
        p.schoologyClasses = list.filter((c) => c.key !== String(body.sgyClassRemove));
      } else {
        const limit = await tooManyFailures(req, 'canvas', 20);
        if (limit.blocked) return res.status(429).json({ error: 'Too many tries. Wait an hour and try again.' });
        const link = cleanFeedUrl('schoology', body.sgyClass);
        if (!link) { await limit.record(); return res.status(400).json({ error: "That isn't a Schoology calendar link. Copy it from the class calendar's Export in Schoology; it ends in .ics." }); }
        const key = fingerprint(link.url).slice(0, 12);
        if (key === p.schoology.fp?.slice(0, 12)) return res.status(400).json({ error: "That's your main Schoology calendar. Use a single class's calendar link here." });
        if (list.some((c) => c.key === key)) return res.status(400).json({ error: 'That class calendar is already added.' });
        if (list.length >= 15) return res.status(400).json({ error: 'You can add up to 15 class calendars.' });
        let cal;
        try { cal = await fetchFeed('schoology', link.url); } catch {
          await limit.record();
          return res.status(400).json({ error: "Schoology didn't accept that link. Copy it again from the class calendar's Export." });
        }
        const name = cleanName(body.name) || cal.name || `Class ${list.length + 1}`;
        p.schoologyClasses = [...list, { key, name, feedEnc: encrypt(link.url), addedAt: Date.now() }];
      }
      await saveProfile(uid, p);
      let sync = {};
      try { sync = await syncUser(uid, { notify: false }); } catch (e) { sync = { syncError: e.message }; }
      return res.json({ ok: true, feed: feedInfo(p), ...sync });
    }
    const feedLink = body.feed !== undefined ? body.feed : body.canvas;
    if (feedLink !== undefined) {
      if (p.moodle) return res.status(400).json({ error: 'Your homework already comes from Moodle.' });
      const current = feedKinds.find((k) => p[k]);
      if (feedLink === null) {
        if (!current) return res.json({ ok: true, feed: null });
        if (!p.passkeys?.length) return res.status(400).json({ error: `Add a passkey first. ${FEEDS[current].name} is how you log in, so you'd be locked out.` });
        await redis.del(K.feed(current, p[current].fp));
        delete p[current];
        // Anyone who logged in with the old link gets logged out; this device stays in.
        p.own = { ...p.own, fp: crypto.randomBytes(10).toString('hex') };
        await saveProfile(uid, p);
        await startSession(res, uid, sessionFp(p));
        const s = await getState(uid);
        s.meta = { ...s.meta, lastSync: null, lastError: null, lastCount: null };
        await putState(uid, s);
        return res.json({ ok: true, feed: null });
      }
      const limit = await tooManyFailures(req, 'canvas', 20);
      if (limit.blocked) return res.status(429).json({ error: 'Too many tries. Wait an hour and try again.' });
      const kind = feedKindOf(feedLink) || (body.kind === 'schoology' ? 'schoology' : 'canvas');
      const replacing = current === kind;
      const r = await connectFeed(kind, feedLink, uid);
      if (r.error) { await limit.record(); return res.status(400).json({ error: r.error }); }
      if (replacing) { // a new link: log out anyone who got in with the old one
        r.profile.own = { ...r.profile.own, fp: crypto.randomBytes(10).toString('hex') };
        await saveProfile(uid, r.profile);
        await startSession(res, uid, sessionFp(r.profile));
      }
      let sync = {};
      try { sync = await syncUser(uid, { notify: false }); } catch (e) { sync = { syncError: e.message }; }
      return res.json({ ok: true, feed: feedInfo(r.profile), ...sync });
    }
    await saveProfile(uid, p);
    return res.json({ ok: true, name: p.name, nameSet: !!p.nameSet, schedule: p.schedule || null });
  }
  if (req.method !== 'DELETE') return res.status(405).end();
  await deleteUser(uid);
  await endSession(req, res);
  res.json({ ok: true });
}

// Only keep the fields the app understands, with sane sizes.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const label = (x) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);
function cleanSchedule(s) {
  if (!s || typeof s !== 'object') return null;
  const off = Array.isArray(s.off) ? [...new Set(s.off.filter((d) => DATE.test(d)))].sort().slice(-300) : [];
  if (s.type === 'school') {
    if (!/^[a-z0-9-]{1,40}$/.test(s.school || '')) return null;
    // the student's own pattern, for schools whose weekly pattern isn't built in (or to say which rotation day today is)
    const pattern = s.pattern ? cleanPattern(s.pattern) : null;
    if (s.pattern && !pattern) return null;
    return { type: 'school', school: s.school, off, ...(pattern ? { pattern } : {}) };
  }
  const p = cleanPattern(s);
  return p && { ...p, off };
}
function cleanPattern(s) {
  if (s.type === 'daily') return { type: 'daily' };
  if (s.type === 'weekday') {
    const days = {};
    for (const d of ['1', '2', '3', '4', '5']) days[d] = label(s.days?.[d]);
    return { type: 'weekday', days };
  }
  if (s.type === 'rotation') {
    const labels = (Array.isArray(s.labels) ? s.labels : []).map(label).filter(Boolean).slice(0, 2);
    if (labels.length !== 2 || labels[0] === labels[1] || !DATE.test(s.anchor || '')) return null;
    return { type: 'rotation', labels, anchor: s.anchor };
  }
  return null;
}
