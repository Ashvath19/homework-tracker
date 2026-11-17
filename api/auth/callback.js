// GET /api/auth/callback → Google sends you back here after you sign in
import { baseUrl, redis, K, getProfile, saveProfile, startSession } from '../_lib.js';

export default async function handler(req, res) {
  const fail = (why) => res.redirect(302, `/?autherror=${encodeURIComponent(why)}`);
  res.setHeader('Set-Cookie', 'hw_oauth=; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

  const { code, state, error } = req.query;
  if (error) return fail(error === 'access_denied' ? 'Sign-in was cancelled or blocked.' : error);
  if (!code || !state || state !== req.cookies?.hw_oauth) return fail('Sign-in expired. Try again.');

  // Trade the one-time code for your identity, straight from Google.
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${baseUrl(req)}/api/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const tok = await r.json();
  if (!r.ok || !tok.id_token) return fail('Google sign-in failed.');

  // This token came directly from Google over HTTPS, so we can read it without re-verifying the signature.
  const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issOk || claims.aud !== process.env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now()) return fail('Google sign-in failed.');
  if (!claims.email_verified) return fail('Your Google email isn\'t verified.');

  // Optional: only let certain email domains in (e.g. ALLOWED_DOMAINS=vcs.net,gmail.com)
  const allowed = (process.env.ALLOWED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const domain = claims.email.split('@')[1].toLowerCase();
  if (allowed.length && !allowed.includes(domain)) return fail(`Accounts from ${domain} can't use this site.`);

  const uid = `g${claims.sub}`;
  const existing = await getProfile(uid);
  await saveProfile(uid, {
    ...existing,
    email: claims.email,
    name: claims.name || claims.email,
    picture: claims.picture || null,
    createdAt: existing?.createdAt || Date.now(),
  });
  await redis.sadd(K.users, uid);
  await startSession(res, uid);
  res.redirect(302, '/');
}
