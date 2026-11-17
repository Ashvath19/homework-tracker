// Shared server helpers. Files starting with "_" are not turned into API routes by Vercel.
import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';
import webpush from 'web-push';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const STATE_KEY = 'hw:state';
const SUBS_KEY = 'hw:subs';
export const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
export const COLORS = ['#e5484d', '#f76b15', '#e2a336', '#30a46c', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];

// ---------- state ----------
export async function getState() {
  const s = await redis.get(STATE_KEY);
  return { classes: s?.classes || [], tasks: s?.tasks || [], meta: s?.meta || {} };
}
export async function putState(s) {
  // forget deleted items after 90 days so the data doesn't grow forever
  const cutoff = Date.now() - 90 * 86400000;
  const keep = (x) => !(x.deleted && (x.updatedAt || 0) < cutoff);
  await redis.set(STATE_KEY, { classes: s.classes.filter(keep), tasks: s.tasks.filter(keep), meta: s.meta || {} });
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

// ---------- auth ----------
const sessionValue = () =>
  crypto.createHmac('sha256', process.env.APP_PASSWORD || '').update('hw-session-v1').digest('hex');

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function checkPassword(pw) {
  return !!process.env.APP_PASSWORD && safeEq(pw || '', process.env.APP_PASSWORD);
}
export function isAuthed(req) {
  const c = req.cookies?.hw_session;
  if (process.env.APP_PASSWORD && c && safeEq(c, sessionValue())) return true;
  const auth = req.headers.authorization || '';
  return !!process.env.CRON_SECRET && safeEq(auth, `Bearer ${process.env.CRON_SECRET}`);
}
export function setSession(res, on = true) {
  res.setHeader('Set-Cookie', on
    ? `hw_session=${sessionValue()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
    : 'hw_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
export function requireAuth(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (isAuthed(req)) return true;
  res.status(401).json({ error: 'login' });
  return false;
}

// ---------- push notifications ----------
const subKey = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 24);

export async function addSubscription(sub) {
  await redis.hset(SUBS_KEY, { [subKey(sub.endpoint)]: JSON.stringify(sub) });
}
export async function removeSubscription(endpoint) {
  await redis.hdel(SUBS_KEY, subKey(endpoint));
}
export async function sendPush(payload) {
  if (!process.env.VAPID_PRIVATE_KEY) return 0;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:homework-tracker@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  const subs = (await redis.hgetall(SUBS_KEY)) || {};
  let sent = 0;
  await Promise.all(Object.entries(subs).map(async ([k, raw]) => {
    const sub = typeof raw === 'string' ? JSON.parse(raw) : raw;
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await redis.hdel(SUBS_KEY, k); // device unsubscribed
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
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
export function dueLabel(due) {
  if (!due) return 'no due date';
  const today = ymd(new Date());
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  const [y, m, d] = due.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}
