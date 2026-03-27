// ---------------------------------------------------------------------------
// FlexAlgo Service — Summary Builder & Collection Helper
// ---------------------------------------------------------------------------
// Provides FlexAlgo summary building from LSDB topology data.
// Parsing of eAPI output is handled by isisParser.js (parseFlexAlgoPaths,
// parseFlexAlgoRouters). This module focuses on the higher-level summary.
// ---------------------------------------------------------------------------

/**
 * Build a FlexAlgo summary from LSDB data.
 * Extracts algorithm definitions and per-node participation from
 * the topology data already collected.
 *
 * @param {Object} topology - Current ATLAS topology (nodes + edges).
 * @returns {Object} FlexAlgo summary.
 */
function buildFlexAlgoSummary(topology) {
  if (!topology?.nodes) return { algorithms: [], nodeParticipation: {} };

  const algoMap = new Map(); // algo number → { definition, nodes[] }
  const nodeParticipation = {}; // hostname → [algo numbers]

  for (const node of topology.nodes) {
    const d = node.data;
    const caps = d.routerCaps;
    if (!caps) continue;

    const hostname = d.hostname;
    const nodeAlgos = [];

    // SR Algorithms this node participates in
    for (const algo of (caps.srAlgorithms || [])) {
      const num = algo.number;
      nodeAlgos.push(num);

      if (!algoMap.has(num)) {
        algoMap.set(num, {
          number: num,
          name: algo.name,
          definition: null,
          participants: [],
          advertiser: null,
        });
      }
      algoMap.get(num).participants.push(hostname);
    }

    // FlexAlgo Definitions this node advertises
    for (const fad of (caps.flexAlgoDefinitions || [])) {
      const num = fad.algorithm;
      if (!algoMap.has(num)) {
        algoMap.set(num, {
          number: num,
          name: fad.metricType || `Algo ${num}`,
          definition: null,
          participants: [],
          advertiser: null,
        });
      }
      const entry = algoMap.get(num);
      entry.definition = fad;
      entry.advertiser = hostname;
    }

    // FA Prefix SIDs
    nodeParticipation[hostname] = {
      algorithms: nodeAlgos,
      faSids: (d.srPrefixSids || []).filter(s => s.algorithm > 0),
    };
  }

  // Sort algorithms, put algo 0 first
  const algorithms = Array.from(algoMap.values()).sort((a, b) => a.number - b.number);

  return { algorithms, nodeParticipation };
}

module.exports = {
  buildFlexAlgoSummary,
};
