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
      // Evict stale rates — if no new complete sample in 30s,
      // the traffic has likely stopped. Zero out stale entries.
      const now = Date.now() / 1000;
      const STALE_THRESHOLD = 30; // seconds (3 sample intervals)
      for (const [key, rate] of this._rates) {
        if (now - rate.timestamp > STALE_THRESHOLD) {
          if (rate.inBps > 0 || rate.outBps > 0) {
            // Zero it out rather than removing — preserves the key
            // so the next sample can compute a fresh delta
            rate.inBps = 0;
            rate.outBps = 0;
            rate.inPps = 0;
            rate.outPps = 0;
            rate.inErrors = 0;
            rate.outErrors = 0;
            rate.inDiscards = 0;
            rate.outDiscards = 0;
            this._dirty = true;
          }
        }
      }

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
    // Use wall-clock time for reliable dt computation — gNMI device
    // timestamps can have precision issues with nanosecond values
    // exceeding JavaScript's MAX_SAFE_INTEGER
    const now = Date.now() / 1000;
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
      // Minimum 5s between samples to avoid inflated rates from
      // closely-spaced initial sync data. Max 120s to ignore stale gaps.
      if (dt >= 5 && dt < 120) {
        const deltaIn = inOctets - prev.inOctets;
        const deltaOut = outOctets - prev.outOctets;

        // Skip if counter wrapped/reset (negative delta) or if counters
        // didn't change at all (avoid showing 0 as a "rate")
        if (deltaIn >= 0 && deltaOut >= 0) {
          const rate = {
            device: sample.device,
            interface: sample.interface,
            inBps: Math.round((deltaIn * 8) / dt),
            outBps: Math.round((deltaOut * 8) / dt),
            inPps: Math.round(Math.max(0, inPkts - prev.inPkts) / dt),
            outPps: Math.round(Math.max(0, outPkts - prev.outPkts) / dt),
            inErrors: Math.max(0, inErrors - prev.inErrors),
            outErrors: Math.max(0, outErrors - prev.outErrors),
            inDiscards: Math.max(0, inDiscards - prev.inDiscards),
            outDiscards: Math.max(0, outDiscards - prev.outDiscards),
            timestamp: now,
          };

          // One-time diagnostic
          if (!this._diagDone) {
            this._diagDone = true;
            console.log(`  [Bandwidth] Rate computed: ${key} dt=${dt.toFixed(1)}s inBps=${rate.inBps} outBps=${rate.outBps}`);
          }

          // Log suspiciously high rates for debugging
          if (!this._highRateLogged && (rate.inBps > 1_000_000_000 || rate.outBps > 1_000_000_000)) {
            this._highRateLogged = true;
            console.log(`  [Bandwidth] HIGH RATE DETECTED: ${key}`);
            console.log(`    prev: inOctets=${prev.inOctets} outOctets=${prev.outOctets} ts=${prev.timestamp.toFixed(3)}`);
            console.log(`    curr: inOctets=${inOctets} outOctets=${outOctets} ts=${now.toFixed(3)}`);
            console.log(`    delta: in=${inOctets - prev.inOctets} out=${outOctets - prev.outOctets} dt=${dt.toFixed(3)}s`);
            console.log(`    rate:  inBps=${rate.inBps} outBps=${rate.outBps}`);
          }

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
