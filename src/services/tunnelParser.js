// ---------------------------------------------------------------------------
// Tunnel FIB Parser
// ---------------------------------------------------------------------------
// Parses Arista EOS eAPI output from `show tunnel fib` (JSON format).
//
// Extracts per-endpoint tunnel information including:
//   - Primary path label stacks and next-hops
//   - TI-LFA backup path label stacks and next-hops
//
// Structure (eAPI):
//   result[0].categories
//     ."IS-IS SR".entries.<idx>
//       .endpoint            -> "100.0.0.5/32"
//       .vias[]              -> primary paths (may have resolvingTunnelInfo)
//       .backupVias[]        -> direct backup paths
//     ."TI-LFA".entries.<idx>
//       .vias[]              -> TI-LFA primary vias
//       .backupVias[]        -> TI-LFA backup vias with full label stacks
// ---------------------------------------------------------------------------

/**
 * Parse `show tunnel fib` output into a normalized per-endpoint map.
 *
 * @param {Object} raw - Raw eAPI JSON result for `show tunnel fib`
 * @returns {Map<string, TunnelInfo>} - Map of endpoint -> tunnel info
 *
 * TunnelInfo: {
 *   endpoint: string,
 *   primaryPaths: [{ nexthop, interface, labelStack }],
 *   backupPaths:  [{ nexthop, interface, labelStack }],
 * }
 */
function parseTunnelFib(raw) {
  const tunnels = new Map();

  const categories = raw.categories || {};

  // ── Parse IS-IS SR tunnels ──
  const srEntries = categories['IS-IS SR']?.entries || {};

  for (const [_idx, entry] of Object.entries(srEntries)) {
    const endpoint = entry.endpoint || '';
    if (!endpoint || endpoint === '::/0') continue;

    if (!tunnels.has(endpoint)) {
      tunnels.set(endpoint, {
        endpoint,
        primaryPaths: [],
        backupPaths: [],
      });
    }

    const tunnel = tunnels.get(endpoint);

    for (const via of (entry.vias || [])) {
      const rti = via.resolvingTunnelInfo;
      const outerNexthop = via.nexthop || '';
      const outerLabels = (via.mplsEncap?.labelStack || []).map(String);
      const outerInterface = via.interface || '';

      if (rti) {
        // This tunnel resolves through a TI-LFA tunnel.
        //
        // Two patterns exist depending on EOS version / config:
        //
        // Pattern A (nexthop = 0.0.0.0, DynamicTunnel interface):
        //   Outer labelStack is just a service label placeholder.
        //   Real primary labels + nexthop are in resolvingTunnelInfo.vias.
        //
        // Pattern B (nexthop = real IP):
        //   Outer labelStack is the FULL combined forwarding stack.
        //   resolvingTunnelInfo.vias has only the transport tunnel label.
        //
        // Detection: nexthop === '0.0.0.0' → Pattern A, else → Pattern B.

        if (outerNexthop === '0.0.0.0') {
          // Pattern A: use resolvingTunnelInfo.vias for primary
          for (const pv of (rti.vias || [])) {
            tunnel.primaryPaths.push({
              nexthop: pv.nexthop || '',
              interface: pv.interface || '',
              labelStack: (pv.mplsEncap?.labelStack || []).map(String),
            });
          }

          // Pattern A: RTI backupVias contain the FULL backup forwarding stack
          for (const bv of (rti.backupVias || [])) {
            tunnel.backupPaths.push({
              nexthop: bv.nexthop || '',
              interface: bv.interface || '',
              labelStack: (bv.mplsEncap?.labelStack || []).map(String),
            });
          }
        } else {
          // Pattern B: use outer via's full label stack for primary
          tunnel.primaryPaths.push({
            nexthop: outerNexthop,
            interface: outerInterface,
            labelStack: outerLabels,
          });

          // Pattern B: RTI backupVias contain ONLY the backup transport labels.
          // The outer labelStack = transport + service labels.
          // RTI primary vias = just transport labels.
          // Service labels = outer[transport_length:] (the tail beyond transport).
          // Real backup = RTI_backup_transport + service_labels.
          const primaryTransport = (rti.vias || []).length > 0
            ? (rti.vias[0].mplsEncap?.labelStack || []).map(String)
            : [];
          const transportLength = primaryTransport.length;
          const serviceLabels = outerLabels.slice(transportLength);

          for (const bv of (rti.backupVias || [])) {
            const backupTransport = (bv.mplsEncap?.labelStack || []).map(String);
            tunnel.backupPaths.push({
              nexthop: bv.nexthop || '',
              interface: bv.interface || '',
              labelStack: [...backupTransport, ...serviceLabels],
            });
          }
        }
      } else {
        // Direct tunnel (no TI-LFA resolving) — e.g., ECMP paths
        if (outerNexthop && outerNexthop !== '0.0.0.0') {
          tunnel.primaryPaths.push({
            nexthop: outerNexthop,
            interface: outerInterface,
            labelStack: outerLabels,
          });
        }
      }
    }

    // Direct backupVias on the SR entry itself
    for (const bv of (entry.backupVias || [])) {
      if (bv.nexthop && bv.mplsEncap?.labelStack) {
        tunnel.backupPaths.push({
          nexthop: bv.nexthop,
          interface: bv.interface || '',
          labelStack: (bv.mplsEncap.labelStack || []).map(String),
        });
      }
    }
  }

  // ── Parse TI-LFA tunnels (supplement backup info) ──
  const tilfaEntries = categories['TI-LFA']?.entries || {};

  for (const [_idx, entry] of Object.entries(tilfaEntries)) {
    // TI-LFA entries have endpoint ::/0 — they are generic repair tunnels.
    // The backup label stacks here are already captured via the
    // resolvingTunnelInfo on the IS-IS SR entries above.
    // We skip these to avoid duplicates.
  }

  return tunnels;
}

/**
 * Build a device-keyed tunnel FIB store from multiple devices.
 *
 * @param {Map<string, Map<string, TunnelInfo>>} perDeviceTunnels
 *   Key: device name or ID
 *   Value: tunnel map from parseTunnelFib
 * @returns {Object} - Serializable object for topology metadata
 */
function buildTunnelStore(perDeviceTunnels) {
  const store = {};

  for (const [deviceKey, tunnelMap] of perDeviceTunnels) {
    store[deviceKey] = {};
    for (const [endpoint, info] of tunnelMap) {
      store[deviceKey][endpoint] = info;
    }
  }

  return store;
}

module.exports = { parseTunnelFib, buildTunnelStore };
