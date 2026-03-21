// ---------------------------------------------------------------------------
// ATLAS API Client
// ---------------------------------------------------------------------------

const API = {
  // ── Devices ──────────────────────────────────────────────────────────
  async getDevices() {
    const res = await fetch('/api/devices');
    return res.json();
  },

  async addDevice(device) {
    const res = await fetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(device),
    });
    return res.json();
  },

  async removeDevice(id) {
    const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async testDevice(id) {
    const res = await fetch(`/api/devices/${id}/test`, { method: 'POST' });
    return res.json();
  },

  // ── Topology ─────────────────────────────────────────────────────────
  async getTopology() {
    const res = await fetch('/api/topology');
    if (res.status === 404) return null;
    return res.json();
  },

  async collectTopology(deviceId = null) {
    const body = deviceId ? { deviceId } : {};
    const res = await fetch('/api/topology/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Collection failed');
    }
    return res.json();
  },

  async getNodeDetail(systemId) {
    const res = await fetch(`/api/topology/node/${systemId}`);
    if (!res.ok) return null;
    return res.json();
  },

  // ── Path Computation ──────────────────────────────────────────────
  async computePath(source, destination, excludeNodes = [], excludeEdges = []) {
    const res = await fetch('/api/topology/path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination, excludeNodes, excludeEdges }),
    });
    return res.json();
  },

  async analyzePath(source, destination) {
    const res = await fetch('/api/topology/path/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination }),
    });
    return res.json();
  },
};
