// ---------------------------------------------------------------------------
// BGP Parser — VPNv4 RIB + BGP-LS Normalization
// ---------------------------------------------------------------------------
// Parses BGP data from FRR (via gRPC YANG responses or vtysh JSON fallback)
// into ATLAS's normalized data model.
//
// Two input formats supported:
//   1. YANG/gRPC — structured YANG data from FRR northbound Get/Subscribe
//   2. vtysh JSON — output of `vtysh -c "show bgp ipv4 vpn json"` etc.
//
// Output model (VPNv4):
//   VRFs:    Map<rd, { rd, rtImport[], rtExport[], name, prefixes[] }>
//   RIB:     [{ prefix, prefixLen, rd, nextHop, label, originPE, asPath,
//               communities, extCommunities, originatorId, clusterList }]
//
// Output model (BGP-LS) — Phase 4:
//   Nodes:   [{ routerId, asn, igpId, protocols, srCaps }]
//   Links:   [{ localNode, remoteNode, igpMetric, teMetric, adjSids }]
//   Prefixes:[{ prefix, igpMetric, srPrefixSid }]
// ---------------------------------------------------------------------------

/**
 * Parse VPNv4 RIB from vtysh JSON output.
 * Input: `vtysh -c "show bgp ipv4 vpn json"` parsed as object.
 *
 * FRR's VPNv4 JSON structure:
 *   { "routes": { "RD:prefix/len": [ { path attributes... } ] } }
 *
 * @param {Object} raw - Raw vtysh JSON output.
 * @returns {{ vrfs: Map<string, Object>, rib: Object[] }}
 */
function parseVpnv4Rib(raw) {
  const vrfs = new Map();
  const rib = [];

  const routes = raw.routes || {};

  for (const [routeKey, paths] of Object.entries(routes)) {
    // routeKey format: "RD:prefix/length" e.g. "100.0.0.1:1:10.0.0.0/24"
    const rdSepIdx = routeKey.indexOf(':');
    if (rdSepIdx === -1) continue;

    // RD can contain colons (e.g., "100.0.0.1:1"), so we need smarter parsing.
    // VPNv4 route keys: "RD prefix/len" — FRR uses space or : as separator.
    // Try to parse by finding the prefix portion (contains a slash).
    const { rd, prefix, prefixLen } = parseVpnv4RouteKey(routeKey);
    if (!rd) continue;

    // Ensure VRF entry exists for this RD
    if (!vrfs.has(rd)) {
      vrfs.set(rd, {
        rd,
        name: '', // Populated later via eAPI enrichment
        rtImport: [],
        rtExport: [],
        prefixes: [],
        prefixCount: 0,
      });
    }

    const vrf = vrfs.get(rd);

    for (const p of (Array.isArray(paths) ? paths : [paths])) {
      const entry = {
        prefix,
        prefixLen,
        rd,
        nextHop: p.nexthop || p.nextHop || '',
        label: p.remoteLabel || p.label || null,
        asPath: p.aspath || p.asPath || '',
        origin: p.origin || '',
        locPref: p.locPrf || p.localPreference || 100,
        med: p.med || p.metric || 0,
        communities: parseCommunities(p.community),
        extCommunities: parseExtCommunities(p.extendedCommunity || p.extCommunity),
        originatorId: p.originatorId || '',
        clusterList: p.clusterList || [],
        valid: p.valid !== false,
        bestpath: p.bestpath || p.best || false,
        peer: p.peerId || p.peer || '',
        originPE: '', // Resolved later by cross-referencing topology
      };

      rib.push(entry);

      // Add to VRF prefix list (best paths only to avoid duplicates)
      if (entry.bestpath) {
        vrf.prefixes.push({
          prefix: `${prefix}/${prefixLen}`,
          nextHop: entry.nextHop,
          label: entry.label,
          asPath: entry.asPath,
        });
      }

      // Extract RTs from extended communities
      for (const ext of entry.extCommunities) {
        if (ext.type === 'RT') {
          if (!vrf.rtImport.includes(ext.value)) vrf.rtImport.push(ext.value);
          if (!vrf.rtExport.includes(ext.value)) vrf.rtExport.push(ext.value);
        }
      }
    }

    vrf.prefixCount = vrf.prefixes.length;
  }

  return { vrfs, rib };
}

/**
 * Parse a VPNv4 route key into its components.
 * Handles both FRR formats:
 *   "100.0.0.1:1:10.0.0.0/24" (colon-separated)
 *   "100.0.0.1:1 10.0.0.0/24" (space-separated)
 *
 * @param {string} key - Raw route key.
 * @returns {{ rd: string, prefix: string, prefixLen: number }}
 */
function parseVpnv4RouteKey(key) {
  // Try space-separated first (cleaner)
  const spaceIdx = key.indexOf(' ');
  if (spaceIdx > 0) {
    const rd = key.substring(0, spaceIdx);
    const prefixStr = key.substring(spaceIdx + 1);
    const slashIdx = prefixStr.indexOf('/');
    if (slashIdx > 0) {
      return {
        rd,
        prefix: prefixStr.substring(0, slashIdx),
        prefixLen: parseInt(prefixStr.substring(slashIdx + 1), 10),
      };
    }
  }

  // Fall back to colon-separated: find the last segment with a slash
  const parts = key.split(':');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes('/')) {
      const rd = parts.slice(0, i).join(':');
      const prefixStr = parts[i];
      const slashIdx = prefixStr.indexOf('/');
      return {
        rd,
        prefix: prefixStr.substring(0, slashIdx),
        prefixLen: parseInt(prefixStr.substring(slashIdx + 1), 10),
      };
    }
  }

  return { rd: null, prefix: null, prefixLen: null };
}

