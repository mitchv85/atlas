// ---------------------------------------------------------------------------
// Management Routes — /api/mgmt
// ---------------------------------------------------------------------------
// All routes require authentication (requireAuth middleware on the router).
// Role requirements enforced per-route.
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { execSync } = require('child_process');
const path = require('path');
const auth = require('../services/auth');

// ════════════════════════════════════════════════════════════════════════
// PROFILE (any authenticated user)
// ════════════════════════════════════════════════════════════════════════

// ── GET /api/mgmt/profile ───────────────────────────────────────────────
router.get('/profile', (req, res) => {
  const users = auth.loadUsers();
  const u     = users[req.authUser.username];
  if (!u) return res.status(404).json({ error: 'User not found.' });
  res.json({
    username:    req.authUser.username,
    role:        u.role,
    type:        u.githubId ? 'github' : 'local',
    firstName:   u.firstName   || '',
    lastName:    u.lastName    || '',
    email:       u.email       || '',
    phone:       u.phone       || '',
    notes:       u.notes       || '',
    theme:       u.theme       || 'github-dark',
    githubLogin: u.githubLogin || null,
    githubUrl:   u.githubUrl   || (u.githubLogin ? `https://github.com/${u.githubLogin}` : null),
    createdAt:   u.createdAt,
    updatedAt:   u.updatedAt,
  });
});

// ── PUT /api/mgmt/profile ───────────────────────────────────────────────
router.put('/profile', (req, res) => {
  const { firstName, lastName, email, phone, notes, theme } = req.body || {};
  const users = auth.loadUsers();
  if (!users[req.authUser.username]) return res.status(404).json({ error: 'User not found.' });

  const ALLOWED = { firstName, lastName, email, phone, notes, theme };
  for (const [k, v] of Object.entries(ALLOWED)) {
    if (v !== undefined) users[req.authUser.username][k] = (typeof v === 'string') ? v.trim() : v;
  }
  auth.saveUsers(users);
  auth.writeAudit(req.authUser.username, req.authUser.role, 'user.profile-update', req.authUser.username, 'success');
  res.json({ ok: true, theme: users[req.authUser.username].theme });
});

// ════════════════════════════════════════════════════════════════════════
// USER MANAGEMENT (admin only)
// ════════════════════════════════════════════════════════════════════════

// ── GET /api/mgmt/users ─────────────────────────────────────────────────
router.get('/users', auth.requireRole('admin'), (req, res) => {
  const users = auth.loadUsers();
  const safe  = Object.entries(users).map(([username, u]) => ({
    username,
    type:               u.githubId ? 'github' : 'local',
    role:               u.role,
    createdAt:          u.createdAt,
    updatedAt:          u.updatedAt,
    mustChangePassword: u.mustChangePassword || u.forcePasswordChange,
    firstName:          u.firstName   || null,
    lastName:           u.lastName    || null,
    email:              u.email       || null,
    phone:              u.phone       || null,
    notes:              u.notes       || null,
    theme:              u.theme       || 'github-dark',
    githubLogin:        u.githubLogin || null,
    githubUrl:          u.githubUrl   || (u.githubLogin ? `https://github.com/${u.githubLogin}` : null),
  }));
  res.json(safe);
});

// ── POST /api/mgmt/users ────────────────────────────────────────────────
router.post('/users', auth.requireRole('admin'), async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !['admin', 'operator', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'username, password, and valid role (admin/operator/viewer) are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const users = auth.loadUsers();
  if (users[username]) return res.status(409).json({ error: 'Username already exists.' });

  users[username] = {
    passwordHash:       await bcrypt.hash(password, auth.BCRYPT_ROUNDS),
    role,
    mustChangePassword: true,
    createdAt:          new Date().toISOString(),
    lastLogin:          null,
  };
  auth.saveUsers(users);
  auth.writeAudit(req.authUser.username, req.authUser.role, 'user.add', username, 'success', `role=${role}`);
  res.status(201).json({ ok: true, username, role });
});

