// ---------------------------------------------------------------------------
// ATLAS Database — SQLite via sql.js
// ---------------------------------------------------------------------------
// Persistent storage for runtime state: devices, users, audit log.
// Uses sql.js (pure JavaScript SQLite) — no native compilation needed.
//
// On first run, automatically imports existing data from JSON files
// (atlas.config.json devices, users.json, audit-log.json) so the
// migration is seamless.
//
// The database file (atlas.db) is gitignored and persists across
// git pulls and pm2 restarts.
// ---------------------------------------------------------------------------

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'atlas.db');
const SCHEMA_VERSION = 1;

let db = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the database — load from disk or create new.
 * Must be called (and awaited) before any other db operations.
 */
async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('  [DB] Loaded atlas.db');
  } else {
    db = new SQL.Database();
    console.log('  [DB] Created new atlas.db');
  }

  // Run migrations
  _migrate();

  // Auto-import from JSON files on first run
  _autoImport();

  // Save to disk
  _save();

  return db;
}

// ---------------------------------------------------------------------------
// Schema Migrations
// ---------------------------------------------------------------------------

function _migrate() {
  // Create schema_version table if it doesn't exist
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  )`);

  const row = db.exec('SELECT version FROM schema_version LIMIT 1');
  const currentVersion = row.length > 0 && row[0].values.length > 0
    ? row[0].values[0][0]
    : 0;

  if (currentVersion < 1) {
    console.log('  [DB] Running migration v1 — creating tables...');

    db.run(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 443,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      transport TEXT DEFAULT 'https',
      hide_from_topology INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      force_password_change INTEGER DEFAULT 0,
      display_name TEXT,
      github_id TEXT,
      github_login TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      username TEXT,
      ip TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`);

    // Set schema version
    db.run('DELETE FROM schema_version');
    db.run(`INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION})`);

    console.log('  [DB] Migration v1 complete');
  }
}

// ---------------------------------------------------------------------------
// Auto-Import from JSON Files
// ---------------------------------------------------------------------------

function _autoImport() {
  _importDevices();
  _importUsers();
  _importAuditLog();
}

function _importDevices() {
  // Check if devices table already has data
  const countResult = db.exec('SELECT COUNT(*) FROM devices');
  const count = countResult[0].values[0][0];
  if (count > 0) return; // Already populated

  // Try to import from atlas.config.json
  const configPath = path.join(__dirname, '..', '..', 'atlas.config.json');
  if (!fs.existsSync(configPath)) return;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const devices = config.devices || [];

    if (devices.length === 0) return;

    const stmt = db.prepare(`INSERT INTO devices (id, name, host, port, username, password, transport, hide_from_topology)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const d of devices) {
      const id = d.id || _uuid();
      stmt.run([id, d.name, d.host, d.port || 443, d.username, d.password, d.transport || 'https', d.hideFromTopology ? 1 : 0]);
    }
    stmt.free();

    console.log(`  [DB] Imported ${devices.length} device(s) from atlas.config.json`);
  } catch (err) {
    console.error('  [DB] Device import failed:', err.message);
  }
}

function _importUsers() {
  const countResult = db.exec('SELECT COUNT(*) FROM users');
  const count = countResult[0].values[0][0];
  if (count > 0) return;

  const usersPath = path.join(__dirname, '..', '..', 'users.json');
  if (!fs.existsSync(usersPath)) return;

  try {
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));

    const stmt = db.prepare(`INSERT INTO users (username, password_hash, role, force_password_change, display_name, github_id, github_login)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);

    for (const u of users) {
      stmt.run([
        u.username,
        u.passwordHash || u.password_hash || '',
        u.role || 'viewer',
        u.forcePasswordChange ? 1 : 0,
        u.displayName || null,
        u.githubId || null,
        u.githubLogin || null,
      ]);
    }
    stmt.free();

    console.log(`  [DB] Imported ${users.length} user(s) from users.json`);
  } catch (err) {
    console.error('  [DB] User import failed:', err.message);
  }
}

