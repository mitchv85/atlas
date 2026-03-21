// ---------------------------------------------------------------------------
// Topology Builder
// ---------------------------------------------------------------------------
// Converts parsed IS-IS LSDB data into a Cytoscape.js-compatible graph model.
//
// Output format:
// {
//   nodes: [{ data: { id, label, systemId, ... } }],
//   edges: [{ data: { id, source, target, metric, ... } }]
// }
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
  const edgeSet = new Set(); // Deduplicate bidirectional adjacencies

  // --- Build Nodes ---
  for (const [systemId, nodeInfo] of nodesMap) {
    cyNodes.push({
      data: {
        id: systemId,
        label: nodeInfo.hostname,
        systemId: nodeInfo.systemId,
        hostname: nodeInfo.hostname,
        level: nodeInfo.level,
        instance: nodeInfo.instance,
        lspId: nodeInfo.lspId,
        sequenceNumber: nodeInfo.sequenceNumber,
        remainingLifetime: nodeInfo.remainingLifetime,
        prefixCount: nodeInfo.prefixes.length,
        prefixes: nodeInfo.prefixes,
        neighborCount: nodeInfo.neighbors.length,
        // Phase 2
        srPrefixSids: nodeInfo.srPrefixSids,
        srAdjSids: nodeInfo.srAdjSids,
        // Phase 3
        flexAlgos: nodeInfo.flexAlgos,
      },
    });
  }

  // --- Build Edges (deduplicated) ---
  for (const adj of adjacencies) {
    // Create a canonical edge key so A->B and B->A become one edge
    const edgeKey = [adj.fromSystemId, adj.toSystemId].sort().join('|');

    if (edgeSet.has(edgeKey)) {
      // Already have this edge — update with reverse direction info
      const existing = cyEdges.find((e) => e.data._edgeKey === edgeKey);
      if (existing) {
        existing.data.reverseMetric = adj.metric;
        existing.data.reverseLocalIntf = adj.localIntf;
        existing.data.reverseRemoteIntf = adj.remoteIntf;
      }
      continue;
    }

    edgeSet.add(edgeKey);

    // Look up hostnames for readable labels
    const fromNode = nodesMap.get(adj.fromSystemId);
    const toNode = nodesMap.get(adj.toSystemId);

    cyEdges.push({
      data: {
        id: `edge-${adj.fromSystemId}-${adj.toSystemId}`,
        _edgeKey: edgeKey,
        source: adj.fromSystemId,
        target: adj.toSystemId,
        sourceLabel: fromNode?.hostname || adj.fromHostname || adj.fromSystemId,
        targetLabel: toNode?.hostname || adj.toSystemId,
        metric: adj.metric,
        level: adj.level,
        localIntf: adj.localIntf,
        remoteIntf: adj.remoteIntf,
        reverseMetric: null,
        reverseLocalIntf: null,
        reverseRemoteIntf: null,
      },
    });
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