/**
 * Parse BGP standard communities.
 * @param {Object|string} raw - Community data from FRR.
 * @returns {string[]} Normalized community strings.
 */
function parseCommunities(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  if (raw.string) return raw.string.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

/**
 * Parse BGP extended communities (Route Targets, etc.).
 * @param {Object|string} raw - Extended community data from FRR.
 * @returns {{ type: string, value: string }[]}
 */
function parseExtCommunities(raw) {
  if (!raw) return [];

  const results = [];
  const items = typeof raw === 'string' ? raw.split(/\s+/) : (Array.isArray(raw) ? raw : []);

  for (const item of items) {
    const str = typeof item === 'string' ? item : (item.string || String(item));

    // Route Target: "RT:65000:100" or "rt 65000:100"
    const rtMatch = str.match(/^(?:RT:|rt\s*)(\S+)$/i);
    if (rtMatch) {
      results.push({ type: 'RT', value: rtMatch[1] });
      continue;
    }

    // Route Origin / Site of Origin
    const soMatch = str.match(/^(?:SoO:|soo\s*)(\S+)$/i);
    if (soMatch) {
      results.push({ type: 'SoO', value: soMatch[1] });
      continue;
    }

    // Generic extended community
    results.push({ type: 'unknown', value: str });
  }

  return results;
}

/**
 * Parse BGP neighbor summary from vtysh JSON.
 * Input: `vtysh -c "show bgp summary json"` parsed as object.
 *
 * @param {Object} raw - Raw vtysh JSON output.
 * @returns {Object[]} Normalized neighbor entries.
 */
function parseNeighborSummary(raw) {
  const neighbors = [];

  // FRR format: { "ipv4Unicast": { "peers": { "10.0.0.1": { ... } } } }
  // Also check "ipv4Vpn" and "linkStateLinkState"
  const afis = ['ipv4Vpn', 'ipv4Unicast', 'linkStateLinkState', 'l2VpnEvpn'];

  for (const afi of afis) {
    const afiData = raw[afi];
    if (!afiData?.peers) continue;

    for (const [peerAddr, peer] of Object.entries(afiData.peers)) {
      // Avoid duplicates (same peer may appear in multiple AFIs)
      const existing = neighbors.find(n => n.address === peerAddr);
      if (existing) {
        existing.afis.push(afi);
        continue;
      }

      neighbors.push({
        address: peerAddr,
        remoteAs: peer.remoteAs || 0,
        state: peer.state || 'unknown',
        uptime: peer.peerUptimeMsec || 0,
        uptimeFormatted: peer.peerUptime || '',
        prefixReceived: peer.pfxRcd || 0,
        prefixSent: peer.pfxSnt || 0,
        description: peer.desc || '',
        afis: [afi],
      });
    }
  }

  return neighbors;
}

/**
 * Map VPNv4 next-hops to PE hostnames by cross-referencing the IS-IS topology.
 * This enriches the RIB entries with the originating PE node name.
 *
 * @param {Object[]} rib - Parsed VPNv4 RIB entries.
 * @param {Object} topology - Current ATLAS topology data.
 * @returns {Object[]} Enriched RIB entries with originPE populated.
 */
function enrichWithTopology(rib, topology) {
  if (!topology?.nodes) return rib;

  // Build a lookup: loopback IP → hostname
  const loopbackLookup = new Map();
  for (const node of topology.nodes) {
    const d = node.data;
    // Interface addresses include loopback IPs
    for (const addr of (d.interfaceAddresses || [])) {
      loopbackLookup.set(addr, d.hostname);
    }
    // Router capabilities router-id
    if (d.routerCaps?.routerId) {
      loopbackLookup.set(d.routerCaps.routerId, d.hostname);
    }
  }

  for (const entry of rib) {
    entry.originPE = loopbackLookup.get(entry.nextHop) || '';
  }

  return rib;
}

// ---------------------------------------------------------------------------
// BGP-LS Parsing (Phase 4 — structure ready, implementation deferred)
// ---------------------------------------------------------------------------

/**
 * Parse BGP-LS node NLRI data.
 * @param {Object} raw - BGP-LS node data from FRR.
 * @returns {Object[]} Normalized BGP-LS node entries.
 */
function parseBgpLsNodes(raw) {
  // Phase 4 implementation
  return [];
}

/**
 * Parse BGP-LS link NLRI data.
 * @param {Object} raw - BGP-LS link data from FRR.
 * @returns {Object[]} Normalized BGP-LS link entries.
 */
function parseBgpLsLinks(raw) {
  // Phase 4 implementation
  return [];
}

/**
 * Parse BGP-LS prefix NLRI data.
 * @param {Object} raw - BGP-LS prefix data from FRR.
 * @returns {Object[]} Normalized BGP-LS prefix entries.
 */
function parseBgpLsPrefixes(raw) {
  // Phase 4 implementation
  return [];
}

module.exports = {
  parseVpnv4Rib,
  parseVpnv4RouteKey,
  parseCommunities,
  parseExtCommunities,
  parseNeighborSummary,
  enrichWithTopology,
  parseBgpLsNodes,
  parseBgpLsLinks,
  parseBgpLsPrefixes,
};
