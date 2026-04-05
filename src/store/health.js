// ---------------------------------------------------------------------------
// Health Store — Device Health Aggregation
// ---------------------------------------------------------------------------
// Collects temperature readings, LLDP neighbors, and interface status
// from gNMI streams. Provides per-device health summaries for the
// Health Dashboard.
// ---------------------------------------------------------------------------

// Temperature: Map<"device:component"> → { temperature, alarm, timestamp }
const temperatures = new Map();

// LLDP: Map<"device:interface"> → { systemName, portDesc, mgmtAddr, timestamp }
const lldpNeighbors = new Map();

// Interface status: Map<"device:interface"> → { operStatus, timestamp }
const interfaceStatus = new Map();

/**
 * Record a temperature reading.
 */
function recordTemperature({ device, component, temperature, alarm, timestamp }) {
  temperatures.set(`${device}:${component}`, { device, component, temperature, alarm, timestamp });
}

/**
 * Record an LLDP neighbor update.
 */
function recordLldpNeighbor({ device, interface: ifName, neighbor, timestamp }) {
  lldpNeighbors.set(`${device}:${ifName}`, { device, interface: ifName, ...neighbor, timestamp });
}

/**
 * Record an interface status change.
 */
function recordInterfaceStatus({ device, interface: ifName, operStatus, timestamp }) {
  interfaceStatus.set(`${device}:${ifName}`, { device, interface: ifName, operStatus, timestamp });
}

/**
 * Get health summary for a specific device.
 */
function getDeviceHealth(deviceName) {
  const temps = [];
  for (const [, t] of temperatures) {
    if (t.device === deviceName) temps.push(t);
  }

  const lldp = [];
  for (const [, n] of lldpNeighbors) {
    if (n.device === deviceName) lldp.push(n);
  }

  const intfs = { up: 0, down: 0, total: 0 };
  for (const [, s] of interfaceStatus) {
    if (s.device === deviceName && s.interface.startsWith('Ethernet')) {
      intfs.total++;
      if (s.operStatus === 'UP') intfs.up++;
      else if (s.operStatus === 'DOWN') intfs.down++;
    }
  }

  const maxTemp = temps.length > 0 ? Math.max(...temps.map(t => t.temperature)) : null;
  const hasAlarm = temps.some(t => t.alarm);

  return {
    device: deviceName,
    temperature: { max: maxTemp, alarm: hasAlarm, readings: temps.length },
    interfaces: intfs,
    lldpNeighbors: lldp.length,
  };
}

/**
 * Get health summary for all devices.
 */
function getAllHealth() {
  const deviceNames = new Set();
  for (const [, t] of temperatures) deviceNames.add(t.device);
  for (const [, s] of interfaceStatus) deviceNames.add(s.device);

  const health = {};
  for (const name of deviceNames) {
    health[name] = getDeviceHealth(name);
  }
  return health;
}

/**
 * Get all LLDP neighbors (for topology enrichment).
 */
function getAllLldpNeighbors() {
  return Array.from(lldpNeighbors.values());
}

// Interface speeds: Map<"device:interface"> → { speedBps }
const interfaceSpeeds = new Map();

/**
 * Record an interface's negotiated speed.
 */
function recordInterfaceSpeed({ device, interface: ifName, speedBps }) {
  interfaceSpeeds.set(`${device}:${ifName}`, { device, interface: ifName, speedBps });
}

/**
 * Get interface speed for a specific device:interface.
 * Returns speedBps or null if unknown.
 */
function getInterfaceSpeed(device, ifName) {
  const entry = interfaceSpeeds.get(`${device}:${ifName}`);
  return entry ? entry.speedBps : null;
}

/**
 * Get all interface speeds as an object keyed by "device:interface".
 */
function getAllInterfaceSpeeds() {
  const result = {};
  for (const [key, entry] of interfaceSpeeds) {
    result[key] = entry.speedBps;
  }
  return result;
}

module.exports = {
  recordTemperature,
  recordLldpNeighbor,
  recordInterfaceStatus,
  recordInterfaceSpeed,
  getInterfaceSpeed,
  getAllInterfaceSpeeds,
  getDeviceHealth,
  getAllHealth,
  getAllLldpNeighbors,
};
