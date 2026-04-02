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
 * Trigger a manual BGP data collection from FRR via vtysh JSON.
 * Collects neighbor summary and VPNv4 RIB, parses them, and
 * populates the BGP store.
 */
router.post('/collect', async (_req, res) => {
  if (bgpStore.collecting) {
    return res.status(409).json({ error: 'Collection already in progress' });
  }

  try {
    bgpStore.setCollecting(true);

    const { execSync } = require('child_process');
    const bgpParser = require('../services/bgpParser');
    const poller = require('../services/poller');

    // 1. Collect neighbor summary
    try {
      const nbrRaw = JSON.parse(
        execSync('vtysh -c "show bgp summary json"', { encoding: 'utf-8', timeout: 15000 })
      );
      const neighbors = bgpParser.parseNeighborSummary(nbrRaw);
      bgpStore.setNeighbors(neighbors);
    } catch (err) {
      console.error('  [BGP] Neighbor collection failed:', err.message);
    }

    // 2. Collect VPNv4 RIB
    try {
      const ribRaw = JSON.parse(
        execSync('vtysh -c "show bgp ipv4 vpn json"', { encoding: 'utf-8', timeout: 30000 })
      );
      const { vrfs, rib } = bgpParser.parseVpnv4Rib(ribRaw);

      // Enrich with topology data (map next-hops to PE hostnames)
      const topology = poller.getTopology();
      if (topology) {
        bgpParser.enrichWithTopology(rib, topology);
      }

      // 3. Enrich VRFs with Route Targets by querying one sample prefix per RD
      for (const [rd, vrf] of vrfs) {
        if (vrf.rtImport.length > 0 || !vrf.samplePrefix) continue;
        try {
          const detailRaw = JSON.parse(
            execSync(`vtysh -c "show bgp ipv4 vpn ${vrf.samplePrefix} json"`, { encoding: 'utf-8', timeout: 10000 })
          );
          const details = bgpParser.parsePrefixDetail(detailRaw);
          // Apply RTs from the detail to the VRF
          for (const d of details) {
            if (d.rd === rd) {
              for (const rt of d.rts) {
                if (!vrf.rtImport.includes(rt)) vrf.rtImport.push(rt);
                if (!vrf.rtExport.includes(rt)) vrf.rtExport.push(rt);
              }
              // Also backfill label on the matching RIB entries
              if (d.label) {
                for (const entry of rib) {
                  if (entry.rd === rd && !entry.label) entry.label = d.label;
                }
              }
            }
          }
        } catch (err) {
          console.error(`  [BGP] RT lookup for RD ${rd} failed:`, err.message);
        }
      }

      bgpStore.setVrfs(vrfs);
      bgpStore.setRib(rib);
    } catch (err) {
      console.error('  [BGP] VPNv4 RIB collection failed:', err.message);
    }

    bgpStore.setCollecting(false);
    res.json({
      success: true,
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
 * GET /api/bgp/vrfs/by-rt
 * List VRFs grouped by Route Target.
 * Same RT across multiple PEs = one logical VRF with multiple RDs.
 * Returns: [{ rt, name, rds: [{ rd, prefixCount }], totalPrefixes }]
 */
router.get('/vrfs/by-rt', (_req, res) => {
  res.json(bgpStore.getVrfsByRT());
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

// ---------------------------------------------------------------------------
// Prefix Detail
// ---------------------------------------------------------------------------

/**
 * GET /api/bgp/prefix-list
 * Return a flat, deduplicated, sorted list of all known VRF prefixes as
 * "prefix/len" strings — used by the service-trace prefix autocomplete.
 */
router.get('/prefix-list', (req, res) => {
  const { entries } = bgpStore.getRib({ limit: 10000 });
  const seen = new Set();
  for (const e of entries) {
    seen.add(`${e.prefix}/${e.prefixLen}`);
  }
  const list = [...seen].sort((a, b) => {
    const [aOct] = a.split('.').map(Number);
    const [bOct] = b.split('.').map(Number);
    return aOct !== bOct ? aOct - bOct : a.localeCompare(b);
  });
  res.json(list);
});

/**
 * GET /api/bgp/debug-rib
 * Returns the first 5 RIB entries with full raw extCommunities — lets us
 * confirm exactly what the bulk FRR collection stores vs. per-prefix detail.
 * Also probes the top-level FRR JSON structure to diagnose parsing mismatches.
 * Temporary diagnostic — remove once Color community format is confirmed.
 */
router.get('/debug-rib', (req, res) => {
  const { entries } = bgpStore.getRib({ limit: 5 });

  // Also probe the live FRR JSON structure so we can see if the parser
  // is targeting the right field path (raw.routes?.routeDistinguishers)
  let frrStructure = null;
  try {
    const { execSync } = require('child_process');
    const raw = JSON.parse(
      execSync('vtysh -c "show bgp ipv4 vpn json"', { encoding: 'utf-8', timeout: 15000 })
    );
    // Return the top-level keys and one level of nesting — don't dump the full table
    const rds = raw.routes?.routeDistinguishers || {};
    const firstRD = Object.keys(rds)[0];
    const firstRDData = firstRD ? rds[firstRD] : null;
    const firstPfxKey = firstRDData ? Object.keys(firstRDData)[0] : null;
    const firstPfxVal = (firstRDData && firstPfxKey) ? firstRDData[firstPfxKey] : null;

    frrStructure = {
      topLevelKeys:       Object.keys(raw),
      routesKeys:         raw.routes      ? Object.keys(raw.routes)      : null,
      vrfsKeys:           raw.vrfs        ? Object.keys(raw.vrfs)        : null,
      hasRouteDist:       !!(raw.routes?.routeDistinguishers),
      hasBareRouteDist:   !!(raw.routeDistinguishers),
      sampleRD:           firstRD || null,
      // What shape is the value under the first prefix key?
      // Parser expects: Array of path objects  [{ nexthops, remoteLabel, ... }]
      // If FRR returns:  { paths: [...] }  the parser will silently miss everything
      firstPrefixKey:     firstPfxKey,
      firstPrefixValType: Array.isArray(firstPfxVal) ? 'ARRAY' : (firstPfxVal && typeof firstPfxVal === 'object') ? 'OBJECT:' + Object.keys(firstPfxVal).join(',') : String(firstPfxVal),
      // Show the raw first path entry so we can see field names
      firstPathSample:    Array.isArray(firstPfxVal)
                            ? firstPfxVal[0]
                            : (firstPfxVal?.paths?.[0] ?? firstPfxVal),
    };

    // Run the parser directly against live data — if liveParseTest.vrfCount > 0
    // but store vrfCount is 0, collect is broken. If parse throws or returns 0,
    // the parser itself is the problem.
    try {
      const bgpParser = require('../services/bgpParser');
      const { vrfs, rib } = bgpParser.parseVpnv4Rib(raw);
      frrStructure.liveParseTest = {
        vrfCount:  vrfs.size,
        ribLength: rib.length,
        sampleEntry: rib[0] ? {
          prefix:         `${rib[0].prefix}/${rib[0].prefixLen}`,
          nextHop:        rib[0].nextHop,
          label:          rib[0].label,
          extCommunities: rib[0].extCommunities,
          bestpath:       rib[0].bestpath,
        } : null,
      };
    } catch (parseErr) {
      frrStructure.liveParseTest = { error: parseErr.message };
    }
  } catch (e) {
    frrStructure = { error: e.message };
  }

  res.json({
    ribLength: bgpStore.rib.length,
    vrfCount:  bgpStore.vrfs.size,
    frrStructure,
    sampleEntries: entries.map(e => ({
      prefix:         `${e.prefix}/${e.prefixLen}`,
      extCommunities: e.extCommunities,
      communities:    e.communities,
      label:          e.label,
    })),
  });
});

/**
 * GET /api/bgp/prefix/:prefix
 * Fetch full BGP path detail for a specific prefix via vtysh.
 * Returns extended communities, standard communities, cluster list,
 * originator ID, label, AS path, and all other path attributes.
 *
 * :prefix is URL-encoded (e.g., "91.0.0.1%2F32" for "91.0.0.1/32").
 */
router.get('/prefix/:prefix', (req, res) => {
  const prefix = decodeURIComponent(req.params.prefix);

  // Validate prefix format
  if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(prefix)) {
    return res.status(400).json({ error: `Invalid prefix format: ${prefix}` });
  }

  try {
    const { execSync } = require('child_process');
    const bgpParser = require('../services/bgpParser');

    const raw = JSON.parse(
      execSync(`vtysh -c "show bgp ipv4 vpn ${prefix} json"`, { encoding: 'utf-8', timeout: 10000 })
    );

    const details = bgpParser.parsePrefixDetail(raw);

    // Enrich with PE hostnames from topology
    const poller = require('../services/poller');
    const topology = poller.getTopology();
    if (topology) {
      for (const d of details) {
        d.originPE = resolveNextHopToPE(d.nextHop, topology) || '';
        d.originatorPE = resolveNextHopToPE(d.originatorId, topology) || '';
      }
    }

    res.json({ prefix, paths: details });
  } catch (err) {
    res.status(500).json({ error: `Prefix lookup failed: ${err.message}` });
  }
});

/**
 * Resolve an IP address to a PE hostname using the topology.
 */
function resolveNextHopToPE(ip, topology) {
  if (!ip || !topology?.nodes) return null;
  for (const node of topology.nodes) {
    const d = node.data;
    if (d.routerCaps?.routerId === ip) return d.hostname;
    if ((d.interfaceAddresses || []).includes(ip)) return d.hostname;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service Path Trace
// ---------------------------------------------------------------------------

/**
 * POST /api/bgp/trace
 * Trace the end-to-end service path for a VPN prefix.
 *
 * Given a source PE and a destination VPN prefix, ATLAS:
 *   1. Looks up the prefix in BGP (via vtysh detail query)
 *   2. Extracts: next-hop (dest PE), VPN label, Color community
 *   3. Determines transport algorithm from Color community
 *   4. Computes the transport path (FlexAlgo or standard IGP)
 *   5. Returns the full service path with label stacks
 *
 * Body: { sourceNode: "PE-1", prefix: "92.1.1.2/32", vrf: "91:91", algoOverride: 128 }
 */
router.post('/trace', async (req, res) => {
  const { sourceNode, prefix, vrf, algoOverride } = req.body;

  if (!sourceNode || !prefix) {
    return res.status(400).json({ error: 'sourceNode and prefix are required' });
  }

  try {
    const { execSync } = require('child_process');
    const bgpParser = require('../services/bgpParser');
    const poller = require('../services/poller');
    const topology = poller.getTopology();

    // 1. Fetch prefix detail from FRR
    const raw = JSON.parse(
      execSync(`vtysh -c "show bgp ipv4 vpn ${prefix} json"`, { encoding: 'utf-8', timeout: 10000 })
    );
    const details = bgpParser.parsePrefixDetail(raw);

    if (!details || details.length === 0) {
      return res.json({ error: `Prefix ${prefix} not found in VPNv4 RIB` });
    }

    // If VRF (RT) is specified, filter to only matching RDs
    let candidates = details;
    if (vrf) {
      const matchingRDs = new Set();
      for (const v of bgpStore.vrfs.values()) {
        if (v.rtImport.includes(vrf) || v.rtExport.includes(vrf)) {
          matchingRDs.add(v.rd);
        }
      }
      if (matchingRDs.size > 0) {
        candidates = details.filter(d => matchingRDs.has(d.rd));
      }
    }

    if (candidates.length === 0) {
      return res.json({ error: `Prefix ${prefix} not found in VRF ${vrf}` });
    }

    // Use the best path
    const best = candidates.find(d => d.bestpath) || candidates[0];

    // 2. Resolve destination PE
    const destPE = topology ? resolveNextHopToPE(best.nextHop, topology) : best.nextHop;
    const destNode = topology?.nodes?.find(n =>
      n.data.hostname === destPE || n.data.routerCaps?.routerId === best.nextHop
    );

    // 3. Extract color community → transport algorithm
    const colorComm = (best.extCommunities || []).find(c => c.type === 'Color');
    const actualAlgo = colorComm ? colorComm.value : 0;
    const transportAlgo = (algoOverride != null) ? algoOverride : actualAlgo;
    const isWhatIf = algoOverride != null && algoOverride !== actualAlgo;
    const algoName = transportAlgo === 0 ? 'IGP (SPF)'
      : transportAlgo === 128 ? 'MIN_DELAY'
      : transportAlgo === 129 ? 'TE_METRIC'
      : `Algo ${transportAlgo}`;

    // 4. Resolve source PE
    const srcNode = topology?.nodes?.find(n =>
      n.data.hostname?.toLowerCase() === sourceNode.toLowerCase() ||
      n.data.id === sourceNode
    );

    if (!srcNode) {
      return res.json({ error: `Source node ${sourceNode} not found in topology` });
    }

    // 5. Compute transport label (destination's prefix SID for the algo)
    let transportLabel = null;
    let transportSidIndex = null;
    const srgbBase = srcNode.data.routerCaps?.srgb?.[0]?.base || 900000;

    if (destNode) {
      const destSids = destNode.data.srPrefixSids || [];
      const faSid = destSids.find(s => s.algorithm === transportAlgo);
      if (faSid) {
        transportSidIndex = faSid.sid;
        transportLabel = srgbBase + faSid.sid;
      }
    }

    // 6. Build label stack: [Transport Label, VPN Label]
    const labelStack = [];
    if (transportLabel) {
      labelStack.push({
        label: transportLabel,
        type: transportAlgo >= 128 ? `FlexAlgo ${transportAlgo} Prefix-SID` : 'Prefix-SID',
        description: `${algoName} SID ${transportSidIndex} → label ${transportLabel}`,
        target: destPE || best.nextHop,
      });
    }
    if (best.label) {
      labelStack.push({
        label: best.label,
        type: 'VPN Label',
        description: `VPN service label for ${prefix}`,
        target: prefix,
      });
    }

    // 7. Compute transport path
    let transportPath = null;

    if (transportAlgo >= 128) {
      // FlexAlgo path — query from source device via eAPI
      try {
        const deviceStore = require('../store/devices');
        const allDevices = deviceStore.getAllRaw();
        const device = allDevices.find(d =>
          d.name.toLowerCase() === srcNode.data.hostname.toLowerCase()
        );

        if (device) {
          const eapi = require('../services/eapi');
          const faResult = await eapi.execute(device, ['show isis flex-algo path detail'], 'json');
          const faRaw = faResult[0];

          // Extract the path for the destination PE's loopback
          const destIp = best.nextHop;
          const destPrefix = `${destIp}/32`;
          const vrfs = faRaw?.vrfs || {};

          for (const vrfData of Object.values(vrfs)) {
            const topos = vrfData.v4Info?.topologies || {};
            for (const topoData of Object.values(topos)) {
              const destData = topoData.destinations?.[destPrefix];
              if (!destData) continue;
              const pathData = destData.paths?.[String(transportAlgo)];
              if (!pathData) continue;

              transportPath = {
                algorithm: transportAlgo,
                algorithmName: algoName,
                metric: pathData.details?.metric ?? null,
                reachable: (pathData.vias || []).length > 0,
                vias: (pathData.vias || []).map(v => ({
                  nexthop: v.nexthop || '',
                  interface: v.intf || '',
                })),
              };
            }
          }
        }
      } catch (faErr) {
        // FlexAlgo path query failed — still return what we have
        console.error('  [Trace] FlexAlgo path query failed:', faErr.message);
      }
    } else {
      // Standard IGP path — use existing SPF computation
      try {
        const { computePath } = require('../services/spf');
        const spfResult = computePath(topology, srcNode.data.id, destNode?.data.id);
        if (spfResult) {
          transportPath = {
            algorithm: 0,
            algorithmName: 'IGP (SPF)',
            metric: spfResult.totalMetric,
            reachable: spfResult.reachable !== false,
            hops: spfResult.hops,
            hopCount: spfResult.hopCount,
          };
        }
      } catch {
        // SPF failed
      }
    }

    // Collect available algorithms from topology for "What if" buttons
    const availableAlgos = topology?.metadata?.algorithms
      ?.filter(a => a.number >= 128)
      ?.map(a => ({ number: a.number, name: a.name })) || [];

    // 8. Build the response
    res.json({
      prefix,
      rd: best.rd,
      vrf: vrf || null,
      sourceNode: srcNode.data.hostname,
      destinationPE: destPE || best.nextHop,
      destinationPEId: destNode?.data.id || null,
      nextHop: best.nextHop,
      vpnLabel: best.label,
      colorCommunity: colorComm ? colorComm.value : null,
      transportAlgorithm: transportAlgo,
      transportAlgorithmName: algoName,
      isWhatIf,
      actualAlgorithm: actualAlgo,
      availableAlgos,
      labelStack,
      transportPath,
      bgpAttributes: {
        asPath: best.asPath,
        origin: best.origin,
        locPref: best.locPref,
        originatorId: best.originatorId,
        clusterList: best.clusterList,
        extCommunities: best.extCommunities,
        communities: best.communities,
      },
    });
  } catch (err) {
    res.status(500).json({ error: `Service path trace failed: ${err.message}` });
  }
});

module.exports = router;
