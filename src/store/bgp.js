// ---------------------------------------------------------------------------
// BGP Store — In-Memory BGP State
// ---------------------------------------------------------------------------
// Holds the current BGP state collected from FRR: VRFs, VPNv4 RIB entries,
// neighbor sessions, and (future) BGP-LS data.
//
// Emits events when data changes so the poller/WebSocket layer can push
// updates to connected frontends.
//
// Data flow:
//   FRR → bgpGrpc/vtysh → bgpParser → bgpStore → REST API / WebSocket
//
// Thread safety:
//   Node.js is single-threaded, so no locking needed. Updates are atomic
//   from the event loop's perspective.
// ---------------------------------------------------------------------------

const EventEmitter = require('events');

class BgpStore extends EventEmitter {
  constructor() {
    super();

    // ── VRF State ──
    // Map<rd, { rd, name, rtImport[], rtExport[], prefixes[], prefixCount }>
    this.vrfs = new Map();

    // ── VPNv4 RIB ──
    // Full RIB: [{ prefix, prefixLen, rd, nextHop, label, originPE, ... }]
    this.rib = [];

    // ── BGP Neighbors ──
    // [{ address, remoteAs, state, uptime, prefixReceived, afis[], ... }]
    this.neighbors = [];

    // ── BGP-LS State (Phase 4) ──
    this.bgpLsNodes = [];
    this.bgpLsLinks = [];
    this.bgpLsPrefixes = [];

    // ── Metadata ──
    this.lastUpdated = null;
    this.lastError = null;
    this.collecting = false;
  }

  // ── VRF Operations ────────────────────────────────────────────────

  /**
   * Replace the entire VRF dataset.
   * @param {Map<string, Object>} vrfs - Parsed VRF map from bgpParser.
   */
  setVrfs(vrfs) {
    this.vrfs = vrfs;
    this.lastUpdated = new Date().toISOString();
    this.emit('vrfs:updated', this.getVrfSummary());
  }

  /**
   * Get all VRFs as a summary list (without full prefix arrays).
   * @returns {Object[]}
   */
  getVrfSummary() {
    return Array.from(this.vrfs.values()).map((vrf) => ({
      rd: vrf.rd,
      name: vrf.name,
      rtImport: vrf.rtImport,
      rtExport: vrf.rtExport,
      prefixCount: vrf.prefixCount,
    }));
  }

  /**
   * Get a specific VRF by RD, including its full prefix list.
   * @param {string} rd - Route Distinguisher.
   * @returns {Object|null}
   */
  getVrf(rd) {
    return this.vrfs.get(rd) || null;
  }

  /**
   * Get all VRF RDs.
   * @returns {string[]}
   */
  getVrfRDs() {
    return Array.from(this.vrfs.keys());
  }

  // ── RIB Operations ────────────────────────────────────────────────

  /**
   * Replace the entire VPNv4 RIB.
   * @param {Object[]} rib - Parsed RIB entries from bgpParser.
   */
  setRib(rib) {
    this.rib = rib;
    this.lastUpdated = new Date().toISOString();
    this.emit('rib:updated', { count: rib.length });
  }

  /**
   * Get RIB entries with optional filtering.
   *
   * @param {Object} [filters] - Optional filter criteria.
   * @param {string} [filters.rd] - Filter by Route Distinguisher.
   * @param {string} [filters.prefix] - Filter by prefix (substring match).
   * @param {string} [filters.nextHop] - Filter by next-hop address.
   * @param {string} [filters.rt] - Filter by Route Target.
   * @param {string} [filters.originPE] - Filter by originating PE hostname.
   * @param {boolean} [filters.bestOnly] - Only return best paths.
   * @param {number} [filters.limit] - Max results.
   * @param {number} [filters.offset] - Pagination offset.
   * @returns {{ entries: Object[], total: number, filtered: number }}
   */
  getRib(filters = {}) {
    let entries = this.rib;

    if (filters.rd) {
      entries = entries.filter((e) => e.rd === filters.rd);
    }
    if (filters.prefix) {
      const search = filters.prefix.toLowerCase();
      entries = entries.filter((e) =>
        `${e.prefix}/${e.prefixLen}`.toLowerCase().includes(search)
      );
    }
    if (filters.nextHop) {
      entries = entries.filter((e) => e.nextHop === filters.nextHop);
    }
    if (filters.rt) {
      entries = entries.filter((e) =>
        e.extCommunities.some((c) => c.type === 'RT' && c.value === filters.rt)
      );
    }
    if (filters.originPE) {
      const search = filters.originPE.toLowerCase();
      entries = entries.filter((e) =>
        e.originPE.toLowerCase().includes(search)
      );
    }
    if (filters.bestOnly) {
      entries = entries.filter((e) => e.bestpath);
    }

    const total = this.rib.length;
    const filtered = entries.length;

    // Pagination
    const offset = filters.offset || 0;
    const limit = filters.limit || 500;
    entries = entries.slice(offset, offset + limit);

    return { entries, total, filtered };
  }

  // ── Neighbor Operations ───────────────────────────────────────────

  /**
   * Replace the neighbor list.
   * @param {Object[]} neighbors - Parsed neighbor entries.
   */
  setNeighbors(neighbors) {
    this.neighbors = neighbors;
    this.emit('neighbors:updated', neighbors);
  }

  /**
   * Get all BGP neighbors.
   * @returns {Object[]}
   */
  getNeighbors() {
    return this.neighbors;
  }

  // ── BGP-LS Operations (Phase 4) ──────────────────────────────────

  setBgpLs(nodes, links, prefixes) {
    this.bgpLsNodes = nodes;
    this.bgpLsLinks = links;
    this.bgpLsPrefixes = prefixes;
    this.emit('bgpls:updated', {
      nodeCount: nodes.length,
      linkCount: links.length,
      prefixCount: prefixes.length,
    });
  }

  getBgpLs() {
    return {
      nodes: this.bgpLsNodes,
      links: this.bgpLsLinks,
      prefixes: this.bgpLsPrefixes,
    };
  }

  // ── Status ────────────────────────────────────────────────────────

  /**
   * Get overall BGP subsystem status.
   * @returns {Object}
   */
  getStatus() {
    return {
      collecting: this.collecting,
      lastUpdated: this.lastUpdated,
      lastError: this.lastError,
      vrfCount: this.vrfs.size,
      ribCount: this.rib.length,
      neighborCount: this.neighbors.length,
      neighborsEstablished: this.neighbors.filter(
        (n) => n.state === 'Established'
      ).length,
    };
  }

  /**
   * Mark collection as in-progress.
   */
  setCollecting(state) {
    this.collecting = state;
    this.emit('status:changed', this.getStatus());
  }

  /**
   * Record a collection error.
   */
  setError(err) {
    this.lastError = {
      message: err.message || String(err),
      timestamp: new Date().toISOString(),
    };
    this.emit('status:changed', this.getStatus());
  }

  /**
   * Clear all BGP data (used on config change / reset).
   */
  clear() {
    this.vrfs.clear();
    this.rib = [];
    this.neighbors = [];
    this.bgpLsNodes = [];
    this.bgpLsLinks = [];
    this.bgpLsPrefixes = [];
    this.lastUpdated = null;
    this.lastError = null;
    this.emit('status:changed', this.getStatus());
  }
}

// Singleton instance
const bgpStore = new BgpStore();

module.exports = bgpStore;
