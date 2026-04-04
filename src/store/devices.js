// ---------------------------------------------------------------------------
// Device Store — backed by SQLite (atlas.db)
// ---------------------------------------------------------------------------
// Reads/writes device inventory from the database. Deployment config
// (polling, bgp, gnmi) still lives in atlas.config.json.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const db = require('../db');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'atlas.config.json');

let pollingConfig = { enabled: true, intervalSeconds: 15 };

/**
 * Load deployment config from atlas.config.json (polling, bgp, gnmi).
 * Device inventory is in the database — this only loads config settings.
 */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('  No atlas.config.json found — using defaults.');
      return;
    }

    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);

    if (config.polling) {
      pollingConfig = {
        enabled: config.polling.enabled !== false,
        intervalSeconds: config.polling.intervalSeconds || 15,
      };
    }

    const deviceCount = db.devices.list().length;
    console.log(`  Loaded ${deviceCount} device(s) from atlas.db`);
  } catch (err) {
    console.error('  Error loading config:', err.message);
  }
}

function list() {
  return db.devices.list().map(db.devices.sanitize);
}

function get(id) {
  const d = db.devices.get(id);
  return d ? db.devices.sanitize(d) : null;
}

function getRaw(id) {
  return db.devices.get(id);
}

function getAllRaw() {
  return db.devices.getAllRaw();
}

function add({ name, host, port = 443, username, password, transport = 'https', hideFromTopology = false }) {
  const device = db.devices.add({ name, host, port, username, password, transport, hideFromTopology });
  return db.devices.sanitize(device);
}

function update(id, fields) {
  const updated = db.devices.update(id, fields);
  return updated ? db.devices.sanitize(updated) : null;
}

function remove(id) {
  const removed = db.devices.remove(id);
  return !!removed;
}

function getPollingConfig() {
  return { ...pollingConfig };
}

function getHiddenHostnames() {
  const hidden = new Set();
  for (const d of db.devices.getAllRaw()) {
    if (d.hideFromTopology) hidden.add(d.name);
  }
  return hidden;
}

function filterHiddenNodes(topology) {
  if (!topology) return topology;
  const hidden = getHiddenHostnames();
  if (hidden.size === 0) return topology;

  const hiddenLower = new Set([...hidden].map(h => h.toLowerCase()));
  const hiddenIds = new Set();
  const nodes = topology.nodes.filter(n => {
    const hn = (n.data.hostname || '').toLowerCase();
    const lb = (n.data.label || '').toLowerCase();
    if (hiddenLower.has(hn) || hiddenLower.has(lb)) { hiddenIds.add(n.data.id); return false; }
    return true;
  });
  const edges = topology.edges.filter(e => !hiddenIds.has(e.data.source) && !hiddenIds.has(e.data.target));

  return {
    ...topology,
    nodes,
    edges,
    metadata: { ...topology.metadata, nodeCount: nodes.length, edgeCount: edges.length },
  };
}

module.exports = { list, get, getRaw, getAllRaw, add, update, remove, getPollingConfig, getHiddenHostnames, filterHiddenNodes, loadConfig };
