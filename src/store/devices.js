// ---------------------------------------------------------------------------
// In-memory device store
// ---------------------------------------------------------------------------
// Each device: { id, name, host, port, username, password, transport }
// transport: 'https' (eAPI default)
// ---------------------------------------------------------------------------

const { v4: uuidv4 } = require('uuid');

const devices = new Map();

function list() {
  return Array.from(devices.values()).map(sanitize);
}

function get(id) {
  return devices.get(id) || null;
}

function getRaw(id) {
  return devices.get(id) || null;
}

function add({ name, host, port = 443, username, password, transport = 'https' }) {
  const id = uuidv4();
  const device = { id, name, host, port, username, password, transport };
  devices.set(id, device);
  return sanitize(device);
}

function update(id, fields) {
  const device = devices.get(id);
  if (!device) return null;
  Object.assign(device, fields, { id }); // id is immutable
  return sanitize(device);
}

function remove(id) {
  return devices.delete(id);
}

// Strip credentials from public responses
function sanitize(device) {
  const { password, ...safe } = device;
  return safe;
}

module.exports = { list, get, getRaw, add, update, remove };
