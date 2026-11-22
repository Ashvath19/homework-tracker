// Passkeys (Face ID / Touch ID / phone PIN) for "log your own" accounts, which have no Moodle key.
// The site only ever stores each passkey's public key, so there's no password to leak.
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { redis, K, getProfile, saveProfile, startSession, currentUser, sessionFp, tooManyFailures } from './_lib.js';

const RP_NAME = 'Homework';
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// Passkeys belong to one website address. Use the address the browser is actually on.
function site(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const rpID = process.env.PASSKEY_RP_ID || host.replace(/:\d+$/, '');
  const local = rpID === 'localhost' || rpID === '127.0.0.1';
  return { rpID, origin: `${local ? 'http' : 'https'}://${host}` };
}

// A short-lived "ticket" remembers the challenge between the two steps of each ceremony.
async function newTicket(data) {
  const ticket = crypto.randomBytes(18).toString('base64url');
  await redis.set(K.pkTicket(ticket), data, { ex: 300 });
  return ticket;
}
async function useTicket(ticket, mode) {
  if (typeof ticket !== 'string' || !/^[\w-]{20,40}$/.test(ticket)) return null;
  const t = await redis.getdel(K.pkTicket(ticket)); // tickets work once
  return t?.mode === mode ? t : null;
}

export const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);

const fail = (res, error, status = 400) => res.status(status).json({ error });

export async function handlePasskey(req, res, step) {
  const body = req.body || {};
  const { rpID, origin } = site(req);

  // ---- sign up: a brand-new "log your own" account ----
  if (step === 'signup-start') {
    const name = cleanName(body.name);
    if (!name) return fail(res, 'Type your name first.');
    const limit = await tooManyFailures(req, 'signup', 8);
    if (limit.blocked) return fail(res, 'Too many new accounts from here. Try again in an hour.', 429);
    const uid = `p${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID, userName: name, userDisplayName: name, userID: Buffer.from(uid),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    return res.json({ options, ticket: await newTicket({ mode: 'signup', uid, name, challenge: options.challenge }) });
  }
  if (step === 'signup-finish') {
    const t = await useTicket(body.ticket, 'signup');
    if (!t) return fail(res, 'That took too long. Try again.');
    const cred = await verifyNew(body.credential, t.challenge, rpID, origin);
    if (!cred) return fail(res, "Your passkey couldn't be saved. Try again.");
    const limit = await tooManyFailures(req, 'signup', 8);
    if (limit.blocked) return fail(res, 'Too many new accounts from here. Try again in an hour.', 429);
    await limit.record();
    await saveProfile(t.uid, {
      name: t.name, kind: 'own', createdAt: Date.now(),
      own: { fp: crypto.randomBytes(10).toString('hex') },
      passkeys: [cred],
    });
    await redis.set(K.cred(cred.id), t.uid);
    await redis.sadd(K.users, t.uid);
    const profile = await getProfile(t.uid);
    await startSession(res, t.uid, sessionFp(profile));
    return res.json({ ok: true, name: t.name });
  }

  // ---- add a passkey on this device to the account you're logged in to ----
  if (step === 'add-start') {
    const uid = await currentUser(req);
    if (!uid) return fail(res, 'Log in first.', 401);
    const p = await getProfile(uid);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID, userName: p.name || 'Homework', userDisplayName: p.name || '', userID: Buffer.from(uid),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: (p.passkeys || []).map((c) => ({ id: c.id, transports: c.transports })),
    });
    return res.json({ options, ticket: await newTicket({ mode: 'add', uid, challenge: options.challenge }) });
  }
  if (step === 'add-finish') {
    const uid = await currentUser(req);
    const t = await useTicket(body.ticket, 'add');
    if (!uid || !t || t.uid !== uid) return fail(res, 'That took too long. Try again.');
    const cred = await verifyNew(body.credential, t.challenge, rpID, origin);
    if (!cred) return fail(res, "Your passkey couldn't be saved. Try again.");
    const p = await getProfile(uid);
    await saveProfile(uid, { ...p, passkeys: [...(p.passkeys || []), cred].slice(-10) });
    await redis.set(K.cred(cred.id), uid);
    return res.json({ ok: true });
  }

  // ---- log in with a passkey ----
  if (step === 'login-start') {
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    return res.json({ options, ticket: await newTicket({ mode: 'login', challenge: options.challenge }) });
  }
  if (step === 'login-finish') {
    const limit = await tooManyFailures(req, 'passkey', 20);
    if (limit.blocked) return fail(res, 'Too many tries. Wait an hour and try again.', 429);
    const t = await useTicket(body.ticket, 'login');
    if (!t) return fail(res, 'That took too long. Try again.');
    const r = body.credential;
    const credId = typeof r?.id === 'string' && r.id.length < 1400 ? r.id : '';
    const uid = credId ? await redis.get(K.cred(credId)) : null;
    const p = uid ? await getProfile(uid) : null;
    const saved = p?.passkeys?.find((c) => c.id === credId);
    if (!saved) {
      await limit.record();
      return fail(res, "That passkey isn't linked to an account here. It may have been for an account that was deleted.");
    }
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: r, expectedChallenge: t.challenge, expectedOrigin: origin, expectedRPID: rpID,
        credential: { id: saved.id, publicKey: Buffer.from(saved.publicKey, 'base64url'), counter: saved.counter || 0, transports: saved.transports },
      });
    } catch { v = null; }
    if (!v?.verified) { await limit.record(); return fail(res, "That passkey didn't work. Try again."); }
    saved.counter = v.authenticationInfo.newCounter;
    saved.lastUsed = Date.now();
    await saveProfile(uid, p);
    await startSession(res, uid, sessionFp(p));
    return res.json({ ok: true, name: p.name });
  }

  return fail(res, 'Unknown step');
}

async function verifyNew(response, challenge, rpID, origin) {
  try {
    const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID });
    if (!v.verified) return null;
    const c = v.registrationInfo.credential;
    return { id: c.id, publicKey: b64u(c.publicKey), counter: c.counter, transports: c.transports || [], createdAt: Date.now() };
  } catch (e) {
    console.warn('passkey registration failed', e.message);
    return null;
  }
}
