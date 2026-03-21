// ---------------------------------------------------------------------------
// SPF Engine — Dijkstra's Shortest Path First
// ---------------------------------------------------------------------------
// Computes shortest paths on the IS-IS topology graph.
// Supports node exclusion for TI-LFA failure simulation.
//
// Input:  Topology graph (nodes + edges from topologyBuilder)
// Output: Shortest path with hop-by-hop detail including metrics and SIDs
// ---------------------------------------------------------------------------

/**
 * Build an adjacency list from the Cytoscape.js graph model.
 *
 * @param {Object} topology - { nodes: [], edges: [] }
 * @param {Set}    excludeNodes - Set of systemIds to exclude (failure simulation)
 * @returns {Map<string, Array<{ neighbor, metric, edgeData }>>}
 */
function buildAdjacencyList(topology, excludeNodes = new Set()) {
  const adj = new Map();

  // Initialize all non-excluded nodes
  for (const node of topology.nodes) {
    const id = node.data.id;
    if (excludeNodes.has(id)) continue;
    adj.set(id, []);
  }

  // Add edges (both directions)
  for (const edge of topology.edges) {
    const src = edge.data.source;
    const tgt = edge.data.target;

    // Skip edges involving excluded nodes
    if (excludeNodes.has(src) || excludeNodes.has(tgt)) continue;

    // Forward: source -> target
    if (adj.has(src)) {
      adj.get(src).push({
        neighbor: tgt,
        metric: edge.data.metric || 10,
        edgeData: edge.data,
        direction: 'forward',
      });
    }

    // Reverse: target -> source
    if (adj.has(tgt)) {
      adj.get(tgt).push({
        neighbor: src,
        metric: edge.data.reverseMetric ?? edge.data.metric ?? 10,
        edgeData: edge.data,
        direction: 'reverse',
      });
    }
  }

  return adj;
}

/**
 * Run Dijkstra's SPF algorithm.
 *
 * @param {Map}    adjList   - Adjacency list from buildAdjacencyList
 * @param {string} sourceId  - Starting node systemId
 * @returns {Object} - { dist: Map<id, cost>, prev: Map<id, { node, edge, direction }> }
 */
function dijkstra(adjList, sourceId) {
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();

  // Priority queue (simple array-based for our graph sizes)
  const pq = [];

  // Initialize
  for (const nodeId of adjList.keys()) {
    dist.set(nodeId, Infinity);
    prev.set(nodeId, null);
  }

  dist.set(sourceId, 0);
  pq.push({ id: sourceId, cost: 0 });

  while (pq.length > 0) {
    // Extract minimum
    pq.sort((a, b) => a.cost - b.cost);
    const { id: current, cost: currentCost } = pq.shift();

    if (visited.has(current)) continue;
    visited.add(current);

    const neighbors = adjList.get(current) || [];

    for (const { neighbor, metric, edgeData, direction } of neighbors) {
      if (visited.has(neighbor)) continue;

      const newCost = currentCost + metric;

      if (newCost < dist.get(neighbor)) {
        dist.set(neighbor, newCost);
        prev.set(neighbor, { node: current, edgeData, direction });
        pq.push({ id: neighbor, cost: newCost });
      }
    }
  }

  return { dist, prev };
}

/**
 * Extract the shortest path from source to destination.
 *
 * @param {Map}    prev   - Previous-hop map from dijkstra()
 * @param {Map}    dist   - Distance map from dijkstra()
 * @param {string} source - Source systemId
 * @param {string} dest   - Destination systemId
 * @param {Object} topology - Full topology for node lookups
 * @returns {Object|null} - Path object or null if unreachable
 */
