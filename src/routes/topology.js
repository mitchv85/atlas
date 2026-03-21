// ---------------------------------------------------------------------------
// Topology Routes — /api/topology
// ---------------------------------------------------------------------------
// Now uses the background poller's cached topology instead of its own cache.
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { computePath, computePathWithBackups } = require('../services/spf');

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

module.exports = router;
