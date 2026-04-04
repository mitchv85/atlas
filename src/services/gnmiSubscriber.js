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
// Subscription Definitions
// ---------------------------------------------------------------------------

const ON_CHANGE_PATHS = [
  '/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=100]/isis/interfaces/interface/levels/level/adjacencies',
  '/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=100]/isis/levels/level[level-number=2]/system-level-counters/state',
  '/interfaces/interface/state/oper-status',
];

const SAMPLE_PATHS = [
  '/interfaces/interface/state/counters',
];

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
  }

  configure(gnmiConfig) {
    if (!gnmiConfig) return;
    this._config.enabled = gnmiConfig.enabled === true;
    this._config.port = gnmiConfig.port || 6030;
    this._config.sampleIntervalSeconds = gnmiConfig.sampleIntervalSeconds || 10;
    this._config.isisInstance = gnmiConfig.isisInstance || '100';

    if (this._config.isisInstance !== '100') {
      const inst = this._config.isisInstance;
      ON_CHANGE_PATHS[0] = `/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=${inst}]/isis/interfaces/interface/levels/level/adjacencies`;
      ON_CHANGE_PATHS[1] = `/network-instances/network-instance[name=default]/protocols/protocol[identifier=ISIS][name=${inst}]/isis/levels/level[level-number=2]/system-level-counters/state`;
    }
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

  _connectDevice(device) {
    const name = device.name;
    const target = `${device.host}:${this._config.port}`;

    if (this._processes.has(name)) {
      for (const p of this._processes.get(name)) {
        try { p.proc.kill('SIGTERM'); } catch {}
      }
    }

    const totalPaths = ON_CHANGE_PATHS.length + SAMPLE_PATHS.length;
    this._deviceStatus.set(name, {
      status: 'connecting', connectedAt: null, lastUpdate: null,
      updateCount: 0, errorCount: 0, syncCount: 0,
      totalStreams: totalPaths, streams: `0/${totalPaths} synced`,
    });

    console.log(`  [gNMI] Connecting to ${name} (${target}) — ${totalPaths} streams`);

    const procs = [];
    for (const pathStr of ON_CHANGE_PATHS) {
      procs.push({ proc: this._spawnGnmic(device, target, pathStr, 'on-change', null), path: pathStr });
    }
    for (const pathStr of SAMPLE_PATHS) {
      procs.push({ proc: this._spawnGnmic(device, target, pathStr, 'sample', this._config.sampleIntervalSeconds), path: pathStr });
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
      '--format', 'event',
    ];
    if (sampleInterval) args.push('--sample-interval', `${sampleInterval}s`);

    const proc = spawn('gnmic', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const events = JSON.parse(line);
          for (const event of (Array.isArray(events) ? events : [events])) {
            if (event['sync-response'] || event.sync_response) {
              this._handleSync(device.name, pathStr);
            } else {
              this._handleEvent(device.name, event, pathStr);
            }
          }
        } catch {}
      }
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('received signal')) {
        console.error(`  [gNMI] ${device.name} stderr: ${msg}`);
        const ds = this._deviceStatus.get(device.name);
        if (ds) ds.errorCount++;
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        const shortPath = pathStr.split('/').slice(-2).join('/');
        console.log(`  [gNMI] ${device.name} stream exited (code=${code}) for ${shortPath}`);
      }
      const procs = this._processes.get(device.name) || [];
      const allDead = procs.every(p => p.proc.exitCode !== null);
      if (allDead && procs.length > 0) {
        const ds = this._deviceStatus.get(device.name);
        if (ds) ds.status = 'disconnected';
        this._scheduleReconnect(device);
      }
    });

    return proc;
  }

  _handleSync(deviceName, pathStr) {
    const ds = this._deviceStatus.get(deviceName);
    if (!ds) return;
    ds.syncCount++;
    ds.streams = `${ds.syncCount}/${ds.totalStreams} synced`;
    if (ds.syncCount >= ds.totalStreams) {
      ds.status = 'connected';
      ds.connectedAt = new Date().toISOString();
      console.log(`  [gNMI] ${deviceName} all ${ds.totalStreams} streams synced — streaming live`);
      this.emit('device:synced', { device: deviceName });
    }
  }

  _handleEvent(deviceName, event, subscribedPath) {
    const ds = this._deviceStatus.get(deviceName);
    if (ds) { ds.updateCount++; ds.lastUpdate = new Date().toISOString(); }

    const name = event.name || '';
    const values = event.values || {};
    const tags = event.tags || {};
    const timestamp = event.timestamp;

    // IS-IS Adjacency Change
    if (subscribedPath.includes('adjacencies')) {
      const systemId = values['system-id'] || tags['system-id'] || null;
      const adjState = values['adjacency-state'] || null;
      const neighborIp = values['neighbor-ipv4-address'] || null;
      const ifName = tags['interface-id'] || null;

      if (systemId || adjState) {
        console.log(`  [gNMI] ${deviceName} ISIS adjacency ${adjState || 'UPDATE'}: ${systemId || '?'} on ${ifName || '?'}`);
        const adjEvent = { device: deviceName, systemId, state: adjState, neighborIp, interface: ifName, timestamp };
        this.emit('isis:adjacency', adjEvent);
        this.emit('topology:changed', { device: deviceName, reason: 'isis-adjacency', detail: adjEvent });
      }
      return;
    }

    // IS-IS SPF Run Counter
    if (subscribedPath.includes('system-level-counters')) {
      const spfRuns = values['spf-runs'];
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

      const lsdbSize = values['lsdb-size'] || values['arista-isis-augments:lsdb-size'];
      if (lsdbSize != null) {
        this.emit('isis:lsdb-size', { device: deviceName, size: parseInt(lsdbSize, 10), timestamp });
      }
      return;
    }

    // Interface Oper-Status Change
    if (subscribedPath.includes('oper-status')) {
      const ifName = tags['name'] || 'unknown';
      const operStatus = values['oper-status'] || null;

      if (operStatus && (ifName.startsWith('Ethernet') || ifName.startsWith('Loopback') || ifName.startsWith('Port-Channel'))) {
        console.log(`  [gNMI] ${deviceName} interface ${ifName} oper-status: ${operStatus}`);
        this.emit('interface:status', { device: deviceName, interface: ifName, operStatus, timestamp });
        if (ifName.startsWith('Ethernet')) {
          this.emit('topology:changed', { device: deviceName, reason: 'interface-status', interface: ifName, status: operStatus });
        }
      }
      return;
    }

    // Interface Counters (SAMPLE)
    if (subscribedPath.includes('counters')) {
      const ifName = tags['name'] || 'unknown';
      if (ifName.startsWith('Ethernet') || ifName.startsWith('Port-Channel')) {
        this.emit('interface:counters', {
          device: deviceName, interface: ifName, timestamp,
          counters: {
            inOctets: values['in-octets'] || '0', outOctets: values['out-octets'] || '0',
            inPkts: values['in-pkts'] || '0', outPkts: values['out-pkts'] || '0',
            inErrors: values['in-errors'] || '0', outErrors: values['out-errors'] || '0',
            inDiscards: values['in-discards'] || '0', outDiscards: values['out-discards'] || '0',
          },
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
