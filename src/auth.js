import { randomBytes, createHash } from 'node:crypto';
import { db, now, recordEvent } from './db.js';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const COOKIE_NAME = 'sid';

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createAuthSession(userId) {
  const token = randomBytes(32).toString('hex');
  const t = now();
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, t, t + SESSION_TTL_MS);
  // opportunistic cleanup of expired sessions
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(t);
  return token;
}

export function destroyAuthSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
}

export function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.role, u.display_name, s.expires_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < now()) {
    destroyAuthSession(token);
    return null;
  }
  return { id: row.id, username: row.username, role: row.role, displayName: row.display_name };
}

export function setAuthCookie(res, token, secure) {
  const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export function attachUser(req, res, next) {
  req.user = getUserByToken(readCookie(req, COOKIE_NAME));
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    if (role && req.user.role !== role) return res.status(403).json({ error: 'FORBIDDEN', needRole: role });
    next();
  };
}

/**
 * CSRF defence (layered with SameSite=Strict cookies):
 * mutating requests must be JSON with our custom header, which a
 * cross-site form/GET cannot produce without CORS preflight approval.
 */
export function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.headers['x-requested-with'] !== 'fetch' || req.headers['content-type'] !== 'application/json') {
    return res.status(403).json({ error: 'CSRF_CHECK_FAILED' });
  }
  next();
}

// ---- In-memory rate limiter (single-process deployment) ----
const buckets = new Map();

export function rateLimit({ name, windowMs, max, keyFn }) {
  return (req, res, next) => {
    const key = `${name}:${keyFn(req)}`;
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset < t) {
      bucket = { count: 0, reset: t + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: 'RATE_LIMITED', retryAfterMs: bucket.reset - t });
    }
    // prune occasionally
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
    }
    next();
  };
}

export function auditLogin(req, user, ok) {
  recordEvent({
    actorId: user ? user.id : null,
    type: ok ? 'LOGIN_OK' : 'LOGIN_FAILED',
    payload: { username: req.body?.username, ip: req.ip }
  });
}
