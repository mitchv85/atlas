// ---------------------------------------------------------------------------
// IS-IS LSDB Parser
// ---------------------------------------------------------------------------
// Parses Arista EOS eAPI output from IS-IS commands into a normalized
// graph-friendly data model.
//
// Tested against: Arista EOS eAPI JSON output
//   - show isis database detail
//   - show isis hostname
//
// Key structure (eAPI):
//   result[0].vrfs.<vrf>.isisInstances.<inst>.level.<lvl>.lsps.<lspId>
//     .hostname.name         -> dynamic hostname
//     .neighbors[]           -> IS reachability (TLV 22)
//       .systemId            -> "PE-3.00" (hostname-based, NOT dotted system-id)
//       .metric              -> link metric
//       .neighborAddr        -> neighbor IP
//       .adjSids[]           -> adjacency SIDs
//     .reachabilities[]      -> IP reachability (TLV 135)
//       .reachabilityV4Addr  -> prefix
//       .maskLength          -> prefix length
//       .metric              -> prefix metric
//       .srPrefixReachabilities[] -> SR Prefix SIDs
//     .routerCapabilities[]  -> Router capabilities (TLV 242)
//       .srCapabilities[].srCapabilitySrgb[] -> SRGB
//       .srlb.srlbRanges[]   -> SRLB
//       .srAlgos             -> SR Algorithms
//       .flexAlgoDefs        -> FlexAlgo Definitions
// ---------------------------------------------------------------------------

/**
 * Parse the output of `show isis database detail` (JSON format).
 *
 * @param {Object} raw - Raw eAPI JSON result for `show isis database detail`
 * @returns {Object} - { nodes: Map<systemId, NodeInfo>, adjacencies: [] }
 */
function parseLSDB(raw) {
  const nodes = new Map();
  const adjacencies = [];

  // Build a hostname -> systemId lookup for resolving neighbor references
  const hostnameLookup = new Map(); // "PE-1" -> "0000.0000.0001"

  const vrfs = raw.vrfs || {};

  for (const [vrfName, vrfData] of Object.entries(vrfs)) {
    const instances = vrfData.isisInstances || {};

    for (const [instanceName, instanceData] of Object.entries(instances)) {
      const levels = instanceData.level || {};

      for (const [levelNum, levelData] of Object.entries(levels)) {
        const lsps = levelData.lsps || {};

        // ── First pass: build hostname lookup and node entries ──
        for (const [lspId, lspData] of Object.entries(lsps)) {
          // Only process fragment 0 of real nodes (not pseudonodes)
          // Real node LSPs: "0000.0000.0001.00-00" (4th octet is 00)
          // Pseudonode LSPs: "0000.0000.0003.01-00" (4th octet > 00)
          const lspParts = lspId.split('.');
          // lspParts for "0000.0000.0001.00-00" = ["0000","0000","0001","00-00"]
          const fragmentPart = lspParts[lspParts.length - 1]; // "00-00"
          const pseudonodePart = fragmentPart.split('-')[0];   // "00"

          // Skip pseudonode LSPs
          if (pseudonodePart !== '00') continue;

          // Only process fragment 0
          if (!fragmentPart.endsWith('-00')) continue;

          const hostname = lspData.hostname?.name || '';
          // System ID = LSP ID minus the ".00-00" suffix
          const systemId = lspId.replace('.00-00', '');

          // Register hostname lookup
          if (hostname) {
            hostnameLookup.set(hostname, systemId);
          }

          // Parse router capabilities
          const routerCaps = parseRouterCapabilities(lspData.routerCapabilities || []);

          // Parse reachabilities (prefixes + SR Prefix SIDs)
          const { prefixes, srPrefixSids } = parseReachabilities(lspData.reachabilities || []);

          // Parse neighbors (adjacencies + Adj-SIDs)
          const { neighborList, adjSids } = parseNeighborsFromLSP(lspData.neighbors || []);

          const node = {
            systemId,
            hostname,
            lspId,
            level: parseInt(levelNum),
            instance: instanceName,
            vrf: vrfName,
            sequenceNumber: lspData.sequence || 0,
            remainingLifetime: Math.max(0, Math.round((lspData.expiryTime || 0) - (Date.now() / 1000))),
            checksum: lspData.checksum || 0,
            areaAddresses: (lspData.areaAddresses || []).map(a => a.address),
            interfaceAddresses: (lspData.interfaceAddresses || []).map(a => a.ipv4Address),
            overload: lspData.flags?.dbOverload || false,
            prefixes,
            srPrefixSids,
            neighborList,
            srAdjSids: adjSids,
            routerCaps,
          };

          nodes.set(systemId, node);
        }

        // ── Second pass: build adjacency list with resolved system-ids ──
        for (const [lspId, lspData] of Object.entries(lsps)) {
          if (!lspId.endsWith('.00-00')) continue;

          const pseudoCheck = lspId.split('.').pop().split('-')[0];
          if (pseudoCheck !== '00') continue;

          const fromSystemId = lspId.replace('.00-00', '');
          const fromHostname = lspData.hostname?.name || fromSystemId;

          for (const nbr of (lspData.neighbors || [])) {
            // Neighbor systemId is hostname-based: "PE-3.00"
            // Strip the ".00" pseudonode suffix to get the hostname
            const nbrHostname = nbr.systemId?.replace(/\.\d+$/, '') || '';
            const toSystemId = hostnameLookup.get(nbrHostname) || nbrHostname;

            // Extract adj-SIDs for this specific adjacency
            const nbrAdjSids = (nbr.adjSids || []).map(s => ({
              sid: s.adjSid,
              flags: s.adjFlags || {},
              weight: s.adjWeight || 0,
            }));

            adjacencies.push({
              fromSystemId,
              fromHostname,
              toSystemId,
              toHostname: nbrHostname,
              metric: nbr.metric || 10,
              level: parseInt(levelNum),
              neighborAddr: nbr.neighborAddr || '',
              localAddr: nbr.adjInterfaceAddresses?.[0]?.adjInterfaceAddress || '',
              adjSids: nbrAdjSids,
            });
          }
        }
      }
    }
  }

  return { nodes, adjacencies };
}

