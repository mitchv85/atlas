// ---------------------------------------------------------------------------
// gNMI Subscriber — Real-Time State Streaming
// ---------------------------------------------------------------------------
// Connects to Arista EOS devices via gRPC/gNMI and subscribes to
// ON_CHANGE and SAMPLE streams. Emits events that the poller and
// WebSocket system can react to.
//
// Architecture:
//   - ON_CHANGE: IS-IS adjacencies, interface oper-status, SPF counters
//     → Instant topology awareness, triggers targeted eAPI refresh
//   - SAMPLE: Interface counters (octets, errors, discards)
//     → Live bandwidth/error overlays
//
// This module does NOT replace the eAPI poller — it augments it.
// The LSDB, tunnel FIB, and FlexAlgo paths still come from eAPI because
// OpenConfig doesn't expose those on EOS. But gNMI tells us WHEN to poll.
// ---------------------------------------------------------------------------

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const EventEmitter = require('events');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'gnmi.proto');

// Load gNMI proto
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const gnmiProto = grpc.loadPackageDefinition(packageDef).gnmi;

// ---------------------------------------------------------------------------
// Path Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a string path like "/a/b[key=val]/c" into a gNMI Path message.
 */
function parsePath(pathStr, origin = '') {
  const elems = [];
  // Strip leading slash, split on /
  const parts = pathStr.replace(/^\//, '').split('/').filter(Boolean);

  for (const part of parts) {
    const match = part.match(/^([^[]+)(\[.+\])?$/);
    if (!match) continue;

    const name = match[1];
    const keyStr = match[2] || '';
    const keys = {};

    // Parse [key=value][key2=value2]
    const keyMatches = keyStr.matchAll(/\[([^=]+)=([^\]]+)\]/g);
    for (const km of keyMatches) {
      keys[km[1]] = km[2];
    }

    elems.push({ name, key: Object.keys(keys).length > 0 ? keys : undefined });
  }

  return { origin, elem: elems };
}

/**
 * Convert a gNMI Path message back to a human-readable string.
 */
function pathToString(p) {
  if (!p || !p.elem) return '';
  return '/' + p.elem.map(e => {
    let s = e.name;
    if (e.key) {
      for (const [k, v] of Object.entries(e.key)) {
        s += `[${k}=${v}]`;
      }
    }
    return s;
  }).join('/');
}

/**
 * Extract the typed value from a gNMI Update.
 */
function extractValue(typedValue) {
  if (!typedValue) return null;
  if (typedValue.json_ietf_val) {
    try { return JSON.parse(Buffer.from(typedValue.json_ietf_val).toString()); } catch { return null; }
  }
  if (typedValue.json_val) {
    try { return JSON.parse(Buffer.from(typedValue.json_val).toString()); } catch { return null; }
  }
  if (typedValue.string_val != null) return typedValue.string_val;
  if (typedValue.int_val != null) return parseInt(typedValue.int_val, 10);
  if (typedValue.uint_val != null) return parseInt(typedValue.uint_val, 10);
  if (typedValue.bool_val != null) return typedValue.bool_val;
  if (typedValue.double_val != null) return typedValue.double_val;
  if (typedValue.float_val != null) return typedValue.float_val;
  if (typedValue.ascii_val != null) return typedValue.ascii_val;
  return null;
}

// ---------------------------------------------------------------------------
// Subscription Definitions
// ---------------------------------------------------------------------------

/** ON_CHANGE subscriptions — instant event awareness */
const ON_CHANGE_PATHS = [
  // IS-IS adjacency state changes (link up/down)
  '/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=100]/isis/interfaces/interface/levels/level/adjacencies',
  // IS-IS system counters (SPF run count triggers LSDB refresh)
  '/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=100]/isis/levels/level[level-number=2]/system-level-counters/state',
  // Interface operational status
  '/interfaces/interface/state/oper-status',
];

/** SAMPLE subscriptions — periodic counter polling */
const SAMPLE_PATHS = [
  // Interface counters (bandwidth, errors)
  '/interfaces/interface/state/counters',
];

/** Default sample interval in nanoseconds (10 seconds) */
const DEFAULT_SAMPLE_INTERVAL_NS = '10000000000';

// ---------------------------------------------------------------------------
// GnmiSubscriber Class
// ---------------------------------------------------------------------------

class GnmiSubscriber extends EventEmitter {
  constructor() {
    super();
    this._connections = new Map(); // deviceName → { client, stream, status }
    this._config = {
      enabled: false,
      port: 6030,
      sampleIntervalNs: DEFAULT_SAMPLE_INTERVAL_NS,
      isisInstance: '100',          // IS-IS instance name on EOS
    };
    this._reconnectTimers = new Map();
    this._lastSpfRuns = new Map();  // deviceName → last known SPF run count
  }

  /**
   * Update configuration from atlas.config.json gnmi section.
   */
  configure(gnmiConfig) {
    if (!gnmiConfig) return;
    this._config.enabled = gnmiConfig.enabled === true;
    this._config.port = gnmiConfig.port || 6030;
    this._config.sampleIntervalNs = String(gnmiConfig.sampleIntervalSeconds
      ? gnmiConfig.sampleIntervalSeconds * 1_000_000_000
      : DEFAULT_SAMPLE_INTERVAL_NS);
    this._config.isisInstance = gnmiConfig.isisInstance || '100';

    // Update paths if IS-IS instance name differs
    if (this._config.isisInstance !== '100') {
      // Rebuild paths with correct instance name
      const inst = this._config.isisInstance;
      ON_CHANGE_PATHS[0] = `/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=${inst}]/isis/interfaces/interface/levels/level/adjacencies`;
      ON_CHANGE_PATHS[1] = `/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=${inst}]/isis/levels/level[level-number=2]/system-level-counters/state`;
    }
  }

  /**
   * Start streaming from all configured devices.
   */
  start(devices) {
    if (!this._config.enabled) {
      console.log('  [gNMI] Streaming disabled in config');
      return;
    }

    console.log(`  [gNMI] Starting subscriptions to ${devices.length} device(s) on port ${this._config.port}`);

    for (const device of devices) {
      this._connectDevice(device);
    }
  }

  /**
   * Stop all streams and close connections.
   */
  stop() {
    for (const [name, conn] of this._connections) {
      this._disconnect(name);
    }
    for (const [name, timer] of this._reconnectTimers) {
      clearTimeout(timer);
    }
    this._reconnectTimers.clear();
    console.log('  [gNMI] All subscriptions stopped');
  }

  /**
   * Get status of all device connections.
   */
  getStatus() {
    const status = {};
    for (const [name, conn] of this._connections) {
      status[name] = {
        status: conn.status,
        connectedAt: conn.connectedAt,
        lastUpdate: conn.lastUpdate,
        updateCount: conn.updateCount,
        errorCount: conn.errorCount,
        streams: `${conn.syncCount || 0}/${conn.totalStreams || 0} synced`,
      };
    }
    return {
      enabled: this._config.enabled,
      port: this._config.port,
      connections: status,
    };
  }

  // ── Private Methods ────────────────────────────────────────────────

  /**
   * Connect to a single device and establish subscriptions.
   * EOS does not support aggregated subscriptions (multiple paths in one
   * stream), so we create a separate gRPC stream per subscription path.
   */
  _connectDevice(device) {
    const name = device.name;
    const target = `${device.host}:${this._config.port}`;

    // Skip if already connected
    if (this._connections.has(name) && this._connections.get(name).status === 'connected') {
      return;
    }

    // Clean up any existing dead connection
    if (this._connections.has(name)) {
      this._disconnect(name);
    }

    console.log(`  [gNMI] Connecting to ${name} (${target})...`);

    // Create gRPC client with insecure credentials (lab environment)
    const client = new gnmiProto.gNMI(target, grpc.credentials.createInsecure(), {
      'grpc.max_receive_message_length': 64 * 1024 * 1024, // 64MB
      'grpc.keepalive_time_ms': 30000,
      'grpc.keepalive_timeout_ms': 10000,
    });

    const conn = {
      client,
      streams: [],           // One stream per subscription path
      status: 'connecting',
      connectedAt: null,
      lastUpdate: null,
      updateCount: 0,
      errorCount: 0,
      syncCount: 0,          // How many streams have sent sync_response
      totalStreams: 0,        // Total streams expected
    };
    this._connections.set(name, conn);

    // Build per-path subscription definitions
    const pathDefs = [];
    for (const p of ON_CHANGE_PATHS) {
      pathDefs.push({ path: p, mode: 'ON_CHANGE', sample_interval: null });
    }
    for (const p of SAMPLE_PATHS) {
      pathDefs.push({ path: p, mode: 'SAMPLE', sample_interval: this._config.sampleIntervalNs });
    }

    conn.totalStreams = pathDefs.length;

    // Create one stream per path
    for (const def of pathDefs) {
      const metadata = new grpc.Metadata();
      metadata.set('username', device.username || 'admin');
      metadata.set('password', device.password || 'admin');

      const stream = client.Subscribe(metadata);
      conn.streams.push(stream);

      // Build single-path subscription
      const sub = {
        path: parsePath(def.path),
        mode: def.mode,
      };
      if (def.sample_interval) {
        sub.sample_interval = def.sample_interval;
      }

      // Send subscription request with ONE path
      stream.write({
        subscribe: {
          subscription: [sub],
          mode: 'STREAM',
          encoding: 'JSON_IETF',
          updates_only: false,
        },
      });

      // Handle incoming updates
      stream.on('data', (response) => {
        try {
          this._handleResponse(name, response);
        } catch (err) {
          console.error(`  [gNMI] ${name} handler error:`, err.message);
          conn.errorCount++;
        }
      });

      stream.on('error', (err) => {
        const code = err.code || '';
        const msg = err.details || err.message || '';
        if (code !== grpc.status.CANCELLED) {
          console.error(`  [gNMI] ${name} stream error (code=${code}): ${msg}`);
        }
        conn.errorCount++;
      });

      stream.on('end', () => {
        conn.activeStreams = (conn.activeStreams || conn.totalStreams) - 1;
        if (conn.activeStreams <= 0) {
          console.log(`  [gNMI] ${name} all streams ended`);
          conn.status = 'disconnected';
          this._scheduleReconnect(device);
        }
      });
    }
  }

  /**
   * Schedule a reconnection attempt after a delay.
   */
  _scheduleReconnect(device) {
    const name = device.name;
    if (this._reconnectTimers.has(name)) return; // Already scheduled

    const delay = 15000; // 15 seconds
    this._reconnectTimers.set(name, setTimeout(() => {
      this._reconnectTimers.delete(name);
      console.log(`  [gNMI] Reconnecting to ${name}...`);
      this._connectDevice(device);
    }, delay));
  }

  /**
   * Disconnect a single device.
   */
  _disconnect(name) {
    const conn = this._connections.get(name);
    if (!conn) return;

    try {
      for (const stream of (conn.streams || [])) {
        try { stream.cancel(); } catch {}
      }
      if (conn.client) conn.client.close();
    } catch {}

    conn.status = 'disconnected';
    this._connections.delete(name);
  }

  /**
   * Handle a gNMI SubscribeResponse message.
   */
  _handleResponse(deviceName, response) {
    // Sync response — one stream's initial snapshot complete
    if (response.sync_response) {
      const conn = this._connections.get(deviceName);
      if (conn) {
        conn.syncCount++;
        if (conn.syncCount >= conn.totalStreams) {
          conn.status = 'connected';
          conn.connectedAt = new Date().toISOString();
          console.log(`  [gNMI] ${deviceName} all ${conn.totalStreams} streams synced — streaming live`);
          this.emit('device:synced', { device: deviceName });
        }
      }
      return;
    }

    // Update notification
    const notification = response.update;
    if (!notification) return;

    const conn = this._connections.get(deviceName);
    if (conn) {
      conn.updateCount++;
      conn.lastUpdate = new Date().toISOString();
    }

    const prefix = pathToString(notification.prefix);
    const timestamp = notification.timestamp;

    // Process each update in the notification
    for (const update of (notification.update || [])) {
      const updatePath = pathToString(update.path);
      const fullPath = prefix + updatePath;
      const value = extractValue(update.val);

      this._classifyAndEmit(deviceName, fullPath, value, timestamp);
    }

    // Process deletes (e.g., adjacency removed)
    for (const del of (notification.delete || [])) {
      const delPath = pathToString(del);
      const fullPath = prefix + delPath;

      this._classifyAndEmit(deviceName, fullPath, null, timestamp, true);
    }
  }

  /**
   * Classify an update by path and emit the appropriate event.
   */
  _classifyAndEmit(deviceName, fullPath, value, timestamp, isDelete = false) {
    // ── IS-IS Adjacency Change ──
    if (fullPath.includes('/adjacencies/adjacency')) {
      const event = {
        device: deviceName,
        path: fullPath,
        timestamp,
        isDelete,
      };

      if (value && typeof value === 'object') {
        event.systemId = value['system-id'] || null;
        event.state = value['adjacency-state'] || null;
        event.neighborIp = value['neighbor-ipv4-address'] || null;
      }

      // Extract interface from path
      const ifMatch = fullPath.match(/interface-id=([^\]]+)/);
      if (ifMatch) event.interface = ifMatch[1];

      console.log(`  [gNMI] ${deviceName} ISIS adjacency ${isDelete ? 'REMOVED' : event.state || 'UPDATE'}: ${event.systemId || '?'} on ${event.interface || '?'}`);
      this.emit('isis:adjacency', event);
      this.emit('topology:changed', { device: deviceName, reason: 'isis-adjacency', detail: event });
      return;
    }

    // ── IS-IS SPF Run Counter ──
    if (fullPath.includes('/system-level-counters/state')) {
      if (value && typeof value === 'object') {
        const spfRuns = value['spf-runs'] || value['openconfig-network-instance:spf-runs'];
        if (spfRuns != null) {
          const prev = this._lastSpfRuns.get(deviceName) || 0;
          const current = parseInt(spfRuns, 10);

          if (prev > 0 && current > prev) {
            console.log(`  [gNMI] ${deviceName} SPF run detected (${prev} → ${current}) — triggering LSDB refresh`);
            this.emit('isis:spf-run', { device: deviceName, previous: prev, current, timestamp });
            this.emit('topology:changed', { device: deviceName, reason: 'spf-run', spfCount: current });
          }

          this._lastSpfRuns.set(deviceName, current);
        }

        // LSDB size change
        const lsdbSize = value['lsdb-size'] || value['arista-isis-augments:lsdb-size'];
        if (lsdbSize != null) {
          this.emit('isis:lsdb-size', { device: deviceName, size: parseInt(lsdbSize, 10), timestamp });
        }
      }
      return;
    }

    // ── Interface Oper-Status Change ──
    if (fullPath.includes('/state/oper-status')) {
      const ifMatch = fullPath.match(/interface\[name=([^\]]+)\]/);
      const ifName = ifMatch ? ifMatch[1] : 'unknown';

      // Filter out non-physical interfaces
      if (ifName.startsWith('Ethernet') || ifName.startsWith('Loopback') || ifName.startsWith('Port-Channel')) {
        console.log(`  [gNMI] ${deviceName} interface ${ifName} oper-status: ${value}`);
        this.emit('interface:status', {
          device: deviceName,
          interface: ifName,
          operStatus: value,
          timestamp,
        });

        // Ethernet status changes affect topology
        if (ifName.startsWith('Ethernet')) {
          this.emit('topology:changed', { device: deviceName, reason: 'interface-status', interface: ifName, status: value });
        }
      }
      return;
    }

    // ── Interface Counters (SAMPLE) ──
    if (fullPath.includes('/state/counters')) {
      const ifMatch = fullPath.match(/interface\[name=([^\]]+)\]/);
      const ifName = ifMatch ? ifMatch[1] : 'unknown';

      // Only emit for physical interfaces
      if (ifName.startsWith('Ethernet') || ifName.startsWith('Port-Channel')) {
        if (value && typeof value === 'object') {
          this.emit('interface:counters', {
            device: deviceName,
            interface: ifName,
            counters: {
              inOctets: value['in-octets'] || '0',
              outOctets: value['out-octets'] || '0',
              inPkts: value['in-pkts'] || '0',
              outPkts: value['out-pkts'] || '0',
              inErrors: value['in-errors'] || '0',
              outErrors: value['out-errors'] || '0',
              inDiscards: value['in-discards'] || '0',
              outDiscards: value['out-discards'] || '0',
              inUnicastPkts: value['in-unicast-pkts'] || '0',
              outUnicastPkts: value['out-unicast-pkts'] || '0',
              inMulticastPkts: value['in-multicast-pkts'] || '0',
              outMulticastPkts: value['out-multicast-pkts'] || '0',
            },
            timestamp,
          });
        }
      }
      return;
    }
  }
}

module.exports = GnmiSubscriber;
