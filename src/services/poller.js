// ---------------------------------------------------------------------------
// Background Topology Poller
// ---------------------------------------------------------------------------
// Periodically collects the IS-IS LSDB from configured devices and updates
// the cached topology. Emits events when the topology changes so WebSocket
// clients can be notified.
// ---------------------------------------------------------------------------

const EventEmitter = require('events');
const deviceStore = require('../store/devices');
const eapi = require('../services/eapi');
const { parseLSDB, parseFlexAlgoPaths, parseFlexAlgoRouters } = require('../services/isisParser');
const { buildGraph } = require('../services/topologyBuilder');
const { parseTunnelFib } = require('../services/tunnelParser');
const { parseNeighborDetail, formatUptime } = require('../services/neighborParser');

class TopologyPoller extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._collecting = false;
    this._topology = null;
    this._lastHash = null;
    this._lastError = null;
    this._collectCount = 0;

    // ── Tunnel Counter Rate Tracking ──
    // Previous poll's raw counters for delta calculation
    // Map<"device:endpoint:type", { txBytes, txPackets, timestamp }>
    this._prevTunnelCounters = new Map();
    // Current computed rates
    // Map<"device:endpoint:type", { bytesPerSec, packetsPerSec, bitsPerSec, ... }>
    this._tunnelRates = new Map();
  }

  /**
   * Start the polling loop.
   */
  start() {
    const config = deviceStore.getPollingConfig();

    if (!config.enabled) {
      console.log('  Polling disabled in config.');
      return;
    }

    const intervalMs = (config.intervalSeconds || 15) * 1000;

    console.log(`  Polling every ${config.intervalSeconds}s`);

    // Run immediately on start, then on interval
    this._collect();
    this._timer = setInterval(() => this._collect(), intervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Get the current cached topology.
   */
  getTopology() {
    return this._topology;
  }

  /**
   * Get poller status.
   */
  getStatus() {
    return {
      polling: !!this._timer,
      collecting: this._collecting,
      collectCount: this._collectCount,
      lastError: this._lastError,
      lastCollectedAt: this._topology?.metadata?.collectedAt || null,
      nodeCount: this._topology?.metadata?.nodeCount || 0,
      edgeCount: this._topology?.metadata?.edgeCount || 0,
    };
  }

  /**
   * Force an immediate collection (e.g., from the UI "Collect" button).
   */
  async forceCollect() {
    return this._collect();
  }

  /**
   * Internal: run a collection cycle.
   */
  async _collect() {
    if (this._collecting) return; // Prevent overlapping collections

    const allDevices = deviceStore.getAllRaw();
    if (allDevices.length === 0) return;

    this._collecting = true;
    this.emit('status:collecting');

    try {
      const allNodes = new Map();
      const allAdjacencies = [];
      const sourceDevices = [];
      const perDeviceTunnels = new Map(); // device name -> tunnel map
      const allNeighborRecords = [];      // adjacency health records
      let flexAlgoPaths = null;           // FlexAlgo path data (from first device)
      let flexAlgoRouters = null;         // FlexAlgo router participation
      const teInterfaceMap = new Map();   // "device:intf" → { delay, teMetric, ... }

      for (const device of allDevices) {
        try {
          // Core commands — must succeed
          const results = await eapi.execute(
            device,
            ['show isis database detail', 'show tunnel fib', 'show isis neighbors detail', 'show interfaces'],
            'json'
          );

          // Parse LSDB
          const lsdbRaw = results[0];
          const { nodes, adjacencies } = parseLSDB(lsdbRaw);

          for (const [sysId, nodeInfo] of nodes) {
            if (!allNodes.has(sysId)) {
              allNodes.set(sysId, nodeInfo);
            }
          }
          allAdjacencies.push(...adjacencies);
          sourceDevices.push(device.name);

          // Parse Tunnel FIB
          const tunnelFibRaw = results[1];
          const tunnelMap = parseTunnelFib(tunnelFibRaw);
          perDeviceTunnels.set(device.name, tunnelMap);

          // Parse Neighbor Health
          const neighborRaw = results[2];
          const nbrRecords = parseNeighborDetail(neighborRaw);

          // Parse interface data from show interfaces (has MTU, counters, etc.)
          const intfRaw = results[3];
          const intfData = intfRaw.interfaces || {};

          // Tag each record with source device and enrich with MTU
          for (const rec of nbrRecords) {
            rec.sourceDevice = device.name;
            const intf = intfData[rec.interfaceName];
            rec.mtu = intf?.mtu || null;
          }
          allNeighborRecords.push(...nbrRecords);

          // TE interface data — separate batch (most devices support this)
          try {
            const teResults = await eapi.execute(
              device,
              ['show traffic-engineering interfaces', 'show mpls tunnel counters'],
              'json'
            );
            if (teResults[0]) {
              const teIntfs = teResults[0].interfaces || [];
              for (const te of teIntfs) {
                if (!te.intf || te.intf.startsWith('Loopback')) continue;
                teInterfaceMap.set(`${device.name}:${te.intf}`, {
                  device: device.name,
                  interface: te.intf,
                  delay: te.delay?.value ?? null,
                  delayUnits: te.delay?.units || 'milliseconds',
                  teMetric: te.metric ?? null,
                  adminGroup: te.adminGroup ?? 0,
                  adminGroupNames: te.adminGroupNames || [],
                  maxResvBw: te.maxResvBw?.value ?? null,
                });
              }
            }

            // Parse tunnel counters and compute rates via delta from previous poll
            if (teResults[1]) {
              this._processTunnelCounters(device.name, teResults[1]);
            }
          } catch {
            // TE not supported on this device — OK
          }

          // FlexAlgo commands — best-effort, separate batch
          // These may not be supported on all EOS versions
          try {
            const faResults = await eapi.execute(
              device,
              ['show isis flex-algo path detail', 'show isis flex-algo router'],
              'json'
            );
            if (faResults[0] && !flexAlgoPaths) {
              flexAlgoPaths = parseFlexAlgoPaths(faResults[0]);
            }
            if (faResults[1] && !flexAlgoRouters) {
              flexAlgoRouters = parseFlexAlgoRouters(faResults[1]);
            }
          } catch {
            // FlexAlgo commands not supported on this device — that's OK
          }

        } catch (deviceErr) {
          // Log but continue — one device failing shouldn't stop the whole poll
          console.error(`  Poll error for ${device.name}: ${deviceErr.message}`);
        }
      }

      if (allNodes.size === 0) {
        this._lastError = 'No data from any device';
        this._collecting = false;
        this.emit('status:updated');
        return;
      }

      // Build the graph
      const topology = buildGraph(allNodes, allAdjacencies);
      topology.metadata.sourceDevices = sourceDevices;

      // Attach tunnel FIB data keyed by device name AND IS-IS hostname.
      // The lookup function matches by IS-IS hostname, but the config might
      // use a different name. Store under both to ensure reliable matching.
      topology.tunnelFib = {};
      for (const [deviceName, tunnelMap] of perDeviceTunnels) {
        const fibObj = {};
        const fibEndpoints = new Set();
        for (const [endpoint, info] of tunnelMap) {
          fibObj[endpoint] = info;
          fibEndpoints.add(endpoint);
        }

        // Store under config device name
        topology.tunnelFib[deviceName] = fibObj;

        // Detect the source node: the node whose loopback is NOT in the
        // tunnel FIB endpoints (a device doesn't build a tunnel to itself).
        for (const [_sysId, nodeInfo] of allNodes) {
          const rid = nodeInfo.routerCaps?.routerId;
          if (!rid || !nodeInfo.hostname) continue;
          const ridEndpoint = `${rid}/32`;

          if (!fibEndpoints.has(ridEndpoint)) {
            // This node is the source device — store FIB under its hostname
            if (nodeInfo.hostname !== deviceName) {
              topology.tunnelFib[nodeInfo.hostname] = fibObj;
            }
            break;
          }
        }
      }

      // ── Adjacency Health Enrichment ──
      // Build a lookup: "sourceDevice|neighborHostname|localInterface" → record
      // Then enrich each edge with health data from both directions.
      topology.adjacencyHealth = allNeighborRecords;

      // Build lookup maps
      const healthByKey = new Map();
      for (const rec of allNeighborRecords) {
        // Key by sourceDevice + neighbor hostname + interface
        const key = `${rec.sourceDevice}|${rec.hostname}|${rec.interfaceName}`;
        healthByKey.set(key, rec);
        // Also key by sourceDevice + neighbor IP
        if (rec.neighborAddress) {
          healthByKey.set(`${rec.sourceDevice}|${rec.neighborAddress}`, rec);
        }
      }

      for (const edge of topology.edges) {
        const d = edge.data;
        const srcLabel = d.sourceLabel;
        const tgtLabel = d.targetLabel;

        // Forward: source → target
        // Look up by source device + target hostname + interface
        let fwdHealth = null;
        // Try matching by neighbor address (most specific)
        if (d.neighborAddr) {
          fwdHealth = healthByKey.get(`${srcLabel}|${d.neighborAddr}`);
        }
        if (!fwdHealth) {
          fwdHealth = healthByKey.get(`${srcLabel}|${tgtLabel}|${d.localAddr ? '' : ''}`);
        }
        // Broader: try just source + target hostname
        if (!fwdHealth) {
          for (const rec of allNeighborRecords) {
            if (rec.sourceDevice === srcLabel && rec.hostname === tgtLabel) {
              // Match by neighbor IP if available
              if (d.neighborAddr && rec.neighborAddress === d.neighborAddr) {
                fwdHealth = rec;
                break;
              }
            }
          }
        }
        if (!fwdHealth) {
          for (const rec of allNeighborRecords) {
            if (rec.sourceDevice === srcLabel && rec.hostname === tgtLabel) {
              fwdHealth = rec;
              break;
            }
          }
        }

        // Reverse: target → source
        let revHealth = null;
        if (d.reverseNeighborAddr) {
          revHealth = healthByKey.get(`${tgtLabel}|${d.reverseNeighborAddr}`);
        }
        if (!revHealth) {
          for (const rec of allNeighborRecords) {
            if (rec.sourceDevice === tgtLabel && rec.hostname === srcLabel) {
              if (d.reverseNeighborAddr && rec.neighborAddress === d.reverseNeighborAddr) {
                revHealth = rec;
                break;
              }
            }
          }
        }
        if (!revHealth) {
          for (const rec of allNeighborRecords) {
            if (rec.sourceDevice === tgtLabel && rec.hostname === srcLabel) {
              revHealth = rec;
              break;
            }
          }
        }

        // Determine overall link health from both sides
        const fwdState = fwdHealth?.state || 'unknown';
        const revState = revHealth?.state || 'unknown';

        let linkHealth = 'unknown';
        if (fwdState === 'up' && revState === 'up') linkHealth = 'healthy';
        else if (fwdState === 'up' || revState === 'up') linkHealth = 'degraded';
        else if (fwdState === 'down' || revState === 'down') linkHealth = 'down';

        // Attach health data to edge
        d.linkHealth = linkHealth;
        d.forwardHealth = fwdHealth ? {
          state: fwdHealth.state,
          localInterface: fwdHealth.interfaceName,
          mtu: fwdHealth.mtu,
          uptime: fwdHealth.uptimeSeconds,
          uptimeFormatted: formatUptime(fwdHealth.uptimeSeconds),
          holdTime: fwdHealth.advertisedHoldTime,
          holdRemaining: fwdHealth.holdRemaining,
          bfdState: fwdHealth.bfdIpv4State,
          srEnabled: fwdHealth.srEnabled,
          grSupported: fwdHealth.grSupported,
        } : null;
        d.reverseHealth = revHealth ? {
          state: revHealth.state,
          localInterface: revHealth.interfaceName,
          mtu: revHealth.mtu,
          uptime: revHealth.uptimeSeconds,
          uptimeFormatted: formatUptime(revHealth.uptimeSeconds),
          holdTime: revHealth.advertisedHoldTime,
          holdRemaining: revHealth.holdRemaining,
          bfdState: revHealth.bfdIpv4State,
          srEnabled: revHealth.srEnabled,
          grSupported: revHealth.grSupported,
        } : null;
      }

      // ── TE Interface Enrichment ──
      // Enrich edges with delay, TE metric, and admin groups from
      // 'show traffic-engineering interfaces'. Uses the interface names
      // already attached via adjacency health.
      if (teInterfaceMap.size > 0) {
        for (const edge of topology.edges) {
          const d = edge.data;

          // Forward direction: source device + source interface
          const fwdIntf = d.forwardHealth?.localInterface;
          if (fwdIntf) {
            const teData = teInterfaceMap.get(`${d.sourceLabel}:${fwdIntf}`);
            if (teData) {
              d.forwardDelay = teData.delay;
              d.forwardTeMetric = teData.teMetric;
              d.forwardAdminGroup = teData.adminGroup;
              d.forwardAdminGroupNames = teData.adminGroupNames;
            }
          }

          // Reverse direction: target device + target interface
          const revIntf = d.reverseHealth?.localInterface;
          if (revIntf) {
            const teData = teInterfaceMap.get(`${d.targetLabel}:${revIntf}`);
            if (teData) {
              d.reverseDelay = teData.delay;
              d.reverseTeMetric = teData.teMetric;
              d.reverseAdminGroup = teData.adminGroup;
              d.reverseAdminGroupNames = teData.adminGroupNames;
            }
          }
        }
      }

      // Check if topology changed (simple hash: node count + edge count + node ids)
      const hash = this._computeHash(topology);
      const changed = hash !== this._lastHash;

      // Attach tunnel counter rates to topology
      topology.tunnelCounterRates = this._serializeTunnelRates();

      this._topology = topology;
      this._lastHash = hash;
      this._lastError = null;
      this._collectCount++;
      this._collecting = false; // Clear BEFORE emit so getStatus() returns collecting: false

      // Emit events
      if (changed) {
        this.emit('topology:changed', topology);
      }
      this.emit('topology:updated', topology);

      // Emit tunnel counter rates separately for sFlow integration
      if (this._tunnelRates.size > 0) {
        this.emit('tunnelCounters:updated', this._serializeTunnelRates());
      }

    } catch (err) {
      this._lastError = err.message;
      console.error('  Poll error:', err.message);
      this._collecting = false;
      this.emit('status:updated');
    }
  }

  /**
   * Simple hash for change detection.
   */
  _computeHash(topology) {
    const nodeIds = topology.nodes.map((n) => n.data.id).sort().join(',');
    const edgeIds = topology.edges.map((e) => e.data.id).sort().join(',');
    // Include metrics so metric changes are detected
    const metrics = topology.edges.map((e) => `${e.data.id}:${e.data.metric}`).join(',');
    return `${topology.metadata.nodeCount}|${topology.metadata.edgeCount}|${nodeIds}|${edgeIds}|${metrics}`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tunnel Counter Rate Calculation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Process raw tunnel counter output from `show mpls tunnel counters`.
   * Computes rates by diffing against the previous poll's counters.
   *
   * Tunnel types we care about:
   *   "IS-IS SR IPv4"  → algo 0 (SPF)
   *   "IS-IS FlexAlgo" → FlexAlgo (128+)
   *   "TI-LFA"         → repair tunnels (skip for LSP table)
   *
   * @param {string} deviceName - Device hostname
   * @param {Object} raw - Raw eAPI JSON from `show mpls tunnel counters`
   */
  _processTunnelCounters(deviceName, raw) {
    const now = Date.now();
    const entries = raw.entries || [];

    for (const entry of entries) {
      const { tunnelType, endpoint, txBytes, txPackets } = entry;

      // Skip TI-LFA repair tunnels and entries without a real endpoint
      if (tunnelType === 'TI-LFA' || !endpoint || endpoint === '::/0') continue;

      // Determine algorithm from tunnel type
      let algoTag;
      if (tunnelType === 'IS-IS SR IPv4') {
        algoTag = 'algo0';
      } else if (tunnelType === 'IS-IS FlexAlgo') {
        algoTag = 'flexalgo'; // We'll resolve the specific algo number later
      } else {
        continue; // Unknown type
      }

      const counterKey = `${deviceName}:${endpoint}:${algoTag}`;

      // Look up previous counters for rate calculation
      const prev = this._prevTunnelCounters.get(counterKey);

      if (prev) {
        const elapsedMs = now - prev.timestamp;
        if (elapsedMs > 0 && txBytes >= prev.txBytes) {
          const deltaBytes = txBytes - prev.txBytes;
          const deltaPackets = txPackets - prev.txPackets;
          const elapsedSec = elapsedMs / 1000;

          this._tunnelRates.set(counterKey, {
            device: deviceName,
            endpoint,
            tunnelType,
            algoTag,
            bytesPerSec: Math.round(deltaBytes / elapsedSec),
            packetsPerSec: Math.round(deltaPackets / elapsedSec),
            bitsPerSec: Math.round((deltaBytes * 8) / elapsedSec),
            txBytes,
            txPackets,
            vias: entry.vias || [],
            counterInUse: entry.counterInUse,
            lastUpdated: new Date(now).toISOString(),
          });
        }
      }

      // Store current counters for next poll's delta
      this._prevTunnelCounters.set(counterKey, {
        txBytes,
        txPackets,
        timestamp: now,
      });
    }
  }

  /**
   * Serialize tunnel rates for API/WebSocket consumption.
   * Resolves endpoints to hostnames using the current topology.
   *
   * @returns {Array} - Serialized tunnel rate records
   */
  _serializeTunnelRates() {
    const rates = [];
    const topo = this._topology;

    // Build a router-ID → hostname map from topology
    const ridToHostname = new Map();
    if (topo) {
      for (const node of topo.nodes) {
        const rid = node.data.routerCaps?.routerId;
        if (rid) {
          ridToHostname.set(rid, node.data.hostname || node.data.label);
          // Also index with /32 suffix since endpoints are "100.0.0.X/32"
          ridToHostname.set(`${rid}/32`, node.data.hostname || node.data.label);
        }
      }
    }

    for (const [key, rate] of this._tunnelRates) {
      const destHostname = ridToHostname.get(rate.endpoint) || rate.endpoint;

      rates.push({
        key,
        device: rate.device,
        endpoint: rate.endpoint,
        destHostname,
        tunnelType: rate.tunnelType,
        algoTag: rate.algoTag,
        bytesPerSec: rate.bytesPerSec,
        packetsPerSec: rate.packetsPerSec,
        bitsPerSec: rate.bitsPerSec,
        txBytes: rate.txBytes,
        txPackets: rate.txPackets,
        vias: rate.vias,
        counterInUse: rate.counterInUse,
        lastUpdated: rate.lastUpdated,
      });
    }

    // Sort by bitsPerSec descending
    rates.sort((a, b) => b.bitsPerSec - a.bitsPerSec);
    return rates;
  }

  /**
   * Get current tunnel counter rates (public API).
   */
  getTunnelRates() {
    return this._serializeTunnelRates();
  }
}

// Singleton
module.exports = new TopologyPoller();
