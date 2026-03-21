// ---------------------------------------------------------------------------
// Topology Routes — /api/topology
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const deviceStore = require('../store/devices');
const eapi = require('../services/eapi');
const { parseLSDB, parseNeighbors } = require('../services/isisParser');
const { buildGraph } = require('../services/topologyBuilder');

// In-memory cache of the last collected topology
let cachedTopology = null;

// GET /api/topology — Return the current topology graph
router.get('/', (_req, res) => {
  if (!cachedTopology) {
    return res.status(404).json({
      error: 'No topology data. Use POST /api/topology/collect to gather LSDB.',
    });
  }
  res.json(cachedTopology);
});

// POST /api/topology/collect — Query device(s) and build the topology
router.post('/collect', async (req, res) => {
  const { deviceId } = req.body;

  // If a specific device is targeted, use it; otherwise query all devices
  let targetDevices = [];
  if (deviceId) {
    const d = deviceStore.getRaw(deviceId);
    if (!d) return res.status(404).json({ error: 'Device not found' });
    targetDevices = [d];
  } else {
    targetDevices = deviceStore.list().map((d) => deviceStore.getRaw(d.id)).filter(Boolean);
  }

  if (targetDevices.length === 0) {
    return res.status(400).json({ error: 'No devices configured. Add a device first.' });
  }

  try {
    // Collect LSDB from each device — the LSDB is a distributed database,
    // so any single device in the IS-IS domain should have the full picture.
    // We collect from all configured devices and merge in case of multi-area.
    const allNodes = new Map();
    const allAdjacencies = [];

    for (const device of targetDevices) {
      const commands = ['show isis database detail'];

      const results = await eapi.execute(device, commands, 'json');
      const lsdbRaw = results[0];

      const { nodes, adjacencies } = parseLSDB(lsdbRaw);

      // Merge into global maps
      for (const [sysId, nodeInfo] of nodes) {
        if (!allNodes.has(sysId)) {
          allNodes.set(sysId, nodeInfo);
        }
      }
      allAdjacencies.push(...adjacencies);
    }

    // Build the Cytoscape.js graph
    const topology = buildGraph(allNodes, allAdjacencies);
    topology.metadata.sourceDevices = targetDevices.map((d) => d.name);

    // Cache it
    cachedTopology = topology;

    res.json(topology);
  } catch (err) {
    console.error('Topology collection error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/topology/node/:systemId — Detailed info for a single node
router.get('/node/:systemId', (req, res) => {
  if (!cachedTopology) {
    return res.status(404).json({ error: 'No topology data available.' });
  }

  const node = cachedTopology.nodes.find(
    (n) => n.data.systemId === req.params.systemId
  );

  if (!node) return res.status(404).json({ error: 'Node not found in topology.' });
  res.json(node.data);
});

module.exports = router;
