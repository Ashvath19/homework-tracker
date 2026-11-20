// Shared server helpers. Files starting with "_" are not turned into API routes by Vercel.
import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';
import webpush from 'web-push';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

// Every person's data lives under their own key prefix.
export const K = {
  users: 'hw:users',                         // set of all user ids
  profile: (u) => `hw:u:${u}:profile`,       // { name, moodle: { tokenEnc, fp, userid, invalid } }
  state: (u) => `hw:u:${u}:state`,           // { classes, tasks, meta }
  subs: (u) => `hw:u:${u}:subs`,             // push subscriptions (one per device)
  session: (s) => `hw:sess:${s}`,            // session id → { uid, fp }
  link: (c) => `hw:link:${c}`,               // 6-digit phone login code → user id
};
export const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
export const COLORS = ['#e5484d', '#f76b15', '#e2a336', '#30a46c', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];


// ---------- homework state ----------
export async function getState(uid) {
  const s = await redis.get(K.state(uid));
  return { classes: s?.classes || [], tasks: s?.tasks || [], meta: s?.meta || {} };
}
export async function putState(uid, s) {
  // forget deleted items after 90 days so the data doesn't grow forever
  const cutoff = Date.now() - 90 * 86400000;
  const keep = (x) => !(x.deleted && (x.updatedAt || 0) < cutoff);
  await redis.set(K.state(uid), { classes: s.classes.filter(keep), tasks: s.tasks.filter(keep), meta: s.meta || {} });
}

// Last-write-wins merge by id, using each item's updatedAt. Deleted items stay as
// { deleted: true } "tombstones" so a stale device can't bring them back.
export function mergeState(a, b) {
  const list = (x = [], y = []) => {
    const m = new Map();
    for (const it of [...x, ...y]) {
      if (!it || typeof it.id !== 'string') continue;
      const cur = m.get(it.id);
      if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) m.set(it.id, it);
    }
    return [...m.values()];
  };
  return { classes: list(a.classes, b.classes), tasks: list(a.tasks, b.tasks), meta: a.meta || {} };
}

// ---------- profiles ----------
export async function getProfile(uid) {
  return (await redis.get(K.profile(uid))) || null;
}
export async function saveProfile(uid, p) {
  await redis.set(K.profile(uid), p);
}
export async function deleteUser(uid) {
  await redis.del(K.profile(uid), K.state(uid), K.subs(uid));
  await redis.srem(K.users, uid);
}

// ---------- sessions ----------
const COOKIE = 'hw_sid';
const SESSION_DAYS = 180;

// fp = fingerprint of the Moodle key at login time. When you reset your key on Moodle and
// log in with the new one, every session made with the old key stops working.
export const fingerprint = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 20);

export async function startSession(res, uid, fp) {
  const sid = crypto.randomBytes(32).toString('base64url');
  await redis.set(K.session(sid), { uid, fp }, { ex: SESSION_DAYS * 86400 });
  res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
export async function endSession(req, res) {
  const sid = req.cookies?.[COOKIE];
  if (sid) await redis.del(K.session(sid));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
export async function currentUser(req) {
  const sid = req.cookies?.[COOKIE];
  if (!sid || !/^[\w-]{20,}$/.test(sid)) return null;
  const sess = await redis.get(K.session(sid));
  if (!sess?.uid) return null;
  const profile = await getProfile(sess.uid);
  if (!profile?.moodle || profile.moodle.fp !== sess.fp) return null; // key was replaced, or account deleted
  return sess.uid;
}

// Simple per-IP limit on failed attempts (login keys, phone codes).
export async function tooManyFailures(req, bucket, max) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const key = `hw:fail:${bucket}:${ip}:${new Date().toISOString().slice(0, 13)}`;
  return { blocked: (Number(await redis.get(key)) || 0) >= max, async record() { await redis.incr(key); await redis.expire(key, 3600); } };
}
// Returns the signed-in user's id, or sends 401 and returns null.
export async function requireUser(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const uid = await currentUser(req);
  if (!uid) res.status(401).json({ error: 'login' });
  return uid;
}

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Schedulers prove themselves with a secret: CRON_SECRET for the GitHub backup, CRONJOB_SECRET
// for cron-job.org. Separate secrets, so either one can be replaced without touching the other.
export function isCron(req) {
  const auth = req.headers.authorization || '';
  return [process.env.CRON_SECRET, process.env.CRONJOB_SECRET]
    .some((s) => !!s && safeEq(auth, `Bearer ${s}`));
}

// ---------- encryption for Moodle keys (AES-256-GCM) ----------
function encKey() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k || k.length !== 64) throw new Error('ENCRYPTION_KEY must be 64 hex characters');
  return Buffer.from(k, 'hex');
}
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(blob) {
  const [iv, tag, ct] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ---------- push notifications ----------
const subKey = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 24);

export async function addSubscription(uid, sub) {
  await redis.hset(K.subs(uid), { [subKey(sub.endpoint)]: JSON.stringify(sub) });
}
export async function removeSubscription(uid, endpoint) {
  await redis.hdel(K.subs(uid), subKey(endpoint));
}
export async function sendPush(uid, payload) {
  if (!process.env.VAPID_PRIVATE_KEY) return 0;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:homework-tracker@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  const subs = (await redis.hgetall(K.subs(uid))) || {};
  let sent = 0;
  await Promise.all(Object.entries(subs).map(async ([k, raw]) => {
    const sub = typeof raw === 'string' ? JSON.parse(raw) : raw;
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await redis.hdel(K.subs(uid), k); // device unsubscribed
      else console.error('push failed', e.statusCode, e.body);
    }
  }));
  return sent;
}

// ---------- dates (in the school's time zone) ----------
export function ymd(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function addDays(ymdStr, n) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function dueLabel(due) {
  if (!due) return 'no due date';
  const today = ymd(new Date());
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  const [y, m, d] = due.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}
