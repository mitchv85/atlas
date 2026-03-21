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
const { parseLSDB } = require('../services/isisParser');
const { buildGraph } = require('../services/topologyBuilder');
const { parseTunnelFib } = require('../services/tunnelParser');

class TopologyPoller extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._collecting = false;
    this._topology = null;
    this._lastHash = null;
    this._lastError = null;
    this._collectCount = 0;
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

    try {
      const allNodes = new Map();
      const allAdjacencies = [];
      const sourceDevices = [];
      const perDeviceTunnels = new Map(); // device name -> tunnel map

      for (const device of allDevices) {
        try {
          const results = await eapi.execute(
            device,
            ['show isis database detail', 'show tunnel fib'],
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

        } catch (deviceErr) {
          // Log but continue — one device failing shouldn't stop the whole poll
          console.error(`  Poll error for ${device.name}: ${deviceErr.message}`);
        }
      }

      if (allNodes.size === 0) {
        this._lastError = 'No data from any device';
        this._collecting = false;
        return;
      }

      // Build the graph
      const topology = buildGraph(allNodes, allAdjacencies);
      topology.metadata.sourceDevices = sourceDevices;

      // Attach tunnel FIB data keyed by device name
      topology.tunnelFib = {};
      for (const [deviceName, tunnelMap] of perDeviceTunnels) {
        topology.tunnelFib[deviceName] = {};
        for (const [endpoint, info] of tunnelMap) {
          topology.tunnelFib[deviceName][endpoint] = info;
        }
      }

      // Check if topology changed (simple hash: node count + edge count + node ids)
      const hash = this._computeHash(topology);
      const changed = hash !== this._lastHash;

      this._topology = topology;
      this._lastHash = hash;
      this._lastError = null;
      this._collectCount++;

      // Emit events
      if (changed) {
        this.emit('topology:changed', topology);
      }
      this.emit('topology:updated', topology);

    } catch (err) {
      this._lastError = err.message;
      console.error('  Poll error:', err.message);
    } finally {
      this._collecting = false;
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
}

// Singleton
module.exports = new TopologyPoller();