/**
 * Parse router capabilities (TLV 242) for SR and FlexAlgo info.
 */
function parseRouterCapabilities(capabilities) {
  const result = {
    routerId: '',
    srgb: [],
    srlb: [],
    srAlgorithms: [],
    flexAlgoDefinitions: [],
    maxSIDDepth: 0,
  };

  for (const cap of capabilities) {
    result.routerId = cap.routerId || result.routerId;

    // SRGB
    const srCaps = cap.srCapabilities || [];
    for (const sr of srCaps) {
      for (const srgb of (sr.srCapabilitySrgb || [])) {
        result.srgb.push({
          base: srgb.srgbBase,
          range: srgb.srgbRange,
        });
      }
    }

    // SRLB
    const srlb = cap.srlb?.srlbRanges || [];
    for (const range of srlb) {
      result.srlb.push({
        base: range.srlbBase,
        range: range.srlbRange,
      });
    }

    // MSD (Maximum SID Depth)
    result.maxSIDDepth = cap.msd?.baseMplsImposition || result.maxSIDDepth;

    // SR Algorithms
    if (cap.srAlgos && Object.keys(cap.srAlgos).length > 0) {
      result.srAlgorithms = cap.srAlgos;
    }

    // FlexAlgo Definitions
    if (cap.flexAlgoDefs && Object.keys(cap.flexAlgoDefs).length > 0) {
      result.flexAlgoDefinitions = cap.flexAlgoDefs;
    }
  }

  return result;
}

/**
 * Parse reachabilities (TLV 135) — prefixes and SR Prefix SIDs.
 */
function parseReachabilities(reachabilities) {
  const prefixes = [];
  const srPrefixSids = [];

  for (const reach of reachabilities) {
    const prefix = reach.reachabilityV4Addr || '';
    const mask = reach.maskLength || 0;
    const metric = reach.metric || 0;

    prefixes.push({
      prefix,
      mask,
      metric,
      metricType: reach.metricType || 'Internal',
      upDown: reach.reachabilityUpDown || false,
    });

    // SR Prefix SIDs (sub-TLV 3 of TLV 135)
    for (const sr of (reach.srPrefixReachabilities || [])) {
      srPrefixSids.push({
        prefix: `${prefix}/${mask}`,
        sid: sr.sid,
        algorithm: sr.algoNum ?? 0,
        algorithmName: sr.algo || 'SPF',
        flags: sr.options || {},
        isNodeSid: sr.options?.nodeSID || false,
      });
    }
  }

  return { prefixes, srPrefixSids };
}

/**
 * Parse neighbors from an LSP — adjacencies and Adj-SIDs.
 */
function parseNeighborsFromLSP(neighbors) {
  const neighborList = [];
  const adjSids = [];

  for (const nbr of neighbors) {
    const nbrHostname = nbr.systemId?.replace(/\.\d+$/, '') || '';

    neighborList.push({
      neighborId: nbr.systemId || '',
      neighborHostname: nbrHostname,
      metric: nbr.metric || 10,
      neighborAddr: nbr.neighborAddr || '',
      localAddr: nbr.adjInterfaceAddresses?.[0]?.adjInterfaceAddress || '',
    });

    // Adj-SIDs
    for (const sid of (nbr.adjSids || [])) {
      adjSids.push({
        neighbor: nbrHostname,
        sid: sid.adjSid,
        flags: sid.adjFlags || {},
        weight: sid.adjWeight || 0,
      });
    }
  }

  return { neighborList, adjSids };
}

/**
 * Parse `show isis hostname` output for hostname-to-systemId mapping.
 *
 * @param {Object} raw - eAPI result for `show isis hostname`
 * @returns {Map<string, string>} - Map of systemId -> hostname
 */
function parseHostnameTable(raw) {
  const mapping = new Map();
  const vrfs = raw.vrfs || {};

  for (const [_vrfName, vrfData] of Object.entries(vrfs)) {
    const instances = vrfData.isisInstances || {};

    for (const [_instName, instData] of Object.entries(instances)) {
      const systemIds = instData.systemIds || {};

      for (const [sysId, info] of Object.entries(systemIds)) {
        mapping.set(sysId, info.hostname || sysId);
      }
    }
  }

  return mapping;
}

module.exports = { parseLSDB, parseHostnameTable };