function _importAuditLog() {
  const countResult = db.exec('SELECT COUNT(*) FROM audit_log');
  const count = countResult[0].values[0][0];
  if (count > 0) return;

  const logPath = path.join(__dirname, '..', '..', 'audit-log.json');
  if (!fs.existsSync(logPath)) return;

  try {
    const entries = JSON.parse(fs.readFileSync(logPath, 'utf-8'));

    const stmt = db.prepare(`INSERT INTO audit_log (action, username, ip, detail, created_at)
      VALUES (?, ?, ?, ?, ?)`);

    for (const e of entries) {
      stmt.run([
        e.action || '',
        e.username || null,
        e.ip || null,
        e.detail || null,
        e.timestamp || e.created_at || new Date().toISOString(),
      ]);
    }
    stmt.free();

    console.log(`  [DB] Imported ${entries.length} audit log entries from audit-log.json`);
  } catch (err) {
    console.error('  [DB] Audit log import failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Device CRUD
// ---------------------------------------------------------------------------

const deviceOps = {
  list() {
    const result = db.exec('SELECT * FROM devices ORDER BY name');
    return _rowsToObjects(result);
  },

  get(id) {
    const stmt = db.prepare('SELECT * FROM devices WHERE id = ?');
    stmt.bind([id]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row ? _mapDevice(row) : null;
  },

  getByName(name) {
    const stmt = db.prepare('SELECT * FROM devices WHERE name = ?');
    stmt.bind([name]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row ? _mapDevice(row) : null;
  },

  add(device) {
    const id = _uuid();
    db.run(`INSERT INTO devices (id, name, host, port, username, password, transport, hide_from_topology)
      VALUES ('${id}', '${_esc(device.name)}', '${_esc(device.host)}', ${device.port || 443},
              '${_esc(device.username)}', '${_esc(device.password)}',
              '${_esc(device.transport || 'https')}', ${device.hideFromTopology ? 1 : 0})`);
    _save();
    return { id, ...device };
  },

  update(id, fields) {
    const device = this.get(id);
    if (!device) return null;

    const sets = [];
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'id') continue; // immutable
      const col = key === 'hideFromTopology' ? 'hide_from_topology' : key;
      if (typeof value === 'boolean' || col === 'hide_from_topology') {
        sets.push(`${col} = ${value ? 1 : 0}`);
      } else if (typeof value === 'number') {
        sets.push(`${col} = ${value}`);
      } else {
        sets.push(`${col} = '${_esc(value)}'`);
      }
    }

    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      db.run(`UPDATE devices SET ${sets.join(', ')} WHERE id = '${_esc(id)}'`);
      _save();
    }

    return this.get(id);
  },

  remove(id) {
    const device = this.get(id);
    if (!device) return null;
    db.run(`DELETE FROM devices WHERE id = '${_esc(id)}'`);
    _save();
    return device;
  },

  /** Get all devices including credentials (for internal use by poller, gNMI). */
  getAllRaw() {
    const result = db.exec('SELECT * FROM devices ORDER BY name');
    return _rowsToObjects(result).map(_mapDevice);
  },

  /** Get a single device including credentials (for internal use). */
  getRaw(id) {
    return this.get(id);
  },

  /** Get device for public display (no credentials). */
  sanitize(device) {
    if (!device) return null;
    const { password, ...safe } = device;
    return safe;
  },
};

// ---------------------------------------------------------------------------
// User CRUD
// ---------------------------------------------------------------------------

const userOps = {
  list() {
    const result = db.exec('SELECT * FROM users ORDER BY username');
    return _rowsToObjects(result).map(_mapUser);
  },

  getByUsername(username) {
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
    stmt.bind([username]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row ? _mapUser(row) : null;
  },

  getByGithubId(githubId) {
    const stmt = db.prepare('SELECT * FROM users WHERE github_id = ?');
    stmt.bind([String(githubId)]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row ? _mapUser(row) : null;
  },

  add(user) {
    db.run(`INSERT INTO users (username, password_hash, role, force_password_change, display_name, github_id, github_login)
      VALUES ('${_esc(user.username)}', '${_esc(user.passwordHash)}', '${_esc(user.role || 'viewer')}',
              ${user.forcePasswordChange ? 1 : 0}, ${user.displayName ? `'${_esc(user.displayName)}'` : 'NULL'},
              ${user.githubId ? `'${_esc(String(user.githubId))}'` : 'NULL'},
              ${user.githubLogin ? `'${_esc(user.githubLogin)}'` : 'NULL'})`);
    _save();
    return this.getByUsername(user.username);
  },

  update(username, fields) {
    const sets = [];
    if (fields.passwordHash !== undefined) sets.push(`password_hash = '${_esc(fields.passwordHash)}'`);
    if (fields.role !== undefined) sets.push(`role = '${_esc(fields.role)}'`);
    if (fields.forcePasswordChange !== undefined) sets.push(`force_password_change = ${fields.forcePasswordChange ? 1 : 0}`);
    if (fields.displayName !== undefined) sets.push(`display_name = '${_esc(fields.displayName)}'`);
    if (fields.githubId !== undefined) sets.push(`github_id = '${_esc(String(fields.githubId))}'`);
    if (fields.githubLogin !== undefined) sets.push(`github_login = '${_esc(fields.githubLogin)}'`);

    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      db.run(`UPDATE users SET ${sets.join(', ')} WHERE username = '${_esc(username)}'`);
      _save();
    }

    return this.getByUsername(username);
  },

  remove(username) {
    const user = this.getByUsername(username);
    if (!user) return null;
    db.run(`DELETE FROM users WHERE username = '${_esc(username)}'`);
    _save();
    return user;
  },

  count() {
    const result = db.exec('SELECT COUNT(*) FROM users');
    return result[0].values[0][0];
  },
};

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

const auditOps = {
  add(entry) {
    db.run(`INSERT INTO audit_log (action, username, ip, detail)
      VALUES ('${_esc(entry.action)}', ${entry.username ? `'${_esc(entry.username)}'` : 'NULL'},
              ${entry.ip ? `'${_esc(entry.ip)}'` : 'NULL'},
              ${entry.detail ? `'${_esc(entry.detail)}'` : 'NULL'})`);

    // Trim to last 500 entries
    db.run(`DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY created_at DESC LIMIT 500)`);
    _save();
  },

  list(limit = 100) {
    const result = db.exec(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ${limit}`);
    return _rowsToObjects(result).map(row => ({
      id: row.id,
      action: row.action,
      username: row.username,
      ip: row.ip,
      detail: row.detail,
      timestamp: row.created_at,
    }));
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save database to disk. */
function _save() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error('  [DB] Save failed:', err.message);
  }
}

/** Convert sql.js exec result to array of objects. */
function _rowsToObjects(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

/** Map a device row to the shape the rest of ATLAS expects. */
function _mapDevice(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.password,
    transport: row.transport,
    hideFromTopology: row.hide_from_topology === 1,
  };
}

/** Map a user row to the shape auth.js expects. */
function _mapUser(row) {
  return {
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    forcePasswordChange: row.force_password_change === 1,
    displayName: row.display_name || null,
    githubId: row.github_id || null,
    githubLogin: row.github_login || null,
  };
}

/** Escape single quotes for SQL strings. */
function _esc(s) {
  if (s == null) return '';
  return String(s).replace(/'/g, "''");
}

/** Generate a UUID v4. */
function _uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init,
  devices: deviceOps,
  users: userOps,
  audit: auditOps,
};
