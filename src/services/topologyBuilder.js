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
  // Parallel links are differentiated by their interface addresses.
  // Edge key: "nodeA|nodeB|addrLow|addrHigh" — the sorted address pair
  // uniquely identifies a link even when multiple links exist between
  // the same two nodes.
  for (const adj of adjacencies) {
    const nodePair = [adj.fromSystemId, adj.toSystemId].sort().join('|');
    const addrPair = [adj.localAddr || '', adj.neighborAddr || ''].sort().join('|');
    const edgeKey = `${nodePair}|${addrPair}`;

    if (edgeSet.has(edgeKey)) {
      // Already have this edge — enrich with reverse direction info
      const existing = edgeSet.get(edgeKey);
      // Only populate reverse fields if not already set
      if (existing.data.reverseMetric === null) {
        existing.data.reverseMetric = adj.metric;
        existing.data.reverseLocalAddr = adj.localAddr;
        existing.data.reverseNeighborAddr = adj.neighborAddr;
        existing.data.reverseAdjSids = adj.adjSids;
      }
      continue;
    }

    const fromNode = nodesMap.get(adj.fromSystemId);
    const toNode = nodesMap.get(adj.toSystemId);

    // Count existing edges between this node pair for unique IDs
    const parallelIndex = cyEdges.filter(
      (e) => e.data._nodePair === nodePair
    ).length;

    const edgeData = {
      data: {
        id: `edge-${nodePair.replace('|', '-')}-${parallelIndex}`,
        _edgeKey: edgeKey,
        _nodePair: nodePair,
        _parallelIndex: parallelIndex,
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
