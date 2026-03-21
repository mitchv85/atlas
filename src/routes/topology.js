// ---------------------------------------------------------------------------
// Topology Routes — /api/topology
// ---------------------------------------------------------------------------
// Now uses the background poller's cached topology instead of its own cache.
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { computePath, computePathWithBackups, computeECMPPaths, lookupTunnelFibLabels } = require('../services/spf');

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
    console.error('Topology collection error:', err);
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
  res.json(result);
});

module.exports = router;
