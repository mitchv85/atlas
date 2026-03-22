// ---------------------------------------------------------------------------
// SPF Engine — Dijkstra's Shortest Path First
// ---------------------------------------------------------------------------
// Computes shortest paths on the IS-IS topology graph.
// Supports node AND link exclusion for TI-LFA failure simulation.
//
// Input:  Topology graph (nodes + edges from topologyBuilder)
// Output: Shortest path with hop-by-hop detail including metrics and SIDs
// ---------------------------------------------------------------------------

/**
 * Build an adjacency list from the Cytoscape.js graph model.
 *
 * @param {Object} topology     - { nodes: [], edges: [] }
 * @param {Set}    excludeNodes - Set of systemIds to exclude (node failure)
 * @param {Set}    excludeEdges - Set of edge IDs to exclude (link failure)
 * @returns {Map<string, Array<{ neighbor, metric, edgeData, direction }>>}
 */
function buildAdjacencyList(topology, excludeNodes = new Set(), excludeEdges = new Set()) {
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

    // Skip excluded edges
    if (excludeEdges.has(edge.data.id)) continue;

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
      localAddr = edge.localAddr;
      neighborAddr = edge.neighborAddr;
      adjSids = edge.adjSids || [];
    } else {
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
 * @param {Object} options      - { excludeNodes?: string[], excludeEdges?: string[] }
 * @returns {Object|null}       - Path object or null
 */
function computePath(topology, source, destination, options = {}) {
  const excludeNodes = new Set(options.excludeNodes || []);
  const excludeEdges = new Set(options.excludeEdges || []);

  // Source and dest cannot be excluded
  excludeNodes.delete(source);
  excludeNodes.delete(destination);

  const adjList = buildAdjacencyList(topology, excludeNodes, excludeEdges);

  if (!adjList.has(source)) return null;
  if (!adjList.has(destination)) return null;

  const { dist, prev } = dijkstra(adjList, source);
  return extractPath(prev, dist, source, destination, topology);
}

/**
 * Compute primary path + TI-LFA backup paths for all transit nodes AND links.
 *
 * Node protection: for each transit node, compute backup with that node excluded.
 * Link protection: for each link on the primary path, compute backup with that
 *                  specific edge excluded.
 *
 * @param {Object} topology    - Full topology
 * @param {string} source      - Source systemId
 * @param {string} destination - Destination systemId
 * @returns {Object} - { primary, nodeBackups: [...], linkBackups: [...] }
 */
function computePathWithBackups(topology, source, destination) {
  // Primary path (no failures)
  const primary = computePath(topology, source, destination);

  if (!primary) {
    return { primary: null, nodeBackups: [], linkBackups: [] };
  }

  // Enrich primary path with real label stack from tunnel FIB
  enrichPathWithTunnelFib(primary, topology, false);

  // ── Node Protection ──
  const nodeBackups = [];
  const transitNodes = primary.hops
    .map((h) => h.from)
    .filter((n) => n !== source)
    .concat(primary.hops.map((h) => h.to).filter((n) => n !== destination));

  const uniqueTransit = [...new Set(transitNodes)].filter(
    (n) => n !== source && n !== destination
  );

  for (const failedNode of uniqueTransit) {
    const backupPath = computePath(topology, source, destination, {
      excludeNodes: [failedNode],
    });

    // Enrich backup path with real TI-LFA label stack
    if (backupPath) {
      enrichPathWithTunnelFib(backupPath, topology, true);
    }

    const failedNodeData = topology.nodes.find((n) => n.data.id === failedNode);

    nodeBackups.push({
      type: 'node',
      failedNode,
      failedHostname: failedNodeData?.data?.hostname || failedNode,
      backupPath,
    });
  }

  // ── Link Protection ──
  const linkBackups = [];
  const seenEdges = new Set();

  for (const hop of primary.hops) {
    if (!hop.edgeId || seenEdges.has(hop.edgeId)) continue;
    seenEdges.add(hop.edgeId);

    const backupPath = computePath(topology, source, destination, {
      excludeEdges: [hop.edgeId],
    });

    // Enrich backup path with real TI-LFA label stack
    if (backupPath) {
      enrichPathWithTunnelFib(backupPath, topology, true);
    }

    const linkLabel = `${hop.fromHostname} ↔ ${hop.toHostname}`;
    const linkDetail = hop.localAddr && hop.neighborAddr
      ? `${hop.localAddr} ↔ ${hop.neighborAddr}`
      : '';

    linkBackups.push({
      type: 'link',
      failedEdgeId: hop.edgeId,
      failedLinkLabel: linkLabel,
      failedLinkDetail: linkDetail,
      fromNode: hop.from,
      fromHostname: hop.fromHostname,
      toNode: hop.to,
      toHostname: hop.toHostname,
      backupPath,
    });
  }

  return { primary, nodeBackups, linkBackups };
}

/**
 * Look up tunnel FIB label stacks for a given source → destination.
 *
 * Matching strategy (in order):
 * 1. Exact device name match on source hostname
 * 2. Case-insensitive device name match
 * 3. Search all device FIBs for one that contains the destination endpoint
 *
 * @param {Object} topology       - Full topology (must have .tunnelFib)
 * @param {string} sourceId       - Source node systemId
 * @param {string} destinationId  - Destination node systemId
 * @returns {Object} - { primaryLabels: [...], backupLabels: [...] }
 */
function lookupTunnelFibLabels(topology, sourceId, destinationId) {
  const result = { primaryLabels: [], backupLabels: [] };

  if (!topology.tunnelFib || Object.keys(topology.tunnelFib).length === 0) return result;

  // Build destination endpoint candidates
  const dstNode = topology.nodes.find((n) => n.data.id === destinationId);
  if (!dstNode) return result;

  const dstPrefixes = dstNode.data.prefixes || [];
  const loopbacks = dstPrefixes
    .filter((p) => p.mask === 32)
    .map((p) => `${p.prefix}/${p.mask}`);

  const routerId = dstNode.data.routerCaps?.routerId;
  if (routerId) {
    const ep = `${routerId}/32`;
    if (!loopbacks.includes(ep)) loopbacks.push(ep);
  }

  if (loopbacks.length === 0) return result;

  // Find the right device FIB — try multiple matching strategies
  const srcNode = topology.nodes.find((n) => n.data.id === sourceId);
  const srcHostname = srcNode?.data?.hostname || '';

  let deviceFib = null;

  // Strategy 1: exact device name match
  deviceFib = topology.tunnelFib[srcHostname];

  // Strategy 2: case-insensitive match
  if (!deviceFib) {
    const lowerSrc = srcHostname.toLowerCase();
    for (const [devName, fib] of Object.entries(topology.tunnelFib)) {
      if (devName.toLowerCase() === lowerSrc) {
        deviceFib = fib;
        break;
      }
    }
  }

  // Strategy 3: search all device FIBs for one that has our destination endpoint
  if (!deviceFib) {
    for (const [_devName, fib] of Object.entries(topology.tunnelFib)) {
      for (const ep of loopbacks) {
        if (fib[ep]) {
          deviceFib = fib;
          break;
        }
      }
      if (deviceFib) break;
    }
  }

  if (!deviceFib) return result;

  // Look up each possible endpoint
  for (const endpoint of loopbacks) {
    const tunnel = deviceFib[endpoint];
    if (!tunnel) continue;

    if (tunnel.primaryPaths && tunnel.primaryPaths.length > 0) {
      result.primaryLabels = tunnel.primaryPaths.map((p) => ({
        labelStack: p.labelStack,
        nexthop: p.nexthop,
        interface: p.interface,
      }));
    }

    if (tunnel.backupPaths && tunnel.backupPaths.length > 0) {
      result.backupLabels = tunnel.backupPaths.map((p) => ({
        labelStack: p.labelStack,
        nexthop: p.nexthop,
        interface: p.interface,
      }));
    }

    break; // Found a match
  }

  return result;
}

/**
 * Enrich a computed path with real label stack from tunnel FIB.
 *
 * @param {Object} path       - Path from computePath
 * @param {Object} topology   - Full topology with tunnelFib
 * @param {boolean} isBackup  - Whether this is a backup path
 */
function enrichPathWithTunnelFib(path, topology, isBackup = false) {
  if (!path || !topology.tunnelFib) return;

  const fibLabels = lookupTunnelFibLabels(topology, path.source, path.destination);

  if (isBackup && fibLabels.backupLabels.length > 0) {
    // Use the backup label stack from the tunnel FIB
    path.labelStack = fibLabels.backupLabels.map((b) => ({
      labels: b.labelStack,
      nexthop: b.nexthop,
      interface: b.interface,
      type: 'tunnel-fib-backup',
    }));
    path.labelStackSource = 'tunnel-fib';
  } else if (!isBackup && fibLabels.primaryLabels.length > 0) {
    // Use the primary label stack from the tunnel FIB
    path.labelStack = fibLabels.primaryLabels.map((p) => ({
      labels: p.labelStack,
      nexthop: p.nexthop,
      interface: p.interface,
      type: 'tunnel-fib-primary',
    }));
    path.labelStackSource = 'tunnel-fib';
  }
  // If no tunnel FIB data, keep the SPF-computed label stack
}

// ---------------------------------------------------------------------------
// ECMP — Equal Cost Multi-Path
// ---------------------------------------------------------------------------

/**
 * Dijkstra variant that tracks ALL equal-cost predecessors per node.
 *
 * @param {Map}    adjList  - Adjacency list
 * @param {string} sourceId - Source node systemId
 * @returns {Object} - { dist, prevAll: Map<id, Array<{ node, edgeData, direction }>> }
 */
function dijkstraECMP(adjList, sourceId) {
  const dist = new Map();
  const prevAll = new Map(); // node -> array of equal-cost predecessors
  const visited = new Set();
  const pq = [];

  for (const nodeId of adjList.keys()) {
    dist.set(nodeId, Infinity);
    prevAll.set(nodeId, []);
  }

  dist.set(sourceId, 0);
  pq.push({ id: sourceId, cost: 0 });

  while (pq.length > 0) {
    pq.sort((a, b) => a.cost - b.cost);
    const { id: current, cost: currentCost } = pq.shift();

    if (visited.has(current)) continue;
    visited.add(current);

    const neighbors = adjList.get(current) || [];

    for (const { neighbor, metric, edgeData, direction } of neighbors) {
      if (visited.has(neighbor)) continue;

      const newCost = currentCost + metric;
      const currentBest = dist.get(neighbor);

      if (newCost < currentBest) {
        // Found a strictly better path — reset predecessors
        dist.set(neighbor, newCost);
        prevAll.set(neighbor, [{ node: current, edgeData, direction }]);
        pq.push({ id: neighbor, cost: newCost });
      } else if (newCost === currentBest) {
        // Equal-cost — add to predecessors
        prevAll.get(neighbor).push({ node: current, edgeData, direction });
      }
    }
  }

  return { dist, prevAll };
}

/**
 * Enumerate all distinct shortest paths from source to destination.
 * Walks all predecessor chains (DFS) and builds full path objects.
 *
 * @param {Map}    prevAll  - Multi-predecessor map from dijkstraECMP
 * @param {Map}    dist     - Distance map
 * @param {string} source   - Source systemId
 * @param {string} dest     - Destination systemId
 * @param {Object} topology - Full topology for node lookups
 * @param {number} maxPaths - Safety cap on path enumeration (default 8)
 * @returns {Object[]}      - Array of path objects (same format as extractPath)
 */
function enumerateAllPaths(prevAll, dist, source, dest, topology, maxPaths = 8) {
  if (!dist.has(dest) || dist.get(dest) === Infinity) return [];

  const nodeLookup = new Map();
  for (const node of topology.nodes) {
    nodeLookup.set(node.data.id, node.data);
  }

  const destNode = nodeLookup.get(dest);
  const destPrefixSid = destNode?.srPrefixSids?.find(
    (s) => s.isNodeSid && s.algorithm === 0
  );

  const paths = [];

  // DFS to enumerate all paths (walking backwards from dest)
  function dfs(current, hopsAccum) {
    if (paths.length >= maxPaths) return; // Safety cap

    if (current === source) {
      // Build the path object
      paths.push({
        source,
        sourceHostname: nodeLookup.get(source)?.hostname || source,
        destination: dest,
        destinationHostname: nodeLookup.get(dest)?.hostname || dest,
        totalMetric: dist.get(dest),
        hopCount: hopsAccum.length,
        hops: [...hopsAccum],
        destinationPrefixSid: destPrefixSid || null,
        labelStack: destPrefixSid
          ? [{ label: destPrefixSid.sid, type: 'prefix-sid', prefix: destPrefixSid.prefix }]
          : [],
        algorithm: 0,
        algorithmName: 'SPF',
      });
      return;
    }

    const predecessors = prevAll.get(current) || [];
    for (const prev of predecessors) {
      const fromNode = nodeLookup.get(prev.node);
      const toNode = nodeLookup.get(current);
      const edge = prev.edgeData;

      let localAddr, neighborAddr, adjSids;
      if (prev.direction === 'forward') {
        localAddr = edge.localAddr;
        neighborAddr = edge.neighborAddr;
        adjSids = edge.adjSids || [];
      } else {
        localAddr = edge.reverseLocalAddr || edge.neighborAddr;
        neighborAddr = edge.reverseNeighborAddr || edge.localAddr;
        adjSids = edge.reverseAdjSids || [];
      }

      const hop = {
        from: prev.node,
        fromHostname: fromNode?.hostname || prev.node,
        to: current,
        toHostname: toNode?.hostname || current,
        metric: prev.direction === 'forward' ? edge.metric : (edge.reverseMetric ?? edge.metric),
        localAddr,
        neighborAddr,
        adjSids,
        edgeId: edge.id,
      };

      // Prepend hop and recurse
      hopsAccum.unshift(hop);
      dfs(prev.node, hopsAccum);
      hopsAccum.shift(); // Backtrack
    }
  }

  dfs(dest, []);
  return paths;
}

/**
 * Compute all ECMP paths between two nodes.
 *
 * @param {Object} topology    - Full topology
 * @param {string} source      - Source systemId
 * @param {string} destination - Destination systemId
 * @param {Object} options     - { excludeNodes?, excludeEdges? }
 * @returns {Object} - { paths: [], sharedEdges: [], sharedNodes: [] }
 */
function computeECMPPaths(topology, source, destination, options = {}) {
  const excludeNodes = new Set(options.excludeNodes || []);
  const excludeEdges = new Set(options.excludeEdges || []);

  excludeNodes.delete(source);
  excludeNodes.delete(destination);

  const adjList = buildAdjacencyList(topology, excludeNodes, excludeEdges);

  if (!adjList.has(source) || !adjList.has(destination)) {
    return { paths: [], sharedEdges: [], sharedNodes: [] };
  }

  const { dist, prevAll } = dijkstraECMP(adjList, source);
  const paths = enumerateAllPaths(prevAll, dist, source, destination, topology);

  if (paths.length === 0) {
    return { paths: [], sharedEdges: [], sharedNodes: [] };
  }

  // Compute shared vs divergent edges and nodes
  // An edge/node is "shared" if it appears in ALL paths
  const edgeCounts = new Map();
  const nodeCounts = new Map();

  for (const path of paths) {
    const seenEdges = new Set();
    const seenNodes = new Set();
    seenNodes.add(path.source);

    for (const hop of path.hops) {
      seenNodes.add(hop.to);
      if (hop.edgeId) seenEdges.add(hop.edgeId);
    }

    for (const eid of seenEdges) {
      edgeCounts.set(eid, (edgeCounts.get(eid) || 0) + 1);
    }
    for (const nid of seenNodes) {
      nodeCounts.set(nid, (nodeCounts.get(nid) || 0) + 1);
    }
  }

  const pathCount = paths.length;
  const sharedEdges = [...edgeCounts.entries()].filter(([_, c]) => c === pathCount).map(([id]) => id);
  const sharedNodes = [...nodeCounts.entries()].filter(([_, c]) => c === pathCount).map(([id]) => id);

  return {
    paths,
    pathCount,
    totalMetric: paths[0].totalMetric,
    sharedEdges,
    sharedNodes,
  };
}

/**
 * Enrich ECMP paths with label stacks from the tunnel FIB.
 *
 * Matches each path to its tunnel FIB entry by comparing the first-hop
 * neighbor address against tunnel FIB primary via next-hops.
 *
 * @param {Object[]} paths    - Array of path objects from computeECMPPaths
 * @param {Object}   topology - Full topology with tunnelFib
 */
function enrichECMPWithTunnelFib(paths, topology) {
  if (!topology.tunnelFib || paths.length === 0) return;

  const source = paths[0].source;
  const destination = paths[0].destination;
  const fibInfo = lookupTunnelFibLabels(topology, source, destination);

  if (fibInfo.primaryLabels.length === 0) return;

  // Build a nexthop -> label stack lookup from the tunnel FIB
  const nexthopToLabels = new Map();
  for (const entry of fibInfo.primaryLabels) {
    if (entry.nexthop) {
      nexthopToLabels.set(entry.nexthop, entry);
    }
  }

  for (const path of paths) {
    if (path.hops.length === 0) continue;

    // The first hop's neighborAddr is the next-hop from the source
    const firstHopNexthop = path.hops[0].neighborAddr;

    // Try exact match on first-hop next-hop
    const matched = nexthopToLabels.get(firstHopNexthop);

    if (matched) {
      path.labelStack = [{
        labels: matched.labelStack,
        nexthop: matched.nexthop,
        interface: matched.interface,
        type: 'tunnel-fib-primary',
      }];
      path.labelStackSource = 'tunnel-fib';
    } else if (fibInfo.primaryLabels.length === 1) {
      // Only one FIB entry — use it for all paths (same label, different IGP next-hop)
      const single = fibInfo.primaryLabels[0];
      path.labelStack = [{
        labels: single.labelStack,
        nexthop: single.nexthop,
        interface: single.interface,
        type: 'tunnel-fib-primary',
      }];
      path.labelStackSource = 'tunnel-fib';
    }
    // If no match, keep the SPF-computed labelStack
  }

  // Also attach backup labels to the result for reference
  if (fibInfo.backupLabels.length > 0) {
    paths._backupLabels = fibInfo.backupLabels;
  }
}

module.exports = { computePath, computePathWithBackups, computeECMPPaths, enrichECMPWithTunnelFib, lookupTunnelFibLabels, buildAdjacencyList, dijkstra };
