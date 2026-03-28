// ---------------------------------------------------------------------------
// sFlow Store — In-Memory sFlow State
// ---------------------------------------------------------------------------
// Central state holder for sFlow data: collector stats, aggregated flows,
// and sFlow configuration. Follows the same EventEmitter pattern as bgp.js.
//
// Data flow:
//   sflowCollector → sflowAggregator → sflowStore → REST API / WebSocket
// ---------------------------------------------------------------------------

const EventEmitter = require('events');

class SflowStore extends EventEmitter {
  constructor() {
    super();

    // ── State ──
    this._collectorStats = null;
    this._aggregatorStats = null;
    this._lastSnapshot = null;
    this._enabled = false;
    this._config = {
      port: 6343,
      enabled: false,
    };
  }

  /**
   * Update sFlow configuration.
   */
  setConfig(config) {
    this._config = { ...this._config, ...config };
    this.emit('config:changed', this._config);
  }

  /**
   * Get sFlow configuration.
   */
  getConfig() {
    return { ...this._config };
  }

  /**
   * Update collector statistics.
   */
  updateCollectorStats(stats) {
    this._collectorStats = stats;
  }

  /**
   * Update aggregator statistics.
   */
  updateAggregatorStats(stats) {
    this._aggregatorStats = stats;
  }

  /**
   * Update the flow snapshot (from aggregator).
   */
  updateSnapshot(snapshot) {
    this._lastSnapshot = snapshot;
    this.emit('flows:updated', snapshot);
  }

  /**
   * Get the full sFlow status.
   */
  getStatus() {
    return {
      enabled: this._config.enabled,
      config: this._config,
      collector: this._collectorStats || { running: false },
      aggregator: this._aggregatorStats || {},
      hasFlowData: !!(this._lastSnapshot && this._lastSnapshot.lspFlows.length > 0),
    };
  }

  /**
   * Get the current flow snapshot.
   */
  getSnapshot() {
    return this._lastSnapshot || { timestamp: null, windowMs: 0, lspFlows: [], edgeFlows: [] };
  }
}

// Singleton
module.exports = new SflowStore();
