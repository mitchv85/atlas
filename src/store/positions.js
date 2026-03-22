// ---------------------------------------------------------------------------
// Node Position Store — backed by atlas.positions.json
// ---------------------------------------------------------------------------
// Persists Cytoscape.js node positions across sessions.
// Saved whenever a user drags a node, loaded on topology render.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const POSITIONS_PATH = path.join(__dirname, '..', '..', 'atlas.positions.json');

let positions = {}; // { nodeId: { x, y } }

/**
 * Load positions from file.
 */
function load() {
  try {
    if (fs.existsSync(POSITIONS_PATH)) {
      const raw = fs.readFileSync(POSITIONS_PATH, 'utf-8');
      positions = JSON.parse(raw);
    }
  } catch (err) {
    console.error('  Error loading positions:', err.message);
    positions = {};
  }
}

/**
 * Save positions to file.
 */
function save() {
  try {
    fs.writeFileSync(POSITIONS_PATH, JSON.stringify(positions, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('  Error saving positions:', err.message);
  }
}

/**
 * Get all positions.
 */
function getAll() {
  return { ...positions };
}

/**
 * Update positions for one or more nodes.
 * @param {Object} updates - { nodeId: { x, y }, ... }
 */
function update(updates) {
  let changed = false;
  for (const [nodeId, pos] of Object.entries(updates)) {
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      positions[nodeId] = { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100 };
      changed = true;
    }
  }
  if (changed) save();
}

/**
 * Remove positions for nodes that no longer exist.
 * @param {string[]} activeNodeIds - Currently active node IDs
 */
function prune(activeNodeIds) {
  const activeSet = new Set(activeNodeIds);
  let changed = false;
  for (const nodeId of Object.keys(positions)) {
    if (!activeSet.has(nodeId)) {
      delete positions[nodeId];
      changed = true;
    }
  }
  if (changed) save();
}

// Load on module init
load();

module.exports = { getAll, update, prune, load };
