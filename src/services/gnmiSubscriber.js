// ---------------------------------------------------------------------------
// gNMI Subscriber — Real-Time State Streaming via gnmic
// ---------------------------------------------------------------------------
// Uses gnmic (Go-based gNMI CLI) as a subprocess for proven Arista EOS
// compatibility. Each subscription path runs as a separate gnmic process
// that streams JSON to stdout, which we parse and emit as events.
//
// Architecture:
//   - ON_CHANGE: IS-IS adjacencies, interface oper-status, SPF counters
//     → Instant topology awareness, triggers targeted eAPI refresh
//   - SAMPLE: Interface counters (octets, errors, discards)
//     → Live bandwidth/error overlays
//
// Why gnmic subprocess instead of native gRPC?
//   Arista EOS's gNMI implementation has specific proto serialization
//   requirements that gnmic (the reference Go client) handles correctly.
//   This gives us immediate, reliable streaming while native gRPC
//   integration can be developed separately.
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// Subscription Definitions — Profile-Based
// ---------------------------------------------------------------------------
// Paths are organized by device role. All devices get COMMON paths.
// PE devices additionally get IS-IS SR and BGP service-specific paths.
// Devices running IS-IS (PE or network) get IS-IS paths.
// ---------------------------------------------------------------------------

/** Common ON_CHANGE paths — all devices regardless of role */
const COMMON_ON_CHANGE = [
  '/interfaces/interface/state/oper-status',
  '/lldp/interfaces/interface/neighbors',
];

/** Common SAMPLE paths — all devices */
const COMMON_SAMPLE = [
  '/interfaces/interface/state/counters',
  '/components/component/state/temperature',
];

/** IS-IS paths — devices running IS-IS (PE and some network devices) */
function isisOnChangePaths(instance) {
  return [
    `/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=${instance}]/isis/interfaces/interface/levels/level/adjacencies`,
    `/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=${instance}]/isis/levels/level[level-number=2]/system-level-counters/state`,
  ];
}

/**
 * Build the full subscription list for a device based on its role.
 *
 * Roles:
 *   'pe'      — Full MPLS PE: IS-IS SR, BGP VPNv4/EVPN, tunnel FIB
 *   'network' — Network device: may run IS-IS (no SR labels), BGP unicast only
 *
 * Both roles get all gNMI streams. The role difference is in how the
 * eAPI poller treats the device (skip tunnel FIB / FlexAlgo for non-PE).
 * IS-IS streams are included for both since network devices can run IS-IS.
 */
function buildSubscriptions(device, config) {
  const subs = [];

  // Common — all devices
  for (const p of COMMON_ON_CHANGE) {
    subs.push({ path: p, mode: 'on-change', interval: null });
  }
  for (const p of COMMON_SAMPLE) {
    subs.push({ path: p, mode: 'sample', interval: config.sampleIntervalSeconds });
  }

  // IS-IS — both PE and network devices that run IS-IS
  // (gnmic will gracefully fail if IS-IS isn't configured on the device)
  for (const p of isisOnChangePaths(config.isisInstance)) {
    subs.push({ path: p, mode: 'on-change', interval: null });
  }

  // Interface counters (separate from the common sample above for bandwidth overlay)
  // Already included in COMMON_SAMPLE via /interfaces/interface/state/counters

  return subs;
}

// ---------------------------------------------------------------------------
// GnmiSubscriber Class
// ---------------------------------------------------------------------------

class GnmiSubscriber extends EventEmitter {
  constructor() {
    super();
    this._processes = new Map();
    this._config = {
      enabled: false,
      port: 6030,
      sampleIntervalSeconds: 10,
      isisInstance: '100',
    };
    this._reconnectTimers = new Map();
    this._lastSpfRuns = new Map();
    this._deviceStatus = new Map();
    // Track interfaces with IS-IS adjacencies — only these get
    // counter events emitted (filters out management interfaces)
    this._topoInterfaces = new Set(); // "device:interface"
  }

