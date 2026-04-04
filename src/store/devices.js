// ---------------------------------------------------------------------------
// Device Store — backed by atlas.config.json
// ---------------------------------------------------------------------------
// Loads devices from the config file on startup, assigns UUIDs, and persists
// any changes (add/remove via UI) back to the file.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'atlas.config.json');

// In-memory device map
const devices = new Map();

// Polling config
let pollingConfig = { enabled: true, intervalSeconds: 15 };

// Preserve extra config keys we don't own (e.g., bgp)
let extraConfig = {};

/**
 * Load config from atlas.config.json and seed the device store.
 */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('  No atlas.config.json found — starting with empty device list.');
      return;
    }

    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);

    // Load polling config
    if (config.polling) {
      pollingConfig = {
        enabled: config.polling.enabled !== false,
        intervalSeconds: config.polling.intervalSeconds || 15,
      };
    }

    // Load devices
    const configDevices = config.devices || [];
    for (const d of configDevices) {
      const id = d.id || uuidv4();
      devices.set(id, {
        id,
        name: d.name || d.host,
        host: d.host,
        port: d.port || 443,
        username: d.username || 'admin',
        password: d.password || 'admin',
        transport: d.transport || 'https',
        hideFromTopology: d.hideFromTopology || false,
      });
    }

    // Preserve any config keys we don't own (e.g., bgp)
    const { polling, devices: _d, ...rest } = config;
    extraConfig = rest;

    console.log(`  Loaded ${devices.size} device(s) from atlas.config.json`);
  } catch (err) {
    console.error('  Error loading atlas.config.json:', err.message);
  }
}

/**
 * Persist current state back to atlas.config.json.
 */
function saveConfig() {
  try {
    const config = {
      polling: pollingConfig,
      devices: Array.from(devices.values()).map((d) => ({
        id: d.id,
        name: d.name,
        host: d.host,
        port: d.port,
        username: d.username,
        password: d.password,
        transport: d.transport,
        hideFromTopology: d.hideFromTopology || false,
      })),
      ...extraConfig, // Preserve keys we don't own (e.g., bgp)
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('  Error saving atlas.config.json:', err.message);
  }
}

// ── Public API (same interface as before) ────────────────────────────

function list() {
  return Array.from(devices.values()).map(sanitize);
}

function get(id) {
  const d = devices.get(id);
  return d ? sanitize(d) : null;
}

function getRaw(id) {
  return devices.get(id) || null;
}

function getAllRaw() {
  return Array.from(devices.values());
}

function add({ name, host, port = 443, username, password, transport = 'https', hideFromTopology = false }) {
  const id = uuidv4();
  const device = { id, name, host, port, username, password, transport, hideFromTopology };
  devices.set(id, device);
  saveConfig(); // Persist to file
  return sanitize(device);
}

function update(id, fields) {
  const device = devices.get(id);
  if (!device) return null;
  Object.assign(device, fields, { id }); // id is immutable
  saveConfig();
  return sanitize(device);
}

function remove(id) {
  const result = devices.delete(id);
  if (result) saveConfig(); // Persist to file
  return result;
}

function getPollingConfig() {
  return { ...pollingConfig };
}

/** Return a Set of device hostnames that should be hidden from topology. */
function getHiddenHostnames() {
  const hidden = new Set();
  for (const d of devices.values()) {
    if (d.hideFromTopology) hidden.add(d.name);
  }
  return hidden;
}

// Strip credentials from public responses
function sanitize(device) {
  const { password, ...safe } = device;
  return safe;
}

// Load on module init
loadConfig();

module.exports = { list, get, getRaw, getAllRaw, add, update, remove, getPollingConfig, getHiddenHostnames, loadConfig };
