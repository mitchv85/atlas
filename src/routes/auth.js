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
  // Load full user data for theme
  const users = auth.loadUsers();
  const userData = users[u.username] || {};
  res.json({
    username: u.username,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    theme: userData.theme || 'github-dark',
  });
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

// ════════════════════════════════════════════════════════════════════════
// GitHub OAuth SSO
// ════════════════════════════════════════════════════════════════════════

// ── GET /api/auth/github/status ─────────────────────────────────────────
// Tells frontend if GitHub SSO is configured
router.get('/github/status', (_req, res) => {
  res.json({ enabled: !!(auth.GITHUB_CLIENT_ID && auth.GITHUB_CLIENT_SECRET) });
});

// ── GET /api/auth/github ────────────────────────────────────────────────
// Redirects the browser to GitHub's OAuth authorization page.
router.get('/github', (_req, res) => {
  if (!auth.GITHUB_CLIENT_ID) {
    return res.status(503).json({ error: 'GitHub SSO not configured.' });
  }
  const { randomBytes } = require('crypto');
  const state = randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id:    auth.GITHUB_CLIENT_ID,
    redirect_uri: auth.GITHUB_CALLBACK_URL,
    scope:        'read:user',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// ── GET /api/auth/github/callback ───────────────────────────────────────
// GitHub redirects here after user approves. Exchange code → token →
// GitHub profile → match pre-authorized user → issue ATLAS JWT.
router.get('/github/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/?auth_error=missing_code');
  }

  try {
    // Step 1 — Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id:     auth.GITHUB_CLIENT_ID,
        client_secret: auth.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  auth.GITHUB_CALLBACK_URL,
      }),
    });
    const tokenJson = await tokenRes.json();
    if (tokenJson.error || !tokenJson.access_token) {
      console.error('[GitHub SSO] Token exchange failed:', tokenJson.error_description || tokenJson.error);
      return res.redirect('/?auth_error=token_exchange_failed');
    }

    // Step 2 — Fetch GitHub user profile
    const profileRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}`, 'User-Agent': 'ATLAS-App' },
    });
    const profile     = await profileRes.json();
    const githubId     = String(profile.id);
    const githubHandle = profile.login;

    // Step 3 — Look up pre-authorized user in users.json
    const users = auth.loadUsers();
    let matchedKey = null;
    for (const [key, u] of Object.entries(users)) {
      if (u.type === 'github' && (String(u.githubId) === githubId || u.githubHandle?.toLowerCase() === githubHandle.toLowerCase())) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      auth.writeAudit(githubHandle, '—', 'auth.github-login', githubHandle, 'error', 'not pre-authorized');
      return res.redirect(`/?auth_error=not_authorized&handle=${encodeURIComponent(githubHandle)}`);
    }

    const entry = users[matchedKey];

    // Step 4 — Stamp githubId in case only handle was matched
    if (!entry.githubId) {
      users[matchedKey].githubId = githubId;
    }
    users[matchedKey].lastLogin = new Date().toISOString();
    auth.saveUsers(users);

    // Step 5 — Issue ATLAS JWT
    const payload = { username: matchedKey, role: entry.role, mustChangePassword: false, authType: 'github' };
    const token   = auth.signToken(payload);
    auth.writeAudit(matchedKey, entry.role, 'auth.github-login', githubHandle, 'success');

    // Step 6 — Redirect to frontend with token in query param
    res.redirect(`/?auth_token=${encodeURIComponent(token)}`);

  } catch (e) {
    console.error('[GitHub SSO] Callback error:', e.message);
    res.redirect('/?auth_error=server_error');
  }
});

module.exports = router;
