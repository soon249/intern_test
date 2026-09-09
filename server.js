import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, recordEvent } from './src/db.js';
import { ensureSeed, ensurePythonSeed, verify } from './src/seed.js';
import { ensureSimpleCyberSeed } from './src/simpleCyberAssessment.js';
import {
  attachUser, requireRole, createAuthSession, destroyAuthSession,
  setAuthCookie, clearAuthCookie, readCookie, COOKIE_NAME, csrfGuard, rateLimit
} from './src/auth.js';
import { candidateRouter } from './src/candidate.js';
import { adminRouter } from './src/admin.js';
import { renderCheatsheet } from './src/cheatsheet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.APP_SECRET || 'dev-secret-change-me';

ensureSeed();
ensurePythonSeed();
ensureSimpleCyberSeed();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

// ---- security headers (CSP blocks inline script so stored XSS cannot execute) ----
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(attachUser);

// ---- auth API ----
const loginLimiter = rateLimit({
  name: 'login', windowMs: 60_000, max: 10,
  keyFn: req => `${req.ip}:${String(req.body?.username || '')}`
});

app.post('/api/auth/login', loginLimiter, csrfGuard, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = user && verify(password, user.password_hash);
  if (!ok) {
    recordEvent({ actorId: user ? user.id : null, type: 'LOGIN_FAILED', payload: { username } });
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }
  const token = createAuthSession(user.id);
  setAuthCookie(res, token, req.secure);
  recordEvent({ actorId: user.id, type: 'LOGIN_OK', payload: { username, role: user.role } });
  res.json({ ok: true, role: user.role, displayName: user.display_name });
});

app.post('/api/auth/logout', csrfGuard, (req, res) => {
  destroyAuthSession(readCookie(req, COOKIE_NAME));
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
  res.json({ username: req.user.username, role: req.user.role, displayName: req.user.displayName });
});

// ---- role-scoped API surfaces ----
app.use('/api/candidate', csrfGuard, candidateRouter);
app.use('/api/admin', csrfGuard, adminRouter);

// ---- static frontend ----
const pubDir = path.join(__dirname, 'public');
app.use(express.static(pubDir, { index: false, extensions: false }));

const page = name => (req, res) => res.sendFile(path.join(pubDir, name));
app.get('/', page('index.html'));
app.get('/candidate', page('candidate.html'));
app.get('/admin', page('admin.html'));
// interviewer-only printable answer booklet (role-checked server-side)
app.get('/admin/cheatsheet', requireRole('admin'), (req, res) => res.send(renderCheatsheet()));

app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

app.listen(PORT, () => {
  console.log(`Intern Assessment Platform running at http://localhost:${PORT}`);
  console.log('Default admin: admin / admin123  (change after first login)');
  console.log('Sample candidate: johntan / candidate123');
});
