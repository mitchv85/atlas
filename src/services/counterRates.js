// ---------------------------------------------------------------------------
// Counter Rate Engine — Real-Time Bandwidth Computation
// ---------------------------------------------------------------------------
// Receives raw interface counter samples from gNMI (cumulative octets),
// computes delta rates (bits per second), and emits rate events for the
// topology bandwidth overlay.
//
// Architecture:
//   gNMI interface:counters (every 10s)
//     → counterRates.processSample()
//       → computes delta from previous sample
//       → emits 'rates:updated' with per-interface bps
//       → stores current rates for topology overlay queries
// ---------------------------------------------------------------------------

const EventEmitter = require('events');

class CounterRateEngine extends EventEmitter {
  constructor() {
    super();
    // Previous sample: Map<"device:interface"> → { inOctets, outOctets, timestamp }
    this._prev = new Map();
    // Current rates: Map<"device:interface"> → { inBps, outBps, inPps, outPps, ... }
    this._rates = new Map();
    // Per-device aggregate: Map<device> → { totalInBps, totalOutBps, interfaceCount }
    this._deviceAgg = new Map();
    // Batch timer for broadcasting
    this._batchTimer = null;
    this._batchInterval = 5000; // Broadcast aggregated rates every 5s
    this._dirty = false;
  }

  /**
   * Start the batch broadcast timer.
   */
  start() {
    this._batchTimer = setInterval(() => {
      if (this._dirty) {
        this._dirty = false;
        this._emitSnapshot();
      }
    }, this._batchInterval);
  }

  /**
   * Stop the engine.
   */
  stop() {
    if (this._batchTimer) {
      clearInterval(this._batchTimer);
      this._batchTimer = null;
    }
  }

  /**
   * Process a raw counter sample from gNMI.
   * @param {Object} sample - { device, interface, counters: { inOctets, outOctets, ... }, timestamp }
   */
  processSample(sample) {
    const key = `${sample.device}:${sample.interface}`;
    const now = sample.timestamp ? parseInt(sample.timestamp, 10) / 1e9 : Date.now() / 1000;
    const counters = sample.counters;

    const inOctets = parseInt(counters.inOctets, 10) || 0;
    const outOctets = parseInt(counters.outOctets, 10) || 0;
    const inPkts = parseInt(counters.inPkts, 10) || 0;
    const outPkts = parseInt(counters.outPkts, 10) || 0;
    const inErrors = parseInt(counters.inErrors, 10) || 0;
    const outErrors = parseInt(counters.outErrors, 10) || 0;
    const inDiscards = parseInt(counters.inDiscards, 10) || 0;
    const outDiscards = parseInt(counters.outDiscards, 10) || 0;

    const prev = this._prev.get(key);

    if (prev) {
      const dt = now - prev.timestamp;
      if (dt > 0 && dt < 120) { // Ignore stale samples (>2min gap)
        const rate = {
          device: sample.device,
          interface: sample.interface,
          inBps: Math.round(((inOctets - prev.inOctets) * 8) / dt),
          outBps: Math.round(((outOctets - prev.outOctets) * 8) / dt),
          inPps: Math.round((inPkts - prev.inPkts) / dt),
          outPps: Math.round((outPkts - prev.outPkts) / dt),
          inErrors: inErrors - prev.inErrors,
          outErrors: outErrors - prev.outErrors,
          inDiscards: inDiscards - prev.inDiscards,
          outDiscards: outDiscards - prev.outDiscards,
          timestamp: now,
        };

        // Ignore negative rates (counter wrap or reset)
        if (rate.inBps >= 0 && rate.outBps >= 0) {
          this._rates.set(key, rate);
          this._dirty = true;
        }
      }
    }

    // Store current sample as previous for next delta
    this._prev.set(key, { inOctets, outOctets, inPkts, outPkts, inErrors, outErrors, inDiscards, outDiscards, timestamp: now });
  }

  /**
   * Get current rates for all interfaces.
   * Returns Map<"device:interface"> → rate object
   */
  getAllRates() {
    return Object.fromEntries(this._rates);
  }

  /**
   * Get rates for a specific device.
   */
  getDeviceRates(deviceName) {
    const result = {};
    for (const [key, rate] of this._rates) {
      if (rate.device === deviceName) {
        result[rate.interface] = rate;
      }
    }
    return result;
  }

  /**
   * Get link rates keyed by topology edge format ("device:interface").
   * Used by the topology overlay to color edges.
   */
  getLinkRates() {
    const links = {};
    for (const [key, rate] of this._rates) {
      links[key] = {
        inBps: rate.inBps,
        outBps: rate.outBps,
        maxBps: Math.max(rate.inBps, rate.outBps),
        utilization: null, // Would need interface speed to compute
        hasErrors: (rate.inErrors + rate.outErrors) > 0,
        hasDiscards: (rate.inDiscards + rate.outDiscards) > 0,
      };
    }
    return links;
  }

  /**
   * Get per-device bandwidth summary.
   */
  getDeviceSummaries() {
    const summaries = {};
    for (const [key, rate] of this._rates) {
      if (!summaries[rate.device]) {
        summaries[rate.device] = {
          totalInBps: 0, totalOutBps: 0,
          totalInPps: 0, totalOutPps: 0,
          interfaceCount: 0, errorCount: 0, discardCount: 0,
        };
      }
      const s = summaries[rate.device];
      s.totalInBps += rate.inBps;
      s.totalOutBps += rate.outBps;
      s.totalInPps += rate.inPps;
      s.totalOutPps += rate.outPps;
      s.interfaceCount++;
      s.errorCount += rate.inErrors + rate.outErrors;
      s.discardCount += rate.inDiscards + rate.outDiscards;
    }
    return summaries;
  }

  /**
   * Emit a snapshot of all current rates.
   */
  _emitSnapshot() {
    this.emit('rates:updated', {
      links: this.getLinkRates(),
      summaries: this.getDeviceSummaries(),
      timestamp: Date.now(),
    });
  }
}

module.exports = CounterRateEngine;