  configure(gnmiConfig) {
    if (!gnmiConfig) return;
    this._config.enabled = gnmiConfig.enabled === true;
    this._config.port = gnmiConfig.port || 6030;
    this._config.sampleIntervalSeconds = gnmiConfig.sampleIntervalSeconds || 10;
    this._config.isisInstance = gnmiConfig.isisInstance || '100';
  }

  start(devices) {
    if (!this._config.enabled) {
      console.log('  [gNMI] Streaming disabled in config');
      return;
    }

    try {
      const { execSync } = require('child_process');
      execSync('which gnmic', { encoding: 'utf-8' });
    } catch {
      console.error('  [gNMI] gnmic not found — install from https://gnmic.openconfig.net');
      return;
    }

    console.log(`  [gNMI] Starting subscriptions to ${devices.length} device(s) on port ${this._config.port}`);
    for (const device of devices) {
      this._connectDevice(device);
    }
  }

  stop() {
    for (const [name, procs] of this._processes) {
      for (const p of procs) {
        try { p.proc.kill('SIGTERM'); } catch {}
      }
    }
    this._processes.clear();
    for (const [, timer] of this._reconnectTimers) clearTimeout(timer);
    this._reconnectTimers.clear();
    console.log('  [gNMI] All subscriptions stopped');
  }

  getStatus() {
    const status = {};
    for (const [name, devStatus] of this._deviceStatus) {
      status[name] = { ...devStatus };
    }
    return { enabled: this._config.enabled, port: this._config.port, connections: status };
  }

  /**
   * Add a new device to the subscriber — starts gNMI streams immediately.
   * Called when a device is added via the Devices tab.
   */
  addDevice(device) {
    if (!this._config.enabled) return;
    if (!device || !device.host) return;
    console.log(`  [gNMI] Adding new device ${device.name} to subscriber`);
    this._connectDevice(device);
  }

  /**
   * Remove a device from the subscriber — kills all gNMI streams.
   * Called when a device is removed via the Devices tab.
   */
  removeDevice(deviceName) {
    if (!deviceName) return;
    const procs = this._processes.get(deviceName);
    if (procs) {
      for (const p of procs) {
        try { p.proc.kill('SIGTERM'); } catch {}
      }
      this._processes.delete(deviceName);
    }
    this._deviceStatus.delete(deviceName);
    if (this._reconnectTimers.has(deviceName)) {
      clearTimeout(this._reconnectTimers.get(deviceName));
      this._reconnectTimers.delete(deviceName);
    }
    console.log(`  [gNMI] Removed device ${deviceName} from subscriber`);
  }

  _connectDevice(device) {
    const name = device.name;
    const target = `${device.host}:${this._config.port}`;

    if (this._processes.has(name)) {
      for (const p of this._processes.get(name)) {
        try { p.proc.kill('SIGTERM'); } catch {}
      }
    }

    // Build subscription list based on device role
    const subs = buildSubscriptions(device, this._config);
    const totalPaths = subs.length;

    this._deviceStatus.set(name, {
      status: 'connecting', connectedAt: null, lastUpdate: null,
      updateCount: 0, errorCount: 0, syncCount: 0,
      totalStreams: totalPaths, streams: `0/${totalPaths} synced`,
      role: device.role || 'pe',
    });

    console.log(`  [gNMI] Connecting to ${name} (${target}) — ${totalPaths} streams [${device.role || 'pe'}]`);

    const procs = [];
    for (const sub of subs) {
      procs.push({ proc: this._spawnGnmic(device, target, sub.path, sub.mode, sub.interval), path: sub.path });
    }
    this._processes.set(name, procs);
  }

