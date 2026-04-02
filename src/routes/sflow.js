// ---------------------------------------------------------------------------
// sFlow API Routes
// ---------------------------------------------------------------------------
// REST endpoints for sFlow flow data, collector status, and configuration.
//
// Endpoints:
//   GET  /api/sflow/status          - Collector + aggregator status
//   GET  /api/sflow/flows           - Current flow snapshot (all LSPs + edges)
//   GET  /api/sflow/lsp/:lspKey     - Detailed flow data for a specific LSP
//   GET  /api/sflow/edge/:edgeId    - Flow data for a specific topology edge
//   POST /api/sflow/config          - Update sFlow configuration
//   GET  /api/sflow/config/eos      - Generate Arista EOS sFlow config snippet
// ---------------------------------------------------------------------------

const express     = require('express');
const router      = express.Router();
const sflowStore  = require('../store/sflow');
const deviceStore = require('../store/devices');

// ── Status ────────────────────────────────────────────────────────────────

router.get('/status', (_req, res) => {
  res.json(sflowStore.getStatus());
});

// ── Flow Snapshot ─────────────────────────────────────────────────────────

router.get('/flows', (_req, res) => {
  const snapshot = sflowStore.getSnapshot();
  res.json(snapshot);
});

// ── Tunnel Counter Rates (deterministic, from eAPI polling) ───────────────

router.get('/tunnel-rates', (req, res) => {
  const poller = req.app.get('poller');
  if (!poller) {
    return res.status(503).json({ error: 'Poller not initialized' });
  }
  res.json({ rates: poller.getTunnelRates() });
});

// ── LSP Detail ────────────────────────────────────────────────────────────

router.get('/lsp/:lspKey', (req, res) => {
  const aggregator = req.app.get('sflowAggregator');
  if (!aggregator) {
    return res.status(503).json({ error: 'sFlow aggregator not initialized' });
  }

  const detail = aggregator.getLspDetail(decodeURIComponent(req.params.lspKey));
  if (!detail) {
    return res.status(404).json({ error: 'LSP not found or no recent flow data' });
  }

  res.json(detail);
});

// ── Edge Detail ───────────────────────────────────────────────────────────

router.get('/edge/:edgeId', (req, res) => {
  const aggregator = req.app.get('sflowAggregator');
  if (!aggregator) {
    return res.status(503).json({ error: 'sFlow aggregator not initialized' });
  }

  const detail = aggregator.getEdgeDetail(req.params.edgeId);
  if (!detail) {
    return res.status(404).json({ error: 'Edge not found or no recent flow data' });
  }

  res.json(detail);
});

// ── Configuration ─────────────────────────────────────────────────────────

router.post('/config', (req, res) => {
  const { enabled, port } = req.body;
  const config = {};

  if (typeof enabled === 'boolean') config.enabled = enabled;
  if (typeof port === 'number' && port > 0 && port < 65536) config.port = port;

  sflowStore.setConfig(config);
  res.json({ ok: true, config: sflowStore.getConfig() });
});

// ── EOS Config Generator ─────────────────────────────────────────────────

router.get('/config/eos', (req, res) => {
  const config = sflowStore.getConfig();
  const collectorIP = req.query.collectorIP || '<ATLAS_SERVER_IP>';
  const samplingRate = req.query.samplingRate || 1024;

  // Build Arista EOS sFlow configuration snippet
  const eosConfig = [
    '! ── sFlow Configuration for ATLAS ──',
    '! Apply this to each Arista EOS device in the topology.',
    '! Replace <ATLAS_SERVER_IP> with the ATLAS server\'s reachable IP.',
    '!',
    `sflow sample ${samplingRate}`,
    `sflow destination ${collectorIP} ${config.port}`,
    'sflow source-interface Loopback0',
    'sflow run',
    '!',
    '! Enable sFlow on all routed interfaces:',
    '! (Apply per-interface or use a range)',
  ];

  // Add per-interface enable hints
  const devices = deviceStore.getAllRaw();
  if (devices.length > 0) {
    eosConfig.push('!');
    eosConfig.push('! Example for core-facing interfaces:');
    eosConfig.push('interface Ethernet1-8');
    eosConfig.push('   sflow enable');
  }

  res.json({
    eosConfig: eosConfig.join('\n'),
    collectorIP,
    collectorPort: config.port,
    samplingRate: parseInt(samplingRate),
  });
});

// ── Diagnostics ───────────────────────────────────────────────────────────

router.get('/debug', (req, res) => {
  const aggregator = req.app.get('sflowAggregator');
  if (!aggregator) {
    return res.status(503).json({ error: 'sFlow aggregator not initialized' });
  }

  res.json({
    srgbBase: aggregator._srgbBase,
    srgbRange: aggregator._srgbRange,
    agentMapSize: aggregator._agentMap.size,
    agentMap: Object.fromEntries(aggregator._agentMap),
    sidToNodeSize: aggregator._sidToNode.size,
    sidToNode: Object.fromEntries(
      Array.from(aggregator._sidToNode.entries()).slice(0, 20)
    ),
    adjSidMapSize: aggregator._adjSidMap.size,
    faSidMapSize: aggregator._faSidToNode.size,
    stats: aggregator.getStats(),
  });
});

module.exports = router;
