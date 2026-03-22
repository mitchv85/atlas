// ---------------------------------------------------------------------------
// IS-IS Neighbor Detail Parser
// ---------------------------------------------------------------------------
// Parses Arista EOS eAPI output from `show isis neighbors detail` (JSON).
//
// Extracts per-adjacency operational data:
//   - State (up/down/init)
//   - Uptime (from stateChanged epoch)
//   - Hold timer (advertised + remaining)
//   - Interface name
//   - BFD state
//   - SR enabled + Adj-SID label
//   - Graceful Restart support
//
// Structure (eAPI):
//   result[0].vrfs.<vrf>.isisInstances.<inst>.neighbors.<systemId>
//     .adjacencies[]
//       .hostname, .state, .interfaceName, .lastHelloTime, .holdTimerExpiry
//       .details.advertisedHoldTime, .details.stateChanged, .details.ip4Address
//       .details.bfdIpv4State, .details.srEnabled, .details.srInfoDetail
//       .details.grSupported
// ---------------------------------------------------------------------------

/**
 * Parse `show isis neighbors detail` output.
 *
 * @param {Object} raw - Raw eAPI JSON result
 * @returns {Map<string, AdjacencyInfo[]>} - Map of local hostname → adjacency list
 */
function parseNeighborDetail(raw) {
  const result = [];

  const vrfs = raw.vrfs || {};

  for (const [vrfName, vrfData] of Object.entries(vrfs)) {
    const instances = vrfData.isisInstances || {};

    for (const [instanceName, instanceData] of Object.entries(instances)) {
      const neighbors = instanceData.neighbors || {};

      for (const [systemId, nbrData] of Object.entries(neighbors)) {
        const adjacencies = nbrData.adjacencies || [];

        for (const adj of adjacencies) {
          const details = adj.details || {};
          const now = Date.now() / 1000;

          // Compute uptime from stateChanged epoch
          const stateChangedEpoch = details.stateChanged || 0;
          const uptimeSeconds = stateChangedEpoch > 0 ? Math.max(0, Math.round(now - stateChangedEpoch)) : 0;

          // Compute remaining hold time
          const holdExpiry = adj.holdTimerExpiry || 0;
          const holdRemaining = holdExpiry > 0 ? Math.max(0, Math.round(holdExpiry - now)) : 0;

          result.push({
            systemId,
            hostname: adj.hostname || '',
            routerId: adj.routerIdV4 || '',
            interfaceName: adj.interfaceName || '',
            state: adj.state || 'unknown',
            level: adj.level || '',
            snpa: adj.snpa || '',
            circuitId: adj.circuitId || '',

            // Timers
            advertisedHoldTime: details.advertisedHoldTime || 0,
            holdRemaining,
            uptimeSeconds,
            lastHelloTime: adj.lastHelloTime || 0,

            // Addresses
            neighborAddress: details.ip4Address || '',
            addressFamily: details.interfaceAddressFamily || '',
            areaIds: details.areaIds || [],

            // BFD
            bfdIpv4State: details.bfdIpv4State || 'unknown',
            bfdIpv6State: details.bfdIpv6State || 'unknown',

            // SR
            srEnabled: details.srEnabled || false,
            srAdjSidLabel: details.srInfoDetail?.srLabelV4 || null,
            srSrgbBase: details.srInfoDetail?.srGbBase || null,
            srSrgbRange: details.srInfoDetail?.srGbRange || null,

            // GR
            grSupported: details.grSupported || '',

            // Metadata
            vrf: vrfName,
            instance: instanceName,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Format uptime seconds into human-readable string.
 * @param {number} seconds
 * @returns {string} e.g., "2d 5h 13m" or "45m 12s"
 */
function formatUptime(seconds) {
  if (seconds <= 0) return 'unknown';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

module.exports = { parseNeighborDetail, formatUptime };
