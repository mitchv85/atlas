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
 *   {
 *     "routes": {
 *       "routeDistinguishers": {
 *         "100.0.0.1:91": {
 *           "30.91.100.0/30": [ { path attributes... } ],
 *           "91.0.0.1/32":   [ { path attributes... } ]
 *         }
 *       }
 *     },
 *     "totalRoutes": 24
 *   }
 *
 * Path attributes include:
 *   valid, bestpath, selectionReason, pathFrom, prefix, prefixLen,
 *   network, locPrf, weight, peerId, path (AS path), origin,
 *   nexthops: [{ ip, afi, used }],
 *   extendedCommunity (when available), remoteLabel (when available)
 *
 * @param {Object} raw - Raw vtysh JSON output.
 * @returns {{ vrfs: Map<string, Object>, rib: Object[] }}
 */
function parseVpnv4Rib(raw) {
  const vrfs = new Map();
  const rib = [];

  // FRR nests VPNv4 routes under routes.routeDistinguishers.{RD}.{prefix/len}
  const rds = raw.routes?.routeDistinguishers || {};

  for (const [rd, prefixes] of Object.entries(rds)) {
    // Ensure VRF entry exists for this RD
    if (!vrfs.has(rd)) {
      vrfs.set(rd, {
        rd,
        name: '', // Populated later via eAPI enrichment
        rtImport: [],
        rtExport: [],
        prefixes: [],
        prefixCount: 0,
        samplePrefix: '', // Used to fetch RT via detail query
      });
    }

    const vrf = vrfs.get(rd);

    for (const [prefixKey, paths] of Object.entries(prefixes)) {
      // prefixKey format: "30.91.100.0/30"
      const slashIdx = prefixKey.indexOf('/');
      if (slashIdx === -1) continue;

      const prefix = prefixKey.substring(0, slashIdx);
      const prefixLen = parseInt(prefixKey.substring(slashIdx + 1), 10);

      // Track a sample prefix for RT lookup
      if (!vrf.samplePrefix) vrf.samplePrefix = prefixKey;

      for (const p of (Array.isArray(paths) ? paths : [paths])) {
        // Extract next-hop from the nexthops array
        const nextHop = p.nexthops?.[0]?.ip || p.nexthop || '';

        const entry = {
          prefix,
          prefixLen,
          rd,
          nextHop,
          label: p.remoteLabel || p.label || null,
          asPath: p.path || p.aspath || '',
          origin: p.origin || '',
          locPref: p.locPrf || 100,
          med: p.med || p.metric || 0,
          weight: p.weight || 0,
          communities: parseCommunities(p.community),
          extCommunities: parseExtCommunities(p.extendedCommunity || p.extCommunity),
          originatorId: p.originatorId || '',
          clusterList: p.clusterList?.list || (Array.isArray(p.clusterList) ? p.clusterList : []),
          valid: p.valid !== false,
          bestpath: p.bestpath === true || p.bestpath?.overall === true,
          selectionReason: p.selectionReason || p.bestpath?.selectionReason || '',
          peer: p.peerId || '',
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
    }

    vrf.prefixCount = vrf.prefixes.length;
  }

  return { vrfs, rib };
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
 * Handles both string format and FRR object format: { string: "RT:91:91" }
 * @param {Object|string} raw - Extended community data from FRR.
 * @returns {{ type: string, value: string }[]}
 */
function parseExtCommunities(raw) {
  if (!raw) return [];

  const results = [];

  // FRR object format: { string: "RT:91:91 RT:92:92" }
  let items;
  if (typeof raw === 'string') {
    items = raw.split(/\s+/);
  } else if (raw.string) {
    items = raw.string.split(/\s+/);
  } else if (Array.isArray(raw)) {
    items = raw.map(String);
  } else {
    return [];
  }

  for (const item of items) {
    const str = typeof item === 'string' ? item : String(item);

    // Route Target: "RT:65000:100" or "RT:91:91"
    const rtMatch = str.match(/^RT:(.+)$/i);
    if (rtMatch) {
      results.push({ type: 'RT', value: rtMatch[1] });
      continue;
    }

    // Route Origin / Site of Origin
    const soMatch = str.match(/^SoO:(.+)$/i);
    if (soMatch) {
      results.push({ type: 'SoO', value: soMatch[1] });
      continue;
    }

    // Generic extended community
    if (str.trim()) {
      results.push({ type: 'unknown', value: str });
    }
  }

  return results;
}

/**
 * Parse per-prefix VPNv4 detail output to extract Route Targets and labels.
 * Input: `vtysh -c "show bgp ipv4 vpn <prefix> json"` parsed as object.
 *
 * FRR per-prefix detail structure:
 *   {
 *     "100.0.0.1:91": {
 *       "prefix": "91.0.0.1/32",
 *       "paths": [{
 *         "extendedCommunity": { "string": "RT:91:91" },
 *         "remoteLabel": 100000,
 *         "originatorId": "100.0.0.1",
 *         "clusterList": { "list": ["100.0.0.7"] },
 *         ...
 *       }]
 *     }
 *   }
 *
 * @param {Object} raw - Raw vtysh JSON output for a specific prefix.
 * @returns {{ rd: string, rts: string[], label: number|null, originatorId: string }[]}
 */
function parsePrefixDetail(raw) {
  const results = [];

  for (const [rd, data] of Object.entries(raw)) {
    const prefix = data.prefix || '';
    const paths = data.paths || [];

    for (const p of paths) {
      const extComms = parseExtCommunities(p.extendedCommunity);
      const rts = extComms.filter(c => c.type === 'RT').map(c => c.value);
      const stdComms = parseCommunities(p.community);

      // AS path — can be string or structured object
      let asPath = '';
      if (typeof p.aspath === 'string') {
        asPath = p.aspath;
      } else if (p.aspath?.string) {
        asPath = p.aspath.string;
      }

      results.push({
        rd,
        prefix,
        rts,
        extCommunities: extComms,
        communities: stdComms,
        label: p.remoteLabel || null,
        origin: p.origin || '',
        asPath,
        locPref: p.locPrf || p.locPref || 100,
        med: p.med || p.metric || 0,
        weight: p.weight || 0,
        valid: p.valid !== false,
        bestpath: p.bestpath?.overall || false,
        selectionReason: p.bestpath?.selectionReason || '',
        originatorId: p.originatorId || '',
        clusterList: p.clusterList?.list || (Array.isArray(p.clusterList) ? p.clusterList : []),
        peer: p.peer?.peerId || '',
        peerRouterId: p.peer?.routerId || '',
        peerType: p.peer?.type || '',
        nextHop: p.nexthops?.[0]?.ip || '',
        nextHopMetric: p.nexthops?.[0]?.metric ?? null,
        nextHopAccessible: p.nexthops?.[0]?.accessible ?? null,
        lastUpdate: p.lastUpdate?.string || '',
      });
    }
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
  parsePrefixDetail,
  parseCommunities,
  parseExtCommunities,
  parseNeighborSummary,
  enrichWithTopology,
  parseBgpLsNodes,
  parseBgpLsLinks,
  parseBgpLsPrefixes,
};
