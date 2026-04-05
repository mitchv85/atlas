// ---------------------------------------------------------------------------
// ATLAS API Client
// ---------------------------------------------------------------------------
// Frontend HTTP client for all ATLAS REST API endpoints. Organized by domain:
// Devices, Topology, Path Computation, FlexAlgo, Positions, and BGP.
//
// All methods return parsed JSON. Methods that can legitimately return
// "not found" (getTopology, getNodeDetail, etc.) return null on 404.
// ---------------------------------------------------------------------------

/**
 * Fetch wrapper that attaches the JWT Authorization header.
 * On 401, fires a custom 'atlas:unauthorized' event so the app can redirect to login.
 */
async function authFetch(url, opts = {}) {
  const token = localStorage.getItem('atlas-token');
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  // Only treat 401 as session expiry for non-auth routes
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('atlas:unauthorized'));
  }
  return res;
}

const API = {
  // ── Auth ───────────────────────────────────────────────────────────
  async login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  },

  async getMe() {
    const res = await authFetch('/api/auth/me');
    if (!res.ok) return null;
    return res.json();
  },

  async logout() {
    await authFetch('/api/auth/logout', { method: 'POST' });
  },

  async changePassword(currentPassword, newPassword) {
    const res = await authFetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    return { ok: res.ok, data: await res.json() };
  },

  // ── Mgmt ──────────────────────────────────────────────────────────
  async getProfile() {
    const res = await authFetch('/api/mgmt/profile');
    return res.json();
  },

  async updateProfile(fields) {
    const res = await authFetch('/api/mgmt/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    return res.json();
  },

  async getUsers() {
    const res = await authFetch('/api/mgmt/users');
    return res.json();
  },

  async addUser(fields) {
    const res = await authFetch('/api/mgmt/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    return { ok: res.ok, data: await res.json() };
  },

  async editUser(username, fields) {
    const res = await authFetch(`/api/mgmt/users/${encodeURIComponent(username)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    return { ok: res.ok, data: await res.json() };
  },

  async deleteUser(username) {
    const res = await authFetch(`/api/mgmt/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    return { ok: res.ok, data: await res.json() };
  },

  async getAuditLog(limit = 200) {
    const res = await authFetch(`/api/mgmt/audit-log?limit=${limit}`);
    return res.json();
  },

  async getSystemInfo() {
    const res = await authFetch('/api/mgmt/system');
    return res.json();
  },

  async getGitHubSSOStatus() {
    const res = await fetch('/api/auth/github/status');
    return res.json();
  },

  async githubPreauth(fields) {
    const res = await authFetch('/api/mgmt/users/github-preauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    return { ok: res.ok, data: await res.json() };
  },
  // ── Devices ──────────────────────────────────────────────────────────
  /** Fetch all configured devices. */
  async getDevices() {
    const res = await authFetch('/api/devices');
    return res.json();
  },

  /** Fetch enriched device info (model, EOS version, serial, etc.). */
  async getDeviceInfo() {
    const res = await authFetch('/api/devices/info');
    return res.json();
  },

  /** Fetch gNMI subscriber status for all devices. */
  async getGnmiStatus() {
    const res = await authFetch('/api/gnmi/status');
    return res.json();
  },

  /** Reconnect gNMI streams for a specific device. */
  async reconnectGnmi(deviceName) {
    const res = await authFetch(`/api/gnmi/reconnect/${encodeURIComponent(deviceName)}`, { method: 'POST' });
    return res.json();
  },

  /** Fetch live bandwidth rates (interface rates + edge mappings). */
  async getBandwidth() {
    const res = await authFetch('/api/bandwidth');
    return res.json();
  },

  /** Set a bandwidth override for a specific edge (shaped/policed link). */
  async setBandwidthOverride(edgeId, speedBps, label, notes) {
    const res = await authFetch(`/api/bandwidth/override/${encodeURIComponent(edgeId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speedBps, label, notes }),
    });
    return res.json();
  },

  /** Remove a bandwidth override (revert to physical speed). */
  async removeBandwidthOverride(edgeId) {
    const res = await authFetch(`/api/bandwidth/override/${encodeURIComponent(edgeId)}`, { method: 'DELETE' });
    return res.json();
  },

  /** Fetch device health data (temperature, interface status, LLDP). */
  async getHealth() {
    const res = await authFetch('/api/health');
    return res.json();
  },

  /** Fetch health for a specific device. */
  async getDeviceHealth(deviceName) {
    const res = await authFetch(`/api/health/${encodeURIComponent(deviceName)}`);
    return res.json();
  },

  /** Fetch running config for a specific device. */
  async getDeviceConfig(id) {
    const res = await authFetch(`/api/devices/${id}/config`);
    return res.json();
  },

  /** Add a new device to the inventory. */
  async addDevice(device) {
    const res = await authFetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(device),
    });
    return res.json();
  },

  /** Update fields on an existing device. */
  async updateDevice(id, fields) {
    const res = await authFetch(`/api/devices/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    return res.json();
  },

  /** Delete a device from the inventory. */
  async deleteDevice(id) {
    const res = await authFetch(`/api/devices/${id}`, { method: 'DELETE' });
    return res.json();
  },

  /** Bulk import devices from an array of device objects. */
  async bulkImportDevices(devices) {
    const res = await authFetch('/api/devices/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices }),
    });
    return res.json();
  },

  /** Test eAPI connectivity to a specific device. */
  async testDevice(id) {
    const res = await authFetch(`/api/devices/${id}/test`, { method: 'POST' });
    return res.json();
  },

  /** Run an eAPI command on a device (by hostname). Returns text or JSON. */
  async runCommand(hostname, cmd, format = 'text') {
    const res = await authFetch(`/api/devices/by-hostname/${encodeURIComponent(hostname)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, format }),
    });
    return res.json();
  },

  // ── Topology ─────────────────────────────────────────────────────────
  /** Fetch the current topology graph. Returns null if not yet collected. */
  async getTopology() {
    const res = await authFetch('/api/topology');
    if (res.status === 404) return null;
    return res.json();
  },

  /** Trigger a topology collection cycle. Optionally target a specific device. */
  async collectTopology(deviceId = null) {
    const body = deviceId ? { deviceId } : {};
    const res = await authFetch('/api/topology/collect', {
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

  /** Fetch detail for a specific node by system ID. */
  async getNodeDetail(systemId) {
    const res = await authFetch(`/api/topology/node/${systemId}`);
    if (!res.ok) return null;
    return res.json();
  },

  /** Fetch Remote Node SID reachability (TI-LFA protection status). */
  async getNodeReachability(systemId) {
    const res = await authFetch(`/api/topology/node/${systemId}/reachability`);
    if (!res.ok) return null;
    return res.json();
  },

  // ── Path Computation ──────────────────────────────────────────────
  /** Compute shortest path with optional node/edge failure simulation. */
  async computePath(source, destination, excludeNodes = [], excludeEdges = []) {
    const res = await authFetch('/api/topology/path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination, excludeNodes, excludeEdges }),
    });
    return res.json();
  },

  /** Full path analysis: primary + TI-LFA backup paths with label stacks. */
  async analyzePath(source, destination) {
    const res = await authFetch('/api/topology/path/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination }),
    });
    return res.json();
  },

  /** Compute all ECMP paths between source and destination. */
  async computeECMP(source, destination) {
    const res = await authFetch('/api/topology/path/ecmp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination }),
    });
    return res.json();
  },

  // ── Positions ─────────────────────────────────────────────────────
  /** Fetch saved node positions for layout persistence. */
  async getPositions() {
    const res = await authFetch('/api/topology/positions');
    return res.json();
  },

  /** Save node positions to server for layout persistence. */
  async savePositions(positions) {
    await authFetch('/api/topology/positions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(positions),
    });
  },

  // ── FlexAlgo ──────────────────────────────────────────────────────

  /** Fetch FlexAlgo summary from LSDB: defined algorithms, participation, FADs. */
  async getFlexAlgoSummary() {
    const res = await authFetch('/api/topology/flexalgo/summary');
    if (!res.ok) return null;
    return res.json();
  },

  /** Fetch FlexAlgo computed paths from a specific device via eAPI. */
  async getFlexAlgoPaths(systemId, algo) {
    const res = await authFetch(`/api/topology/flexalgo/paths/${encodeURIComponent(systemId)}/${algo}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'FlexAlgo path query failed');
    }
    return res.json();
  },

  /** Trace a FlexAlgo path between two nodes for a specific algorithm. */
  async traceFlexAlgoPath(source, destination, algorithm) {
    const res = await authFetch('/api/topology/flexalgo/trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination, algorithm }),
    });
    return res.json();
  },

  // ── BGP ───────────────────────────────────────────────────────────

  /** Fetch BGP subsystem status (FRR, gRPC, neighbors, VRFs, prefixes). */
  async getBgpStatus() {
    const res = await authFetch('/api/bgp/status');
    return res.json();
  },

  /** Fetch BGP configuration (local AS, router ID, neighbors, address families). */
  async getBgpConfig() {
    const res = await authFetch('/api/bgp/config');
    return res.json();
  },

  /** Deploy BGP configuration to FRR (generates frr.conf + restarts service). */
  async deployBgpConfig(config) {
    const res = await authFetch('/api/bgp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.json();
  },

  /** Preview the FRR config that would be generated (without deploying). */
  async previewBgpConfig(config) {
    const res = await authFetch('/api/bgp/config/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return res.json();
  },

  /** Fetch BGP neighbor session summary. */
  async getBgpNeighbors() {
    const res = await authFetch('/api/bgp/neighbors');
    return res.json();
  },

  /** Fetch VRFs grouped by RD. */
  async getBgpVrfs() {
    const res = await authFetch('/api/bgp/vrfs');
    return res.json();
  },

  /** Fetch VRFs grouped by Route Target (preferred for display). */
  async getBgpVrfsByRT() {
    const res = await authFetch('/api/bgp/vrfs/by-rt');
    return res.json();
  },

  /** Fetch filtered VPNv4 RIB entries with pagination. */
  async getBgpRib(filters = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== '') params.set(k, v);
    }
    const res = await authFetch(`/api/bgp/rib?${params}`);
    return res.json();
  },

  /** Trigger a BGP collection cycle (vtysh queries to FRR). */
  async collectBgp() {
    const res = await authFetch('/api/bgp/collect', { method: 'POST' });
    return res.json();
  },

  /** Fetch a flat sorted list of all known VPN prefixes for autocomplete. */
  async getBgpPrefixList() {
    const res = await authFetch('/api/bgp/prefix-list');
    return res.json();
  },

  /** Fetch full BGP path detail for a specific VPN prefix. */
  async getBgpPrefixDetail(prefix) {
    const res = await authFetch(`/api/bgp/prefix/${encodeURIComponent(prefix)}`);
    return res.json();
  },

  /**
   * Trace the end-to-end service path for a VPN prefix.
   * Detects Color community steering and resolves the full label stack.
   * @param {string} sourceNode - Source PE hostname
   * @param {string} prefix - Destination VPN prefix (e.g., "92.1.1.2/32")
   * @param {string} [vrf] - Route Target to disambiguate overlapping prefixes
   * @param {number} [algoOverride] - Algorithm override for "What if" simulation
   */
  async traceServicePath(sourceNode, prefix, vrf, algoOverride) {
    const body = { sourceNode, prefix };
    if (vrf) body.vrf = vrf;
    if (algoOverride != null) body.algoOverride = algoOverride;
    const res = await authFetch('/api/bgp/trace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },

  // ── sFlow ─────────────────────────────────────────────────────────

  /** Fetch sFlow collector + aggregator status. */
  async getSflowStatus() {
    const res = await authFetch('/api/sflow/status');
    return res.json();
  },

  /** Fetch current flow snapshot (all LSPs + edge flows). */
  async getSflowFlows() {
    const res = await authFetch('/api/sflow/flows');
    return res.json();
  },

  /** Fetch deterministic tunnel counter rates from eAPI polling. */
  async getTunnelRates() {
    const res = await authFetch('/api/sflow/tunnel-rates');
    return res.json();
  },

  /** Fetch detailed flow data for a specific LSP. */
  async getSflowLspDetail(lspKey) {
    const res = await authFetch(`/api/sflow/lsp/${encodeURIComponent(lspKey)}`);
    if (!res.ok) return null;
    return res.json();
  },

  /** Fetch flow data for a specific topology edge. */
  async getSflowEdgeDetail(edgeId) {
    const res = await authFetch(`/api/sflow/edge/${encodeURIComponent(edgeId)}`);
    if (!res.ok) return null;
    return res.json();
  },

  /** Generate Arista EOS sFlow config snippet. */
  async getSflowEosConfig(collectorIP, samplingRate = 1024) {
    const params = new URLSearchParams();
    if (collectorIP) params.set('collectorIP', collectorIP);
    if (samplingRate) params.set('samplingRate', samplingRate);
    const res = await authFetch(`/api/sflow/config/eos?${params}`);
    return res.json();
  },
};
