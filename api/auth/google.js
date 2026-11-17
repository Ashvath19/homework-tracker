// GET /api/auth/google → sends you to Google's sign-in page
import crypto from 'node:crypto';
import { baseUrl } from '../_lib.js';

export default function handler(req, res) {
  const state = crypto.randomBytes(24).toString('base64url');
  res.setHeader('Set-Cookie', `hw_oauth=${state}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${baseUrl(req)}/api/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
