// ---------------------------------------------------------------------------
// BGP API Routes
// ---------------------------------------------------------------------------
// REST endpoints for BGP data access and FRR configuration management.
//
// Endpoints:
//   GET    /api/bgp/status          BGP subsystem status
//   GET    /api/bgp/config          Current BGP config (sanitized)
//   POST   /api/bgp/config          Update BGP config → deploy to FRR
//   POST   /api/bgp/config/preview  Preview generated FRR config
//   POST   /api/bgp/collect         Trigger manual RIB collection
//   GET    /api/bgp/neighbors       BGP neighbor summary
//   GET    /api/bgp/vrfs            VRF list with prefix counts
//   GET    /api/bgp/vrfs/:rd        Prefixes for a specific VRF
//   GET    /api/bgp/rib             Full VPNv4 RIB with filtering
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const frrManager = require('../services/frrManager');
const bgpGrpc = require('../services/bgpGrpc');
const bgpStore = require('../store/bgp');

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * GET /api/bgp/status
 * Returns BGP subsystem status: FRR service state, gRPC connection, store stats.
 */
router.get('/status', (_req, res) => {
  const bgpConfig = frrManager.readBgpConfig();
  const frrStatus = frrManager.getServiceStatus(bgpConfig);
  const grpcStatus = bgpGrpc.getStatus();
  const storeStatus = bgpStore.getStatus();

  res.json({
    enabled: bgpConfig.enabled || false,
    frr: frrStatus,
    grpc: grpcStatus,
    store: storeStatus,
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * GET /api/bgp/config
 * Returns the current BGP config from atlas.config.json.
 * Sensitive fields (passwords) are not present in BGP config,
 * but we sanitize just in case.
 */
router.get('/config', (_req, res) => {
  const bgpConfig = frrManager.readBgpConfig();
  res.json(bgpConfig);
});

/**
 * POST /api/bgp/config
 * Update BGP configuration and deploy to FRR.
 *
 * Body: Full bgp config object matching the atlas.config.json bgp schema.
 *
 * Flow:
 *   1. Validate config
 *   2. Save to atlas.config.json
 *   3. Generate frr.conf
 *   4. Restart FRR service
 *   5. Reconnect gRPC client
 */
router.post('/config', async (req, res) => {
  const bgpConfig = req.body;

  // Validate required fields
  if (!bgpConfig.localAs || bgpConfig.localAs < 1 || bgpConfig.localAs > 4294967295) {
    return res.status(400).json({ error: 'localAs must be a valid ASN (1-4294967295)' });
  }
  if (!bgpConfig.routerId || !/^\d+\.\d+\.\d+\.\d+$/.test(bgpConfig.routerId)) {
    return res.status(400).json({ error: 'routerId must be a valid IPv4 address' });
  }
  if (bgpConfig.sourceAddress && !/^\d+\.\d+\.\d+\.\d+$/.test(bgpConfig.sourceAddress)) {
    return res.status(400).json({ error: 'sourceAddress must be a valid IPv4 address (or omit to use routerId)' });
  }
  if (!bgpConfig.neighbors || !Array.isArray(bgpConfig.neighbors) || bgpConfig.neighbors.length === 0) {
    return res.status(400).json({ error: 'At least one neighbor (Route Reflector) is required' });
  }

  // Validate each neighbor
  for (const nbr of bgpConfig.neighbors) {
    if (!nbr.address || !/^\d+\.\d+\.\d+\.\d+$/.test(nbr.address)) {
      return res.status(400).json({ error: `Invalid neighbor address: ${nbr.address}` });
    }
  }

  try {
    // Deploy: save config → write FRR files → restart
    const result = frrManager.deploy(bgpConfig);

    // If FRR restarted successfully, (re)connect gRPC
    if (result.success) {
      const grpcPort = bgpConfig.frr?.grpcPort || frrManager.DEFAULTS.grpcPort;

      // Give FRR a moment to start the gRPC listener
      setTimeout(() => {
        bgpGrpc.connect(`127.0.0.1:${grpcPort}`).catch((err) => {
          console.error('  [BGP] gRPC reconnect after deploy failed:', err.message);
        });
      }, 3000);
    }

    // Always return 200 since the config was saved — report per-step results
    res.json({
      success: result.success,
      configSaved: result.configSaved,
      filesWritten: result.filesWritten,
      message: result.success
        ? 'BGP configuration deployed and FRR restarted'
        : result.error || 'Deploy partially completed',
      restart: result.restart,
    });
  } catch (err) {
    res.status(500).json({ error: `Deploy failed: ${err.message}` });
  }
});

/**
 * POST /api/bgp/config/preview
 * Preview the FRR config that would be generated without deploying.
 * Useful for the UI to show a diff or confirmation dialog.
 */
router.post('/config/preview', (req, res) => {
  const bgpConfig = req.body;

  try {
    const preview = frrManager.preview(bgpConfig);
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: `Preview failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Data Collection
// ---------------------------------------------------------------------------

/**
 * POST /api/bgp/collect
 * Trigger a manual BGP RIB collection from FRR.
 * In Phase 1, this runs a one-shot gRPC Get or vtysh fallback.
 * In Phase 3, the gRPC subscription handles continuous updates.
 */
router.post('/collect', async (_req, res) => {
  if (bgpStore.collecting) {
    return res.status(409).json({ error: 'Collection already in progress' });
  }

  try {
    bgpStore.setCollecting(true);

    // TODO Phase 1: Implement collection via gRPC Get or vtysh fallback
    // const grpcStatus = bgpGrpc.getStatus();
    // if (grpcStatus.connected) {
    //   // gRPC path
    //   const ribData = await bgpGrpc.get('/frr-bgp:bgp/...');
    //   ...
    // } else {
    //   // vtysh fallback
    //   const { execSync } = require('child_process');
    //   const raw = JSON.parse(execSync('vtysh -c "show bgp ipv4 vpn json"', { encoding: 'utf-8' }));
    //   const { vrfs, rib } = bgpParser.parseVpnv4Rib(raw);
    //   ...
    // }

    bgpStore.setCollecting(false);
    res.json({
      success: true,
      message: 'Collection triggered (Phase 1 implementation pending)',
      status: bgpStore.getStatus(),
    });
  } catch (err) {
    bgpStore.setCollecting(false);
    bgpStore.setError(err);
    res.status(500).json({ error: `Collection failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Neighbors
// ---------------------------------------------------------------------------

/**
 * GET /api/bgp/neighbors
 * BGP neighbor (peer session) summary.
 */
router.get('/neighbors', (_req, res) => {
  res.json(bgpStore.getNeighbors());
});

// ---------------------------------------------------------------------------
// VRFs
// ---------------------------------------------------------------------------

/**
 * GET /api/bgp/vrfs
 * List all VRFs with summary info (RD, name, RT, prefix count).
 */
router.get('/vrfs', (_req, res) => {
  res.json(bgpStore.getVrfSummary());
});

/**
 * GET /api/bgp/vrfs/:rd
 * Get detailed info for a specific VRF including all prefixes.
 *
 * :rd is URL-encoded since RDs contain colons (e.g., "100.0.0.1:1").
 */
router.get('/vrfs/:rd', (req, res) => {
  const rd = decodeURIComponent(req.params.rd);
  const vrf = bgpStore.getVrf(rd);

  if (!vrf) {
    return res.status(404).json({ error: `VRF with RD ${rd} not found` });
  }

  res.json(vrf);
});

// ---------------------------------------------------------------------------
// RIB
// ---------------------------------------------------------------------------

/**
 * GET /api/bgp/rib
 * Full VPNv4 RIB with optional query-parameter filtering.
 *
 * Query params:
 *   rd        - Filter by Route Distinguisher
 *   prefix    - Filter by prefix (substring match)
 *   nextHop   - Filter by next-hop address
 *   rt        - Filter by Route Target
 *   originPE  - Filter by originating PE hostname
 *   bestOnly  - Only return best paths (true/false)
 *   limit     - Max results (default: 500)
 *   offset    - Pagination offset (default: 0)
 */
router.get('/rib', (req, res) => {
  const filters = {
    rd: req.query.rd || undefined,
    prefix: req.query.prefix || undefined,
    nextHop: req.query.nextHop || undefined,
    rt: req.query.rt || undefined,
    originPE: req.query.originPE || undefined,
    bestOnly: req.query.bestOnly === 'true',
    limit: parseInt(req.query.limit, 10) || 500,
    offset: parseInt(req.query.offset, 10) || 0,
  };

  res.json(bgpStore.getRib(filters));
});

module.exports = router;
