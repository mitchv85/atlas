// ---------------------------------------------------------------------------
// ATLAS API Client
// ---------------------------------------------------------------------------

const API = {
  // ── Devices ──────────────────────────────────────────────────────────
  async getDevices() {
    const res = await fetch('/api/devices');
    return res.json();
  },

  async getDeviceInfo() {
    const res = await fetch('/api/devices/info');
    return res.json();
  },

  async getDeviceConfig(id) {
    const res = await fetch(`/api/devices/${id}/config`);
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

  async addDevice(device) {
    const res = await fetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(device),
    });
    return res.json();
  },

  async updateDevice(id, fields) {
    const res = await fetch(`/api/devices/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    return res.json();
  },

  async deleteDevice(id) {
    const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async bulkImportDevices(devices) {
    const res = await fetch('/api/devices/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices }),
    });
    return res.json();
  },

  async testDevice(id) {
    const res = await fetch(`/api/devices/${id}/test`, { method: 'POST' });
    return res.json();
  },

  async runCommand(hostname, cmd, format = 'text') {
    const res = await fetch(`/api/devices/by-hostname/${encodeURIComponent(hostname)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, format }),
    });
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

  async getNodeReachability(systemId) {
    const res = await fetch(`/api/topology/node/${systemId}/reachability`);
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

  async computeECMP(source, destination) {
    const res = await fetch('/api/topology/path/ecmp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination }),
    });
    return res.json();
  },

  // ── Positions ─────────────────────────────────────────────────────
  async getPositions() {
    const res = await fetch('/api/topology/positions');
    return res.json();
  },

  async savePositions(positions) {
    await fetch('/api/topology/positions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(positions),
    });
  },

  // ── BGP ───────────────────────────────────────────────────────────
  async getBgpStatus() {
    const res = await fetch('/api/bgp/status');
    return res.json();
  },

  async getBgpConfig() {
    const res = await fetch('/api/bgp/config');
    return res.json();
  },

  async deployBgpConfig(config) {
    const res = await fetch('/api/bgp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.json();
  },

  async previewBgpConfig(config) {
    const res = await fetch('/api/bgp/config/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.json();
  },

  async getBgpNeighbors() {
    const res = await fetch('/api/bgp/neighbors');
    return res.json();
  },

  async getBgpVrfs() {
    const res = await fetch('/api/bgp/vrfs');
    return res.json();
  },

  async getBgpVrfsByRT() {
    const res = await fetch('/api/bgp/vrfs/by-rt');
    return res.json();
  },

  async getBgpRib(filters = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== '') params.set(k, v);
    }
    const res = await fetch(`/api/bgp/rib?${params}`);
    return res.json();
  },

  async collectBgp() {
    const res = await fetch('/api/bgp/collect', { method: 'POST' });
    return res.json();
  },
};