  _spawnGnmic(device, target, pathStr, streamMode, sampleInterval) {
    const args = [
      'subscribe', '-a', target,
      '-u', device.username || 'admin', '-p', device.password || 'admin',
      '--insecure', '--path', pathStr,
      '--stream-mode', streamMode,
      '--encoding', 'json_ietf',
      '--format', 'json',
    ];
    if (sampleInterval) args.push('--sample-interval', `${sampleInterval}s`);

    const proc = spawn('gnmic', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let jsonBuffer = '';
    let braceDepth = 0;
    let inString = false;
    let escaped = false;

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Accumulate and detect complete JSON objects using brace counting
      for (const ch of chunk) {
        jsonBuffer += ch;

        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{') braceDepth++;
        if (ch === '}') {
          braceDepth--;
          if (braceDepth === 0 && jsonBuffer.trim()) {
            // Complete JSON object
            try {
              const obj = JSON.parse(jsonBuffer.trim());

              if (obj['sync-response'] || obj.sync_response) {
                this._handleSync(device.name, pathStr);
              } else if (obj.updates) {
                this._handleJsonUpdate(device.name, obj, pathStr);
              }
            } catch (parseErr) {
              // Log parse failures for debugging
              if (!proc._parseErrorLogged) {
                const shortPath = pathStr.split('/').slice(-2).join('/');
                console.error(`  [gNMI] ${device.name} JSON parse error on ${shortPath}: ${parseErr.message}`);
                proc._parseErrorLogged = true;
              }
            }
            jsonBuffer = '';
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('received signal')) {
        // Only log first error per stream to avoid spam
        if (!proc._errorLogged) {
          const shortPath = pathStr.split('/').slice(-2).join('/');
          console.error(`  [gNMI] ${device.name} error on ${shortPath}: ${msg.slice(0, 120)}`);
          proc._errorLogged = true;
        }
        const ds = this._deviceStatus.get(device.name);
        if (ds) ds.errorCount++;
      }
    });

    proc.on('close', (code) => {
      const ds = this._deviceStatus.get(device.name);
      const shortPath = pathStr.split('/').slice(-2).join('/');

      if (code !== 0 && code !== null) {
        console.log(`  [gNMI] ${device.name} stream exited (code=${code}) for ${shortPath}`);

        // If this stream never synced, reduce totalStreams so remaining
        // streams can still reach "connected" status
        if (ds && !proc._synced) {
          ds.totalStreams = Math.max(0, ds.totalStreams - 1);
          ds.streams = `${ds.syncCount}/${ds.totalStreams} synced`;

          // Check if remaining streams are all synced
          if (ds.totalStreams > 0 && ds.syncCount >= ds.totalStreams && ds.status !== 'connected') {
            ds.status = 'connected';
            ds.connectedAt = new Date().toISOString();
            console.log(`  [gNMI] ${device.name} ${ds.syncCount}/${ds.syncCount + 1} streams synced — streaming live (1 unavailable)`);
            this.emit('device:synced', { device: device.name });
          }
        }
      }

      const procs = this._processes.get(device.name) || [];
      const allDead = procs.every(p => p.proc.exitCode !== null);
      if (allDead && procs.length > 0 && ds) {
        if (ds.syncCount === 0) {
          ds.status = 'disconnected';
          this._scheduleReconnect(device);
        }
      }
    });

    return proc;
  }

  _handleSync(deviceName, pathStr) {
    const ds = this._deviceStatus.get(deviceName);
    if (!ds) return;

    // Mark the specific gnmic process as synced
    const procs = this._processes.get(deviceName) || [];
    const proc = procs.find(p => p.path === pathStr);
    if (proc) proc.proc._synced = true;

    ds.syncCount++;
    ds.streams = `${ds.syncCount}/${ds.totalStreams} synced`;
    if (ds.syncCount >= ds.totalStreams) {
      ds.status = 'connected';
      ds.connectedAt = new Date().toISOString();
      console.log(`  [gNMI] ${deviceName} all ${ds.totalStreams} streams synced — streaming live`);
      this.emit('device:synced', { device: deviceName });
    }
  }

  _handleJsonUpdate(deviceName, obj, subscribedPath) {
    const ds = this._deviceStatus.get(deviceName);
    if (ds) { ds.updateCount++; ds.lastUpdate = new Date().toISOString(); }

    const timestamp = obj.timestamp;
    const prefix = obj.prefix || '';

    // For SAMPLE subscriptions (counters, temperature), gnmic splits
    // each field into a separate update AND uses a prefix field.
    // Accumulate all fields from this JSON object into one flat map.
    const allValues = {};
    const fullPaths = [];

    for (const update of (obj.updates || [])) {
      const shortPath = update.Path || '';
      const fullPath = prefix ? `${prefix}/${shortPath}`.replace(/\/+/g, '/') : shortPath;
      fullPaths.push(fullPath);

      const values = update.values || {};
      for (const [k, v] of Object.entries(values)) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          Object.assign(allValues, v);
        } else {
          const leaf = k.split('/').pop();
          allValues[leaf] = v;
        }
      }
    }

    // Use the prefix or first full path for interface/component matching
    const matchPath = prefix || fullPaths[0] || '';

    // IS-IS Adjacency Change
    if (subscribedPath.includes('adjacencies')) {
      const systemId = allValues['system-id'] || null;
      const adjState = allValues['adjacency-state'] || null;
      const neighborIp = allValues['neighbor-ipv4-address'] || null;
      const ifMatch = matchPath.match(/interface-id=([^\]]+)/);
      const ifName = ifMatch ? ifMatch[1] : null;

      if (systemId || adjState) {
        // Track this interface as a topology interface
        if (ifName && deviceName) {
          this._topoInterfaces.add(`${deviceName}:${ifName}`);
        }
        console.log(`  [gNMI] ${deviceName} ISIS adjacency ${adjState || 'UPDATE'}: ${systemId || '?'} on ${ifName || '?'}`);
        const adjEvent = { device: deviceName, systemId, state: adjState, neighborIp, interface: ifName, timestamp };
        this.emit('isis:adjacency', adjEvent);
        this.emit('topology:changed', { device: deviceName, reason: 'isis-adjacency', detail: adjEvent });
      }
      return;
    }

