// ---------------------------------------------------------------------------
// Auth Routes — /api/auth
// ---------------------------------------------------------------------------
// Public: POST /login, GET /me
// Protected: POST /logout, POST /change-password
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const auth = require('../services/auth');

// ── POST /api/auth/login ────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const ip = auth.getRealIp(req);
  const rl = auth.checkLoginRateLimit(ip);
  if (!rl.allowed) {
    const resetIn = Math.ceil((rl.resetAt - Date.now()) / 60_000);
    auth.writeAudit('?', '—', 'auth.login', '?', 'blocked', `rate limit from ${ip}`);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${resetIn} minute${resetIn !== 1 ? 's' : ''}.` });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const users = auth.loadUsers();
  const user  = users[username];
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    auth.writeAudit(username || '?', '—', 'auth.login', username || '?', 'error', `bad credentials from ${ip}`);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Success — clear rate limit, update lastLogin
  auth.resetLoginRateLimit(ip);
  users[username].lastLogin = new Date().toISOString();
  auth.saveUsers(users);

  const payload = { username, role: user.role, mustChangePassword: user.mustChangePassword || false };
  const token   = auth.signToken(payload);
  auth.writeAudit(username, user.role, 'auth.login', username, 'success');
  res.json({ token, user: payload });
});

// ── GET /api/auth/me ────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const u = auth.getAuthUser(req);
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ username: u.username, role: u.role, mustChangePassword: u.mustChangePassword });
});

// ── POST /api/auth/logout ───────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const u = auth.getAuthUser(req);
  if (u) auth.writeAudit(u.username, u.role, 'auth.logout', u.username, 'success');
  res.json({ ok: true });
});

// ── POST /api/auth/change-password ──────────────────────────────────────
router.post('/change-password', async (req, res) => {
  const u = auth.getAuthUser(req);
  if (!u) return res.status(401).json({ error: 'Unauthorized' });

  const { currentPassword, newPassword } = req.body || {};
  const users = auth.loadUsers();
  const user  = users[u.username];
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  users[u.username].passwordHash       = await bcrypt.hash(newPassword, auth.BCRYPT_ROUNDS);
  users[u.username].mustChangePassword = false;
  auth.saveUsers(users);
  auth.writeAudit(u.username, u.role, 'user.pw-change', u.username, 'success');

  // Issue fresh token with mustChangePassword cleared
  const newToken = auth.signToken({ username: u.username, role: u.role, mustChangePassword: false });
  res.json({ ok: true, token: newToken });
});

module.exports = router;