// ── POST /api/mgmt/users/github-preauth ─────────────────────────────
// Admin pre-authorizes a GitHub username so they can log in via SSO.
router.post('/users/github-preauth', auth.requireRole('admin'), (req, res) => {
  const { githubHandle, role, displayName } = req.body || {};
  if (!githubHandle || !['admin', 'operator', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'githubHandle and valid role are required.' });
  }
  const users = auth.loadUsers();
  const key = githubHandle.toLowerCase();
  if (users[key]) return res.status(409).json({ error: `User '${key}' already exists.` });

  users[key] = {
    type:         'github',
    username:     key,
    githubHandle: githubHandle,
    githubId:     null, // populated on first SSO login
    displayName:  displayName || githubHandle,
    role,
    createdAt:    new Date().toISOString(),
    lastLogin:    null,
  };
  auth.saveUsers(users);
  auth.writeAudit(req.authUser.username, req.authUser.role, 'user.add', key, 'success', `type=github role=${role}`);
  res.status(201).json({ ok: true, username: key, githubHandle, role });
});

// ── PUT /api/mgmt/users/:username ───────────────────────────────────────
router.put('/users/:username', auth.requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  const users  = auth.loadUsers();
  if (!users[target]) return res.status(404).json({ error: 'User not found.' });

  const { role, resetPassword, newPassword, firstName, lastName, email, phone, notes, theme } = req.body || {};

  if (role) {
    if (!['admin', 'operator', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    users[target].role = role;
  }
  if (resetPassword && newPassword) {
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password min 8 chars.' });
    users[target].passwordHash       = await bcrypt.hash(newPassword, auth.BCRYPT_ROUNDS);
    users[target].mustChangePassword = true;
  }

  // Profile fields
  const profileFields = { firstName, lastName, email, phone, notes, theme };
  for (const [k, v] of Object.entries(profileFields)) {
    if (v !== undefined) users[target][k] = (typeof v === 'string') ? v.trim() : v;
  }

  auth.saveUsers(users);
  auth.writeAudit(req.authUser.username, req.authUser.role, 'user.edit', target, 'success',
    [role && `role→${role}`, resetPassword && 'pw reset'].filter(Boolean).join(', '));
  res.json({ ok: true });
});

// ── DELETE /api/mgmt/users/:username ────────────────────────────────────
router.delete('/users/:username', auth.requireRole('admin'), (req, res) => {
  const target = req.params.username;
  if (target === req.authUser.username) return res.status(400).json({ error: 'Cannot delete yourself.' });
  if (target === 'admin') return res.status(403).json({ error: "The 'admin' account cannot be deleted." });

  const users = auth.loadUsers();
  if (!users[target]) return res.status(404).json({ error: 'User not found.' });
  delete users[target];
  auth.saveUsers(users);
  auth.writeAudit(req.authUser.username, req.authUser.role, 'user.delete', target, 'success');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════
// AUDIT LOG (operator+)
// ════════════════════════════════════════════════════════════════════════

// ── GET /api/mgmt/audit-log ─────────────────────────────────────────────
router.get('/audit-log', auth.requireRole('operator'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
  res.json(auth.loadAuditLog(limit));
});

// ════════════════════════════════════════════════════════════════════════
// SYSTEM INFO (operator+)
// ════════════════════════════════════════════════════════════════════════

// ── GET /api/mgmt/system ────────────────────────────────────────────────
router.get('/system', auth.requireRole('operator'), (req, res) => {
  // ATLAS git commit
  let atlasCommit = 'unknown';
  try {
    atlasCommit = execSync('git -C ' + path.join(__dirname, '..', '..') + ' rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {}

  // User count
  let userCount = 0;
  try { userCount = Object.keys(auth.loadUsers()).length; } catch {}

  // Audit entry count
  let auditCount = 0;
  try { auditCount = auth.loadAuditLog(500).length; } catch {}

  // Device count
  let deviceCount = 0;
  try {
    const deviceStore = require('../store/devices');
    deviceCount = deviceStore.list().length;
  } catch {}

  res.json({
    nodeVersion:   process.version,
    platform:      process.platform,
    uptimeSeconds: process.uptime(),
    memUsedMb:     Math.round(process.memoryUsage().rss / 1024 / 1024),
    atlasCommit,
    tokenTtl:      auth.TOKEN_TTL,
    auditMax:      auth.AUDIT_MAX,
    userCount,
    auditCount,
    deviceCount,
  });
});

module.exports = router;