    // IS-IS SPF Run Counter
    if (subscribedPath.includes('system-level-counters')) {
      const spfRuns = allValues['spf-runs'];
      if (spfRuns != null) {
        const prev = this._lastSpfRuns.get(deviceName) || 0;
        const current = parseInt(spfRuns, 10);
        if (prev > 0 && current > prev) {
          console.log(`  [gNMI] ${deviceName} SPF run detected (${prev} -> ${current}) -- triggering LSDB refresh`);
          this.emit('isis:spf-run', { device: deviceName, previous: prev, current, timestamp });
          this.emit('topology:changed', { device: deviceName, reason: 'spf-run', spfCount: current });
        }
        this._lastSpfRuns.set(deviceName, current);
      }
      const lsdbSize = allValues['lsdb-size'] || allValues['arista-isis-augments:lsdb-size'];
      if (lsdbSize != null) {
        this.emit('isis:lsdb-size', { device: deviceName, size: parseInt(lsdbSize, 10), timestamp });
      }
      return;
    }

    // Interface Oper-Status Change
    if (subscribedPath.includes('oper-status')) {
      const ifMatch = matchPath.match(/interface\[name=([^\]]+)\]/);
      const ifName = ifMatch ? ifMatch[1] : 'unknown';
      const operStatus = allValues['oper-status'] || Object.values(allValues)[0];

      if (!operStatus || operStatus === 'NOT_PRESENT' || operStatus === 'LOWER_LAYER_DOWN' || operStatus === 'DORMANT') {
        return;
      }