function extractPath(prev, dist, source, dest, topology) {
  if (!dist.has(dest) || dist.get(dest) === Infinity) {
    return null; // Unreachable
  }

  // Build node lookup
  const nodeLookup = new Map();
  for (const node of topology.nodes) {
    nodeLookup.set(node.data.id, node.data);
  }

  // Walk backwards from dest to source
  const hops = [];
  let current = dest;

  while (current !== source) {
    const prevInfo = prev.get(current);
    if (!prevInfo) return null; // Broken path

    const fromNode = nodeLookup.get(prevInfo.node);
    const toNode = nodeLookup.get(current);
    const edge = prevInfo.edgeData;

    // Determine the correct addresses and adj-SIDs based on direction
    let localAddr, neighborAddr, adjSids;

    if (prevInfo.direction === 'forward') {
      // Edge goes source->target, we're traversing source->target
      localAddr = edge.localAddr;
      neighborAddr = edge.neighborAddr;
      adjSids = edge.adjSids || [];
    } else {
      // Edge goes source->target, but we're traversing target->source
      localAddr = edge.reverseLocalAddr || edge.neighborAddr;
      neighborAddr = edge.reverseNeighborAddr || edge.localAddr;
      adjSids = edge.reverseAdjSids || [];
    }

    hops.unshift({
      from: prevInfo.node,
      fromHostname: fromNode?.hostname || prevInfo.node,
      to: current,
      toHostname: toNode?.hostname || current,
      metric: prevInfo.direction === 'forward' ? edge.metric : (edge.reverseMetric ?? edge.metric),
      localAddr,
      neighborAddr,
      adjSids,
      edgeId: edge.id,
    });

    current = prevInfo.node;
  }

  // Compute the label stack (Prefix-SID of destination)
  const destNode = nodeLookup.get(dest);
  const destPrefixSid = destNode?.srPrefixSids?.find(
    (s) => s.isNodeSid && s.algorithm === 0
  );

  return {
    source,
    sourceHostname: nodeLookup.get(source)?.hostname || source,
    destination: dest,
    destinationHostname: nodeLookup.get(dest)?.hostname || dest,
    totalMetric: dist.get(dest),
    hopCount: hops.length,
    hops,
    // SR info
    destinationPrefixSid: destPrefixSid || null,
    labelStack: destPrefixSid
      ? [{ label: destPrefixSid.sid, type: 'prefix-sid', prefix: destPrefixSid.prefix }]
      : [],
    // Path metadata
    algorithm: 0,
    algorithmName: 'SPF',
  };
}

/**
 * Compute the shortest path between two nodes.
 *
 * @param {Object} topology     - Full topology { nodes, edges }
 * @param {string} source       - Source node systemId
 * @param {string} destination  - Destination node systemId
 * @param {Object} options      - { excludeNodes: string[] } for failure simulation
 * @returns {Object|null}       - Path object or null
 */
function computePath(topology, source, destination, options = {}) {
  const excludeNodes = new Set(options.excludeNodes || []);

  // Source and dest cannot be excluded
  excludeNodes.delete(source);
  excludeNodes.delete(destination);

  const adjList = buildAdjacencyList(topology, excludeNodes);

  if (!adjList.has(source)) return null;
  if (!adjList.has(destination)) return null;

  const { dist, prev } = dijkstra(adjList, source);
  return extractPath(prev, dist, source, destination, topology);
}

/**
 * Compute primary path + TI-LFA backup paths for all transit nodes.
 *
 * For each transit node on the primary path, compute the backup path
 * that would be used if that node failed (node protection).
 *
 * @param {Object} topology    - Full topology
 * @param {string} source      - Source systemId
 * @param {string} destination - Destination systemId
 * @returns {Object} - { primary, backups: [{ failedNode, failedHostname, backupPath }] }
 */
function computePathWithBackups(topology, source, destination) {
  // Primary path (no failures)
  const primary = computePath(topology, source, destination);

  if (!primary) {
    return { primary: null, backups: [] };
  }

  // For each transit node (not source or dest), compute backup path
  const backups = [];
  const transitNodes = primary.hops
    .map((h) => h.from)
    .filter((n) => n !== source)
    .concat(primary.hops.map((h) => h.to).filter((n) => n !== destination));

  // Deduplicate transit nodes
  const uniqueTransit = [...new Set(transitNodes)].filter(
    (n) => n !== source && n !== destination
  );

  for (const failedNode of uniqueTransit) {
    const backupPath = computePath(topology, source, destination, {
      excludeNodes: [failedNode],
    });

    // Node lookup for hostname
    const failedNodeData = topology.nodes.find((n) => n.data.id === failedNode);

    backups.push({
      failedNode,
      failedHostname: failedNodeData?.data?.hostname || failedNode,
      backupPath,
    });
  }

  return { primary, backups };
}

module.exports = { computePath, computePathWithBackups, buildAdjacencyList, dijkstra };
