// ---------------------------------------------------------------------------
// Topology Builder
// ---------------------------------------------------------------------------
// Converts parsed IS-IS LSDB data into a Cytoscape.js-compatible graph model.
// Now includes SR Prefix SIDs, Adj-SIDs, and Router Capabilities.
// ---------------------------------------------------------------------------

/**
 * Build a Cytoscape.js graph from parsed LSDB data.
 *
 * @param {Map}    nodesMap    - Map<systemId, NodeInfo> from parseLSDB
 * @param {Array}  adjacencies - Adjacency list from parseLSDB
 * @returns {Object} - { nodes: [], edges: [], metadata: {} }
 */
function buildGraph(nodesMap, adjacencies) {
  const cyNodes = [];
  const cyEdges = [];
  const edgeSet = new Map(); // Deduplicate bidirectional adjacencies

  // --- Build Nodes ---
  for (const [systemId, nodeInfo] of nodesMap) {
    cyNodes.push({
      data: {
        id: systemId,
        label: nodeInfo.hostname || systemId,
        systemId: nodeInfo.systemId,
        hostname: nodeInfo.hostname,
        level: nodeInfo.level,
        instance: nodeInfo.instance,
        lspId: nodeInfo.lspId,
        sequenceNumber: nodeInfo.sequenceNumber,
        checksum: nodeInfo.checksum,
        remainingLifetime: nodeInfo.remainingLifetime,
        overload: nodeInfo.overload,
        areaAddresses: nodeInfo.areaAddresses,
        interfaceAddresses: nodeInfo.interfaceAddresses,
        prefixCount: nodeInfo.prefixes.length,
        prefixes: nodeInfo.prefixes,
        neighborCount: nodeInfo.neighborList.length,
        // SR data
        srPrefixSids: nodeInfo.srPrefixSids,
        srAdjSids: nodeInfo.srAdjSids,
        routerCaps: nodeInfo.routerCaps,
      },
    });
  }

  // --- Build Edges (deduplicated, with both directions' data) ---
  for (const adj of adjacencies) {
    // Create a canonical edge key so A->B and B->A become one edge
    const edgeKey = [adj.fromSystemId, adj.toSystemId].sort().join('|');

    if (edgeSet.has(edgeKey)) {
      // Already have this edge — enrich with reverse direction info
      const existing = edgeSet.get(edgeKey);
      existing.data.reverseMetric = adj.metric;
      existing.data.reverseLocalAddr = adj.localAddr;
      existing.data.reverseNeighborAddr = adj.neighborAddr;
      existing.data.reverseAdjSids = adj.adjSids;
      // Figure out which direction label to assign
      if (existing.data.source === adj.toSystemId) {
        // This adjacency is from target->source, so it's the reverse
        existing.data.reverseHostname = adj.fromHostname;
      }
      continue;
    }

    const fromNode = nodesMap.get(adj.fromSystemId);
    const toNode = nodesMap.get(adj.toSystemId);

    const edgeData = {
      data: {
        id: `edge-${edgeKey.replace('|', '-')}`,
        _edgeKey: edgeKey,
        source: adj.fromSystemId,
        target: adj.toSystemId,
        sourceLabel: fromNode?.hostname || adj.fromHostname || adj.fromSystemId,
        targetLabel: toNode?.hostname || adj.toHostname || adj.toSystemId,
        metric: adj.metric,
        level: adj.level,
        // Forward direction (source -> target)
        localAddr: adj.localAddr,
        neighborAddr: adj.neighborAddr,
        adjSids: adj.adjSids,
        // Reverse direction (target -> source) — populated on second pass
        reverseMetric: null,
        reverseLocalAddr: null,
        reverseNeighborAddr: null,
        reverseAdjSids: [],
      },
    };

    edgeSet.set(edgeKey, edgeData);
    cyEdges.push(edgeData);
  }

  return {
    nodes: cyNodes,
    edges: cyEdges,
    metadata: {
      nodeCount: cyNodes.length,
      edgeCount: cyEdges.length,
      collectedAt: new Date().toISOString(),
    },
  };
}

module.exports = { buildGraph };