      if (ifName.startsWith('Ethernet') || ifName.startsWith('Loopback') || ifName.startsWith('Port-Channel')) {
        console.log(`  [gNMI] ${deviceName} interface ${ifName} oper-status: ${operStatus}`);
        this.emit('interface:status', { device: deviceName, interface: ifName, operStatus, timestamp });
        if (ifName.startsWith('Ethernet') && (operStatus === 'UP' || operStatus === 'DOWN')) {
          this.emit('topology:changed', { device: deviceName, reason: 'interface-status', interface: ifName, status: operStatus });
        }
      }
      return;
    }

    // Interface Counters (SAMPLE)
    if (subscribedPath.includes('counters')) {
      // Skip initial sync data — each field comes as a separate JSON object
      // with no prefix, giving us incomplete samples (most fields = 0).
      // Only process periodic samples which have a prefix field and ALL fields.
      if (!prefix) return;

      const ifMatch = matchPath.match(/interface\[name=([^\]]+)\]/);
      const ifName = ifMatch ? ifMatch[1] : 'unknown';

      // One-time diagnostic log
      if (!this._counterLogDone) {
        this._counterLogDone = true;
        console.log(`  [gNMI] Counter sample: ${deviceName}:${ifName} — ${Object.keys(allValues).length} fields`);
        console.log(`  [gNMI] Topology interfaces registered: ${this._topoInterfaces.size} [${[...this._topoInterfaces].slice(0, 6).join(', ')}${this._topoInterfaces.size > 6 ? '...' : ''}]`);
      }

      if (ifName.startsWith('Ethernet') || ifName.startsWith('Port-Channel')) {
        // Only track interfaces that are part of the IS-IS topology
        // (filters out management interfaces like Ethernet47/48)
        const topoKey = `${deviceName}:${ifName}`;
        if (this._topoInterfaces.size > 0 && !this._topoInterfaces.has(topoKey)) {
          return;
        }
        this.emit('interface:counters', {
          device: deviceName, interface: ifName, timestamp,
          counters: {
            inOctets: allValues['in-octets'] || '0', outOctets: allValues['out-octets'] || '0',
            inPkts: allValues['in-pkts'] || '0', outPkts: allValues['out-pkts'] || '0',
            inErrors: allValues['in-errors'] || '0', outErrors: allValues['out-errors'] || '0',
            inDiscards: allValues['in-discards'] || '0', outDiscards: allValues['out-discards'] || '0',
          },
        });
      }
      return;
    }

    // LLDP Neighbor Change
    if (subscribedPath.includes('/lldp')) {
      const ifMatch = matchPath.match(/interface\[name=([^\]]+)\]/);
      const ifName = ifMatch ? ifMatch[1] : null;
      const systemName = allValues['system-name'] || null;
      const portDesc = allValues['port-description'] || null;
      const mgmtAddr = allValues['management-address'] || null;
      const sysDesc = allValues['system-description'] || null;
      const neighborId = allValues['id'] || allValues['neighbor-id'] || null;

      if (ifName && (systemName || neighborId)) {
        this.emit('lldp:neighbor', {
          device: deviceName, interface: ifName,
          neighbor: { systemName, neighborId, portDesc, mgmtAddr, sysDesc },
          timestamp,
        });
      }
      return;
    }

    // Component Temperature (hardware health)
    if (subscribedPath.includes('/components') || subscribedPath.includes('temperature')) {
      const compMatch = matchPath.match(/component\[name=([^\]]+)\]/);
      const compName = compMatch ? compMatch[1] : null;
      const temp = allValues['instant'] || allValues['temperature'] || null;
      const alarm = allValues['alarm-status'] || null;

      if (compName && temp != null) {
        this.emit('system:temperature', {
          device: deviceName, component: compName,
          temperature: parseFloat(temp),
          alarm: alarm === true || alarm === 'true',
          timestamp,
        });
      }
      return;
    }
  }

  _scheduleReconnect(device) {
    const name = device.name;
    if (this._reconnectTimers.has(name)) return;
    this._reconnectTimers.set(name, setTimeout(() => {
      this._reconnectTimers.delete(name);
      console.log(`  [gNMI] Reconnecting to ${name}...`);
      this._connectDevice(device);
    }, 15000));
  }
}

module.exports = GnmiSubscriber;
