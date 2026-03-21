// ---------------------------------------------------------------------------
// IS-IS LSDB Parser
// ---------------------------------------------------------------------------
// Parses Arista EOS eAPI output from IS-IS commands into a normalized
// graph-friendly data model.
//
// Phase 1: Nodes (system-id, hostname), Adjacencies (neighbors + metrics),
//          and IP Reachability (connected prefixes).
// Phase 2: SR Prefix-SIDs, Adjacency-SIDs (future)
// Phase 3: FlexAlgo participation (future)
// ---------------------------------------------------------------------------

/**
 * Parse the output of `show isis database detail` (JSON format).
 *
 * @param {Object} raw - Raw eAPI JSON result for `show isis database detail`
 * @returns {Object} - { nodes: Map<systemId, NodeInfo>, adjacencies: [] }
 */
function parseLSDB(raw) {
  const nodes = new Map();
  const adjacencies = [];

  // Navigate the nested eAPI structure:
  // vrfs -> <vrf> -> isisInstances -> <instance> -> level -> <level> -> lsps
  const vrfs = raw.vrfs || {};

  for (const [vrfName, vrfData] of Object.entries(vrfs)) {
    const instances = vrfData.isisInstances || {};

    for (const [instanceName, instanceData] of Object.entries(instances)) {
      const levels = instanceData.level || {};

      for (const [levelNum, levelData] of Object.entries(levels)) {
        const lsps = levelData.lsps || {};

        for (const [lspId, lspData] of Object.entries(lsps)) {
          // Only process fragment 0 (the main LSP) for node-level info
          // Fragment format: <hostname>.XX-YY where XX=pseudonode, YY=fragment
          const isFragment0 = lspId.endsWith('.00-00') || lspId.endsWith('.00-00');
          const isPseudonode = !lspId.match(/\.00-\d+$/);

          if (isPseudonode) continue; // Skip pseudonode LSPs for now

          const systemId = lspData.systemId || extractSystemId(lspId);
          const hostname = lspData.dynamicHostname || lspId.split('.')[0];

          // Build or update node entry
          if (!nodes.has(systemId)) {
            nodes.set(systemId, {
              systemId,
              hostname,
              lspId,
              level: parseInt(levelNum),
              instance: instanceName,
              vrf: vrfName,
              sequenceNumber: lspData.sequenceNumber || 0,
              remainingLifetime: lspData.remainingLifetime || 0,
              prefixes: [],
              neighbors: [],
              srPrefixSids: [],   // Phase 2
              srAdjSids: [],      // Phase 2
              flexAlgos: [],      // Phase 3
            });
          }

          const node = nodes.get(systemId);
          node.sequenceNumber = lspData.sequenceNumber || node.sequenceNumber;
          node.remainingLifetime = lspData.remainingLifetime || node.remainingLifetime;

          // Parse TLVs from the LSP
          const tlvs = lspData.tlvs || lspData.lspTlvs || {};
          parseNodeTlvs(node, tlvs, adjacencies, levelNum);
        }
      }
    }
  }

  return { nodes, adjacencies };
}

/**
 * Parse TLVs from an individual LSP and populate node data + adjacencies.
 */
function parseNodeTlvs(node, tlvs, adjacencies, level) {
  // --- Extended IS Reachability (TLV 22) — Neighbors ---
  const isReach = tlvs.extendedIsReachability || tlvs.isisNeighbors || [];
  if (Array.isArray(isReach)) {
    for (const neighbor of isReach) {
      const neighborId = neighbor.neighborId || neighbor.systemId || '';
      const metric = neighbor.metric || neighbor.defaultMetric || 10;
      const localIntf = neighbor.localInterface || '';
      const remoteIntf = neighbor.remoteInterface || '';

      node.neighbors.push({ neighborId, metric, localIntf, remoteIntf });

      adjacencies.push({
        fromSystemId: node.systemId,
        fromHostname: node.hostname,
        toSystemId: neighborId.replace(/\.\d+$/, ''), // strip pseudonode suffix
        metric: metric,
        level: parseInt(level),
        localIntf,
        remoteIntf,
      });
    }
  }

  // --- Extended IP Reachability (TLV 135) — Prefixes ---
  const ipReach = tlvs.extendedIpReachability || tlvs.ipv4Prefixes || [];
  if (Array.isArray(ipReach)) {
    for (const prefix of ipReach) {
      node.prefixes.push({
        prefix: prefix.prefix || prefix.ipPrefix || '',
        mask: prefix.mask || prefix.prefixLength || 0,
        metric: prefix.metric || 0,
      });
    }
  }

  // --- IPv6 Reachability (TLV 236) ---
  const ipv6Reach = tlvs.ipv6Reachability || tlvs.ipv6Prefixes || [];
  if (Array.isArray(ipv6Reach)) {
    for (const prefix of ipv6Reach) {
      node.prefixes.push({
        prefix: prefix.prefix || prefix.ipv6Prefix || '',
        mask: prefix.mask || prefix.prefixLength || 0,
        metric: prefix.metric || 0,
        family: 'ipv6',
      });
    }
  }
}

/**
 * Extract system ID from an LSP ID string.
 * e.g., "pe1.00-00" doesn't have a system-id; real ones look like "0100.0000.0001.00-00"
 */
function extractSystemId(lspId) {
  // Match dotted system-id pattern: XXXX.XXXX.XXXX
  const match = lspId.match(/(\d{4}\.\d{4}\.\d{4})/);
  return match ? match[1] : lspId.split('.')[0];
}

/**
 * Convenience: parse `show isis neighbors` output for adjacency state.
 *
 * @param {Object} raw - eAPI result for `show isis neighbors`
 * @returns {Object[]} - Array of { systemId, hostname, interface, state, level }
 */
function parseNeighbors(raw) {
  const neighbors = [];
  const instances = raw.isisInstances || {};

  for (const [_instName, instData] of Object.entries(instances)) {
    const nbrs = instData.neighbors || {};

    for (const [_nbrKey, nbrData] of Object.entries(nbrs)) {
      const adjList = nbrData.adjacencies || [];

      for (const adj of adjList) {
        neighbors.push({
          systemId: adj.systemId || '',
          hostname: adj.hostname || '',
          interface: adj.interfaceName || '',
          state: adj.state || adj.adjState || '',
          level: adj.level || 0,
          holdTime: adj.holdTime || 0,
        });
      }
    }
  }

  return neighbors;
}

module.exports = { parseLSDB, parseNeighbors };
