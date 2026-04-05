// ---------------------------------------------------------------------------
// ATLAS — Auth Service
// ---------------------------------------------------------------------------
// JWT authentication, user management, and audit logging.
// Modeled after PRISM's auth system for consistency.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');

const DATA_DIR        = path.join(__dirname, '..', '..');
const JWT_SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');
const db = require('../db');

const BCRYPT_ROUNDS = 10;
const TOKEN_TTL     = '8h';
const AUDIT_MAX     = 500;

// ── Role hierarchy ──────────────────────────────────────────────────────
const ROLE_LEVEL = { viewer: 0, operator: 1, admin: 2 };

// ── JWT Secret ──────────────────────────────────────────────────────────
let _jwtSecret = null;
function getJwtSecret() {
  if (_jwtSecret) return _jwtSecret;
  if (fs.existsSync(JWT_SECRET_FILE)) {
    _jwtSecret = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
  } else {
    _jwtSecret = randomBytes(64).toString('hex');
    fs.writeFileSync(JWT_SECRET_FILE, _jwtSecret, 'utf8');
    console.log('[AUTH] Generated new JWT secret → ' + JWT_SECRET_FILE);
  }
  return _jwtSecret;
}

function signToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try { return jwt.verify(token, getJwtSecret()); } catch { return null; }
}

// ── User helpers (backed by SQLite) ──────────────────────────────────────
function loadUsers() {
  // Returns { username: { passwordHash, role, mustChangePassword, ... } }
  // to maintain backward compatibility with auth/mgmt routes
  const users = {};
  for (const u of db.users.list()) {
    users[u.username] = {
      passwordHash: u.passwordHash,
      role: u.role,
      mustChangePassword: u.forcePasswordChange,
      forcePasswordChange: u.forcePasswordChange,
      displayName: u.displayName,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone,
      notes: u.notes,
      theme: u.theme,
      githubId: u.githubId,
      githubLogin: u.githubLogin,
      githubUrl: u.githubUrl,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }
  return users;
}

function saveUsers(usersObj) {
  for (const [username, data] of Object.entries(usersObj)) {
    const existing = db.users.getByUsername(username);
    if (existing) {
      db.users.update(username, {
        passwordHash: data.passwordHash,
        role: data.role,
        forcePasswordChange: data.forcePasswordChange !== undefined ? data.forcePasswordChange
          : data.mustChangePassword !== undefined ? data.mustChangePassword : false,
        displayName: data.displayName || (data.firstName ? `${data.firstName || ''} ${data.lastName || ''}`.trim() : undefined),
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone,
        notes: data.notes,
        theme: data.theme,
        githubId: data.githubId,
        githubLogin: data.githubLogin,
        githubUrl: data.githubUrl,
      });
    } else {
      db.users.add({
        username,
        passwordHash: data.passwordHash,
        role: data.role || 'viewer',
        forcePasswordChange: data.mustChangePassword || data.forcePasswordChange || false,
        displayName: data.displayName,
        githubId: data.githubId,
        githubLogin: data.githubLogin,
      });
      // Profile fields need a separate update since add() only handles core fields
      const profileFields = {};
      if (data.firstName) profileFields.firstName = data.firstName;
      if (data.lastName) profileFields.lastName = data.lastName;
      if (data.email) profileFields.email = data.email;
      if (data.phone) profileFields.phone = data.phone;
      if (data.notes) profileFields.notes = data.notes;
      if (data.githubUrl) profileFields.githubUrl = data.githubUrl;
      if (Object.keys(profileFields).length > 0) {
        db.users.update(username, profileFields);
      }
    }
  }

  // Remove users that are no longer in the object
  for (const u of db.users.list()) {
    if (!usersObj[u.username]) {
      db.users.remove(u.username);
    }
  }
}

async function initUsers() {
  if (db.users.count() > 0) return; // Users already exist
  const now = new Date().toISOString();
  const users = {
    admin: {
      passwordHash:       await bcrypt.hash('atlas-admin', BCRYPT_ROUNDS),
      role:               'admin',
      mustChangePassword: true,
      createdAt:          now,
      lastLogin:          null,
    },
  };
  saveUsers(users);
  console.log('[AUTH] Created default admin account in atlas.db — please change password on first login.');
}

// ── Audit Log (backed by SQLite) ────────────────────────────────────────
function writeAudit(username, role, action, target, result, detail = '') {
  db.audit.add({
    action: `${action} → ${target}: ${result}`,
    username,
    ip: null,
    detail: detail || `role=${role}`,
  });
  console.log(`[AUDIT] ${username}(${role}) ${action} → ${target}: ${result}${detail ? ' | ' + detail : ''}`);
}

function loadAuditLog(limit = 200) {
  return db.audit.list(Math.min(limit, AUDIT_MAX));
}

// ── Login Rate Limiter ──────────────────────────────────────────────────
const LOGIN_RATE_LIMIT = 10;
const LOGIN_WINDOW_MS  = 15 * 60_000;
const loginAttempts    = new Map();

function checkLoginRateLimit(ip) {
  const now    = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now - record.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return { allowed: true, remaining: LOGIN_RATE_LIMIT - 1 };
  }
  record.count++;
  const remaining = LOGIN_RATE_LIMIT - record.count;
  if (record.count > LOGIN_RATE_LIMIT) {
    return { allowed: false, remaining: 0, resetAt: record.windowStart + LOGIN_WINDOW_MS };
  }
  return { allowed: true, remaining };
}

function resetLoginRateLimit(ip) {
  loginAttempts.delete(ip);
}

// ── Express Middleware ───────────────────────────────────────────────────
function getAuthUser(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  return verifyToken(token);
}

/**
 * Express middleware that requires authentication.
 * Attaches req.authUser = { username, role, mustChangePassword }.
 */
function requireAuth(req, res, next) {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized — please log in.' });
  }
  req.authUser = user;
  next();
}

/**
 * Express middleware factory that requires a minimum role.
 */
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    if ((ROLE_LEVEL[req.authUser.role] ?? -1) < (ROLE_LEVEL[minRole] ?? 99)) {
      writeAudit(req.authUser.username, req.authUser.role, req.originalUrl, '—', 'denied', `requires ${minRole}`);
      return res.status(403).json({ error: `Forbidden — requires role: ${minRole}` });
    }
    next();
  };
}

function getRealIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0] : req.socket.remoteAddress || 'unknown').trim();
}

// ── GitHub OAuth ─────────────────────────────────────────────────────
const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID     || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const ATLAS_BASE_URL       = process.env.ATLAS_BASE_URL       || 'https://localhost:3000';
const GITHUB_CALLBACK_URL  = `${ATLAS_BASE_URL}/api/auth/github/callback`;

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.warn('⚠  GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set — GitHub SSO disabled');
}

module.exports = {
  loadUsers, saveUsers, initUsers,
  signToken, verifyToken, getAuthUser,
  writeAudit, loadAuditLog,
  checkLoginRateLimit, resetLoginRateLimit, getRealIp,
  requireAuth, requireRole,
  BCRYPT_ROUNDS, TOKEN_TTL, AUDIT_MAX, ROLE_LEVEL,
  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK_URL, ATLAS_BASE_URL,
};
