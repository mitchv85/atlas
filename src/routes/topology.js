// ---------------------------------------------------------------------------
// Topology Routes — /api/topology
// ---------------------------------------------------------------------------
// Now uses the background poller's cached topology instead of its own cache.
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { computePath, computePathWithBackups, computeECMPPaths, enrichECMPWithTunnelFib, lookupTunnelFibLabels } = require('../services/spf');
const positionStore = require('../store/positions');
const deviceStore   = require('../store/devices');
const eapi          = require('../services/eapi');

/**
 * Helper: get the poller from the Express app.
 */
function getPoller(req) {
  return req.app.get('poller');
}

/**
 * Helper: get the current topology from the poller.
 */
function getTopology(req) {
  return getPoller(req).getTopology();
}

// GET /api/topology — Return the current topology graph
router.get('/', (req, res) => {
  const topology = getTopology(req);
  if (!topology) {
    return res.status(404).json({
      error: 'No topology data. Waiting for background poll or use POST /api/topology/collect.',
    });
  }
  res.json(topology);
});

// POST /api/topology/collect — Force an immediate collection
router.post('/collect', async (req, res) => {
  const poller = getPoller(req);

  try {
    await poller.forceCollect();
    const topology = poller.getTopology();

    if (!topology) {
      return res.status(500).json({ error: 'Collection completed but no topology data.' });
    }

    res.json(topology);
  } catch (err) {
    console.error('  Topology collection error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/topology/node/:systemId — Detailed info for a single node
router.get('/node/:systemId', (req, res) => {
  const topology = getTopology(req);
  if (!topology) {
    return res.status(404).json({ error: 'No topology data available.' });
  }

  const node = topology.nodes.find(
    (n) => n.data.systemId === req.params.systemId
  );

  if (!node) return res.status(404).json({ error: 'Node not found in topology.' });
  res.json(node.data);
});

// GET /api/topology/node/:systemId/reachability — Remote Node SID reachability
// Returns all remote Node SIDs reachable from this node, with protection status.
router.get('/node/:systemId/reachability', (req, res) => {
  const topology = getTopology(req);
  if (!topology) {
    return res.status(404).json({ error: 'No topology data available.' });
  }

  const sourceId = req.params.systemId;
  const sourceNode = topology.nodes.find((n) => n.data.id === sourceId);
  if (!sourceNode) return res.status(404).json({ error: 'Node not found.' });

  const reachability = [];

  for (const node of topology.nodes) {
    if (node.data.id === sourceId) continue; // Skip self

    // Find the Node SID (algo 0, nodeSID flag)
    const nodeSid = (node.data.srPrefixSids || []).find(
      (s) => s.isNodeSid && s.algorithm === 0
    );
    if (!nodeSid) continue; // No Node SID advertised

    // Compute primary path
    const primaryPath = computePath(topology, sourceId, node.data.id);
    if (!primaryPath) continue; // Unreachable

    // Build primary path hostname chain
    const primaryChain = [primaryPath.sourceHostname];
    for (const hop of primaryPath.hops) primaryChain.push(hop.toHostname);

    // Look up tunnel FIB for protection info
    const fibInfo = lookupTunnelFibLabels(topology, sourceId, node.data.id);

    // Determine protection status
    let protectionStatus = 'unprotected';
    let backupLabelStack = [];
    let backupNexthop = '';
    let backupInterface = '';
    let primaryLabelStack = [];

    if (fibInfo.backupLabels.length > 0) {
      protectionStatus = 'node-protected';
      const backup = fibInfo.backupLabels[0];
      backupLabelStack = backup.labelStack;
      backupNexthop = backup.nexthop;
      backupInterface = backup.interface;
    }

    if (fibInfo.primaryLabels.length > 1) {
      // Multiple primary paths = ECMP
      if (protectionStatus === 'unprotected') {
        protectionStatus = 'ecmp';
      } else {
        protectionStatus = 'node-protected+ecmp';
      }
    }

    if (fibInfo.primaryLabels.length > 0) {
      primaryLabelStack = fibInfo.primaryLabels[0].labelStack;
    }

    reachability.push({
      systemId: node.data.id,
      hostname: node.data.hostname,
      loopback: nodeSid.prefix,
      sid: nodeSid.sid,
      algorithm: nodeSid.algorithm,
      metric: primaryPath.totalMetric,
      hopCount: primaryPath.hopCount,
      primaryChain,
      protectionStatus,
      primaryLabelStack,
      backupLabelStack,
      backupNexthop,
      backupInterface,
    });
  }

  // Sort by SID
  reachability.sort((a, b) => a.sid - b.sid);

  res.json({
    source: sourceId,
    sourceHostname: sourceNode.data.hostname,
    hasTunnelFib: Object.keys(topology.tunnelFib || {}).length > 0,
    entries: reachability,
  });
});

// POST /api/topology/path — Compute shortest path between two nodes
// Body: { source, destination, excludeNodes?: string[], excludeEdges?: string[] }
router.post('/path', (req, res) => {
  const topology = getTopology(req);
  if (!topology) {
    return res.status(404).json({ error: 'No topology data available.' });
  }

  const { source, destination, excludeNodes, excludeEdges } = req.body;

  if (!source || !destination) {
    return res.status(400).json({ error: 'source and destination are required.' });
  }

  const path = computePath(topology, source, destination, {
    excludeNodes: excludeNodes || [],
    excludeEdges: excludeEdges || [],
  });

  if (!path) {
    return res.json({
      reachable: false,
      source,
      destination,
      excludeNodes: excludeNodes || [],
      excludeEdges: excludeEdges || [],
      message: 'Destination is unreachable with the given constraints.',
    });
  }

  res.json({ reachable: true, ...path });
});

// POST /api/topology/path/analyze — Compute primary path + all TI-LFA backup paths
// Body: { source, destination }
router.post('/path/analyze', (req, res) => {
  const topology = getTopology(req);
  if (!topology) {
    return res.status(404).json({ error: 'No topology data available.' });
  }

  const { source, destination } = req.body;

  if (!source || !destination) {
    return res.status(400).json({ error: 'source and destination are required.' });
  }

  const result = computePathWithBackups(topology, source, destination);
  res.json(result);
});

// POST /api/topology/path/ecmp — Compute all ECMP paths between two nodes
// Body: { source, destination }
router.post('/path/ecmp', (req, res) => {
  const topology = getTopology(req);
  if (!topology) {
    return res.status(404).json({ error: 'No topology data available.' });
  }

  const { source, destination } = req.body;

  if (!source || !destination) {
    return res.status(400).json({ error: 'source and destination are required.' });
  }

  const result = computeECMPPaths(topology, source, destination);

  // Enrich each path with real label stacks from the tunnel FIB
  if (result.paths.length > 0) {
    enrichECMPWithTunnelFib(result.paths, topology);
  }

  res.json(result);
});

// GET /api/topology/positions — Get saved node positions
router.get('/positions', (_req, res) => {
  res.json(positionStore.getAll());
});

// PUT /api/topology/positions — Save node positions
// Body: { nodeId: { x, y }, ... }
router.put('/positions', (req, res) => {
  positionStore.update(req.body);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// FlexAlgo
// ---------------------------------------------------------------------------

const { buildFlexAlgoSummary } = require('../services/flexAlgo');

/**
 * GET /api/topology/flexalgo/summary
 * Returns FlexAlgo overview built from the LSDB topology data:
 *   - Defined algorithms (number, name, definition, advertiser)
 *   - Per-node participation and FA prefix SIDs
 */
router.get('/flexalgo/summary', (req, res) => {
  const topology = getTopology(req);
  if (!topology) {
    return res.status(404).json({ error: 'No topology data available' });
  }
  res.json(buildFlexAlgoSummary(topology));
});

/**
 * POST /api/topology/flexalgo/trace
 * Trace a FlexAlgo path hop-by-hop from source to destination.
 * Queries each device along the way via eAPI to reconstruct the full path.
 *
 * Body: { source, destination, algorithm }
 *   source/destination: systemId or hostname
 *   algorithm: FlexAlgo number (128, 129, etc.)
 *
 * Returns: { hops: [{ hostname, systemId, nexthop, interface, metric }], totalMetric, algorithm, algorithmName }
 */
router.post('/flexalgo/trace', async (req, res) => {
  const topology = getTopology(req);
  if (!topology) {
    return res.status(404).json({ error: 'No topology data available' });
  }

  const { source, destination, algorithm } = req.body;
  const algoNum = parseInt(algorithm, 10);

  if (!source || !destination || isNaN(algoNum)) {
    return res.status(400).json({ error: 'source, destination, and algorithm are required' });
  }

  // Resolve hostnames and system IDs
  const srcNode = topology.nodes.find(n =>
    n.data.systemId === source || n.data.hostname?.toLowerCase() === source.toLowerCase()
  );
  const dstNode = topology.nodes.find(n =>
    n.data.systemId === destination || n.data.hostname?.toLowerCase() === destination.toLowerCase()
  );

  if (!srcNode) return res.status(404).json({ error: `Source node ${source} not found` });
  if (!dstNode) return res.status(404).json({ error: `Destination node ${destination} not found` });

  // Build IP → node lookup from topology
  const ipToNode = new Map();
  for (const n of topology.nodes) {
    const d = n.data;
    if (d.routerCaps?.routerId) ipToNode.set(d.routerCaps.routerId, d);
    for (const addr of (d.interfaceAddresses || [])) ipToNode.set(addr, d);
    // Also map link addresses to nodes
    for (const edge of topology.edges) {
      const ed = edge.data;
      if (ed.source === d.systemId && ed.localAddr) ipToNode.set(ed.localAddr, d);
      if (ed.target === d.systemId && ed.neighborAddr) ipToNode.set(ed.neighborAddr, d);
    }
  }

  // Map next-hop IPs to the node on the OTHER side of the link
  const nhToNode = new Map();
  for (const edge of topology.edges) {
    const ed = edge.data;
    // If I'm the source and my local addr is X, the nexthop from me would be the neighbor addr
    // which belongs to the target node
    if (ed.neighborAddr) {
      const targetNode = topology.nodes.find(n => n.data.systemId === ed.target);
      if (targetNode) nhToNode.set(ed.neighborAddr, targetNode.data);
    }
    if (ed.localAddr) {
      const sourceNode = topology.nodes.find(n => n.data.systemId === ed.source);
      if (sourceNode) nhToNode.set(ed.localAddr, sourceNode.data);
    }
    // Also reverse direction
    if (ed.reverseNeighborAddr) {
      const srcNodeData = topology.nodes.find(n => n.data.systemId === ed.source);
      if (srcNodeData) nhToNode.set(ed.reverseNeighborAddr, srcNodeData.data);
    }
    if (ed.reverseLocalAddr) {
      const tgtNodeData = topology.nodes.find(n => n.data.systemId === ed.target);
      if (tgtNodeData) nhToNode.set(ed.reverseLocalAddr, tgtNodeData.data);
    }
  }

  // Find the destination prefix (loopback/32) from the topology
  const dstLoopback = dstNode.data.routerCaps?.routerId || dstNode.data.interfaceAddresses?.[0] || '';
  const dstPrefix = `${dstLoopback}/32`;
  const allDevices = deviceStore.getAllRaw();

  const hops = [];
  const visited = new Set();
  let currentNode = srcNode.data;
  let totalMetric = null;
  let algoName = '';
  const maxHops = 15;

  for (let i = 0; i < maxHops; i++) {
    if (currentNode.systemId === dstNode.data.systemId) break;
    if (visited.has(currentNode.systemId)) {
      return res.status(500).json({ error: 'Loop detected in FlexAlgo path trace' });
    }
    visited.add(currentNode.systemId);

    // Find device credentials for current node
    const device = allDevices.find(d =>
      d.name.toLowerCase() === (currentNode.hostname || '').toLowerCase()
    );

    if (!device) {
      return res.status(404).json({
        error: `No credentials for ${currentNode.hostname}. Add it in the Devices tab.`,
        partialHops: hops,
      });
    }

    // Query FlexAlgo paths from this device
    try {
      const result = await eapi.execute(device, ['show isis flex-algo path detail'], 'json');
      const raw = result[0];
      const vrfs = raw?.vrfs || {};

      let foundVia = null;
      let hopMetric = null;

      // Search all topologies for our destination prefix
      for (const vrfData of Object.values(vrfs)) {
        const topos = vrfData.v4Info?.topologies || {};
        for (const topoData of Object.values(topos)) {
          const dests = topoData.destinations || {};
          for (const [prefix, destData] of Object.entries(dests)) {
            // Match destination by prefix or loopback
            if (prefix !== dstPrefix && !prefix.startsWith(dstLoopback)) continue;
            const pathData = destData.paths?.[String(algoNum)];
            if (!pathData) continue;

            algoName = pathData.algoName || `Algo ${algoNum}`;
            if (pathData.vias?.length > 0) {
              foundVia = pathData.vias[0];
              hopMetric = pathData.details?.metric ?? null;
            }
            if (i === 0) totalMetric = hopMetric;
            break;
          }
          if (foundVia) break;
        }
        if (foundVia) break;
      }

      if (!foundVia) {
        hops.push({
          hostname: currentNode.hostname,
          systemId: currentNode.systemId,
          nexthop: null,
          interface: null,
          note: 'No FlexAlgo path to destination',
        });
        return res.json({
          source: srcNode.data.hostname,
          destination: dstNode.data.hostname,
          algorithm: algoNum,
          algorithmName: algoName,
          hops,
          totalMetric,
          reachable: false,
        });
      }

      const nhIp = foundVia.nexthop;

      // Resolve next-hop IP to the next node (try edge addresses first)
      let nextNodeData = null;
      for (const edge of topology.edges) {
        const ed = edge.data;
        // If we're the source of this edge and the NH matches the neighbor addr
        if (ed.source === currentNode.systemId && ed.neighborAddr === nhIp) {
          nextNodeData = topology.nodes.find(n => n.data.systemId === ed.target)?.data;
          break;
        }
        // If we're the target of this edge and the NH matches the local addr (reverse direction)
        if (ed.target === currentNode.systemId && ed.localAddr === nhIp) {
          nextNodeData = topology.nodes.find(n => n.data.systemId === ed.source)?.data;
          break;
        }
        // Also check reverse addresses
        if (ed.source === currentNode.systemId && ed.reverseNeighborAddr === nhIp) {
          nextNodeData = topology.nodes.find(n => n.data.systemId === ed.target)?.data;
          break;
        }
        if (ed.target === currentNode.systemId && ed.reverseLocalAddr === nhIp) {
          nextNodeData = topology.nodes.find(n => n.data.systemId === ed.source)?.data;
          break;
        }
      }

      // Fallback: check IP-to-node maps
      if (!nextNodeData) {
        const mapped = nhToNode.get(nhIp) || ipToNode.get(nhIp);
        if (mapped && mapped.systemId !== currentNode.systemId) {
          nextNodeData = mapped;
        }
      }

      if (!nextNodeData) {
        hops.push({
          hostname: currentNode.hostname,
          systemId: currentNode.systemId,
          nexthop: nhIp,
          interface: foundVia.intf || '',
          note: `Cannot resolve next-hop ${nhIp}`,
        });
        return res.json({
          source: srcNode.data.hostname,
          destination: dstNode.data.hostname,
          algorithm: algoNum,
          algorithmName: algoName,
          hops,
          totalMetric,
          reachable: false,
          error: `Cannot resolve next-hop ${nhIp} to a topology node`,
        });
      }

      // Find the edge between currentNode and nextNode by system IDs
      let edgeId = null;
      for (const edge of topology.edges) {
        const ed = edge.data;
        if ((ed.source === currentNode.systemId && ed.target === nextNodeData.systemId) ||
            (ed.target === currentNode.systemId && ed.source === nextNodeData.systemId)) {
          edgeId = ed.id;
          break;
        }
      }

      hops.push({
        hostname: currentNode.hostname,
        systemId: currentNode.systemId,
        nexthop: nhIp,
        interface: foundVia.intf || '',
        edgeId,
      });

      currentNode = nextNodeData;
    } catch (err) {
      return res.status(500).json({
        error: `eAPI query to ${currentNode.hostname} failed: ${err.message}`,
        partialHops: hops,
      });
    }
  }

  // Add final destination hop
  hops.push({
    hostname: dstNode.data.hostname,
    systemId: dstNode.data.systemId,
    nexthop: null,
    interface: null,
  });

  res.json({
    source: srcNode.data.hostname,
    destination: dstNode.data.hostname,
    algorithm: algoNum,
    algorithmName: algoName,
    hops,
    hopCount: hops.length - 1,
    totalMetric,
    reachable: true,
  });
});

/**
 * GET /api/topology/flexalgo/paths/:systemId/:algo
 * Query FlexAlgo paths from a specific device for a given algorithm.
 * Uses eAPI: `show isis flex-algo path detail`
 *
 * Returns pre-computed FlexAlgo paths from the device to all destinations,
 * including next-hop, interface, metric, and constraint type.
 */
router.get('/flexalgo/paths/:systemId/:algo', async (req, res) => {
  const topology = getTopology(req);
  if (!topology) {
    return res.status(404).json({ error: 'No topology data available' });
  }

  const { systemId, algo } = req.params;
  const algoNum = parseInt(algo, 10);

  // Find the device in the topology
  const node = topology.nodes.find(n => n.data.systemId === systemId || n.data.hostname === systemId);
  if (!node) {
    return res.status(404).json({ error: `Node ${systemId} not found in topology` });
  }

  // Find the device credentials
  const allDevices = deviceStore.getAllRaw();
  const device = allDevices.find(d =>
    d.name.toLowerCase() === (node.data.hostname || '').toLowerCase()
  );

  if (!device) {
    return res.status(404).json({
      error: `No device credentials for ${node.data.hostname}. Add it in the Devices tab.`,
    });
  }

  try {
    const result = await eapi.execute(device, ['show isis flex-algo path detail']);
    const raw = result[0];

    // Parse FlexAlgo paths for the requested algorithm
    const paths = parseFlexAlgoPaths(raw, algoNum, topology);

    res.json({
      source: node.data.hostname,
      sourceSystemId: node.data.systemId,
      algorithm: algoNum,
      paths,
    });
  } catch (err) {
    res.status(500).json({ error: `FlexAlgo path query failed: ${err.message}` });
  }
});

/**
 * Parse FlexAlgo path detail output from eAPI.
 *
 * Structure:
 *   vrfs.default.v4Info.topologies.{topoId}.destinations.{prefix}.paths.{algo}
 *     .algoName, .vias[{ nexthop, intf }], .details.{ metric, constraint }
 *
 * @param {Object} raw - eAPI result for `show isis flex-algo path detail`
 * @param {number} algoNum - The algorithm number to extract (128, 129, etc.)
 * @param {Object} topology - Current ATLAS topology for hostname resolution
 * @returns {Object[]} Parsed paths
 */
function parseFlexAlgoPaths(raw, algoNum, topology) {
  const results = [];
  const vrfs = raw.vrfs || {};

  // Build IP → hostname lookup from topology
  const ipToHost = new Map();
  if (topology?.nodes) {
    for (const n of topology.nodes) {
      const d = n.data;
      if (d.routerCaps?.routerId) ipToHost.set(d.routerCaps.routerId, d.hostname);
      for (const addr of (d.interfaceAddresses || [])) {
        ipToHost.set(addr, d.hostname);
      }
    }
  }

  for (const [vrfName, vrfData] of Object.entries(vrfs)) {
    const topos = vrfData.v4Info?.topologies || {};
    for (const [topoId, topoData] of Object.entries(topos)) {
      const dests = topoData.destinations || {};
      for (const [prefix, destData] of Object.entries(dests)) {
        const algoKey = String(algoNum);
        const pathData = destData.paths?.[algoKey];
        if (!pathData) continue;

        const vias = (pathData.vias || []).map(v => ({
          nexthop: v.nexthop || '',
          interface: v.intf || '',
        }));

        const details = pathData.details || {};
        const destIp = prefix.split('/')[0];

        results.push({
          destination: prefix,
          destinationHostname: ipToHost.get(destIp) || '',
          algoName: pathData.algoName || `Algo ${algoNum}`,
          vias,
          metric: details.metric ?? null,
          constraint: details.constraint || {},
          reachable: vias.length > 0,
        });
      }
    }
  }

  return results.sort((a, b) => a.destination.localeCompare(b.destination));
}

module.exports = router;
