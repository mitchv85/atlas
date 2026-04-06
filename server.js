// ---------------------------------------------------------------------------
// ATLAS Server — Main Entry Point
// ---------------------------------------------------------------------------
// Express HTTP server with WebSocket support for real-time topology updates.
// Serves the SPA frontend, REST API routes, SSH proxy, gNMI subscriber,
// and manages the background topology poller lifecycle.
//
// Endpoints:
//   /api/devices     — Device management (CRUD, test, bulk import)
//   /api/topology    — Topology graph, path analysis, FlexAlgo
//   /api/bgp         — BGP state, VRFs, prefix detail, service path trace
//   /api/sflow       — sFlow collector status, flow data, configuration
//   /api/gnmi/status — gNMI subscriber connection status
//   /ws              — WebSocket for topology change notifications
//   /ssh             — WebSocket-to-SSH proxy for terminal access
// ---------------------------------------------------------------------------

require('dotenv').config();
const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');

const authService = require('./src/services/auth');
const authRoutes = require('./src/routes/auth');
const mgmtRoutes = require('./src/routes/mgmt');
const deviceRoutes = require('./src/routes/devices');
const topologyRoutes = require('./src/routes/topology');
const bgpRoutes = require('./src/routes/bgp');
const sflowRoutes = require('./src/routes/sflow');
const poller = require('./src/services/poller');
const { SflowCollector } = require('./src/services/sflowCollector');
const SflowAggregator = require('./src/services/sflowAggregator');
const sflowStore = require('./src/store/sflow');
const deviceStore = require('./src/store/devices');
const GnmiSubscriber = require('./src/services/gnmiSubscriber');
const CounterRateEngine = require('./src/services/counterRates');
const healthStore = require('./src/store/health');
const db = require('./src/db');

const gnmiSubscriber = new GnmiSubscriber();
const counterRates = new CounterRateEngine();

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Share the poller with topology routes
// ---------------------------------------------------------------------------
app.set('poller', poller);
app.set('gnmiSubscriber', gnmiSubscriber);

// ---------------------------------------------------------------------------
// Auth Routes (public — no auth required)
// ---------------------------------------------------------------------------
app.use('/api/auth', authRoutes);

// ---------------------------------------------------------------------------
// Protected API Routes — require valid JWT
// ---------------------------------------------------------------------------
app.use('/api/devices', authService.requireAuth, deviceRoutes);
app.use('/api/topology', authService.requireAuth, topologyRoutes);
app.use('/api/bgp', authService.requireAuth, bgpRoutes);
app.use('/api/sflow', authService.requireAuth, sflowRoutes);
app.use('/api/mgmt', authService.requireAuth, mgmtRoutes);

// Poller status endpoint (protected)
app.get('/api/status', authService.requireAuth, (_req, res) => {
  res.json(poller.getStatus());
});

// gNMI subscriber status endpoint (protected)
app.get('/api/gnmi/status', authService.requireAuth, (_req, res) => {
  res.json(gnmiSubscriber.getStatus());
});

// gNMI reconnect a specific device (protected)
app.post('/api/gnmi/reconnect/:name', authService.requireAuth, (req, res) => {
  const name = req.params.name;
  const allDevices = deviceStore.getAllRaw();
  const device = allDevices.find(d => d.name === name);
  if (!device) return res.status(404).json({ error: `Device ${name} not found` });
  gnmiSubscriber.removeDevice(name);
  gnmiSubscriber.addDevice(device);
  res.json({ success: true, message: `Reconnecting gNMI streams for ${name}` });
});

// Health dashboard endpoints (protected)
app.get('/api/health', authService.requireAuth, (_req, res) => {
  res.json(healthStore.getAllHealth());
});

app.get('/api/health/:device', authService.requireAuth, (req, res) => {
  res.json(healthStore.getDeviceHealth(req.params.device));
});

// Bandwidth / interface rates endpoints (protected)
/**
 * Build edge-mapped bandwidth rates with per-link speeds and utilization.
 * Priority: bandwidth override (shaped/policed) > physical speed > global fallback.
 * Reused by both the REST endpoint and WebSocket broadcasts.
 */
function buildEdgeRates(linkRates) {
  const topology = poller.getTopology();
  const lldp = healthStore.getAllLldpNeighbors();
  const speeds = healthStore.getAllInterfaceSpeeds();
  const overrides = db.bandwidthOverrides.getAll();
  const edgeRates = [];

  if (!topology || !topology.edges) return edgeRates;

  // Build LLDP map: "device:interface" → peer hostname
  const lldpMap = new Map();
  for (const n of lldp) {
    const peerName = (n.systemName || '').replace(/\..*/,'');
    if (peerName) lldpMap.set(`${n.device}:${n.interface}`, peerName);
  }

  // Build edge lookup: "hostA|hostB" → edge data
  const edgeLookup = new Map();
  for (const edge of topology.edges) {
    const a = edge.data.sourceLabel;
    const b = edge.data.targetLabel;
    const key = [a, b].sort().join('|');
    if (!edgeLookup.has(key)) edgeLookup.set(key, []);
    edgeLookup.get(key).push(edge);
  }

  // Map each interface rate to an edge, enriched with speed
  const edgeRateMap = new Map();
  for (const [linkKey, rate] of Object.entries(linkRates)) {
    const peer = lldpMap.get(linkKey);
    if (!peer) continue;

    const device = linkKey.split(':')[0];
    const ifName = linkKey.split(':')[1];
    const pairKey = [device, peer].sort().join('|');
    const edges = edgeLookup.get(pairKey);
    if (!edges || edges.length === 0) continue;

    const edge = edges[0];
    const edgeId = edge.data.id;

    if (!edgeRateMap.has(edgeId)) {
      edgeRateMap.set(edgeId, {
        edgeId,
        source: edge.data.sourceLabel,
        target: edge.data.targetLabel,
        maxBps: 0, inBps: 0, outBps: 0,
        srcOutBps: 0, tgtOutBps: 0, // Per-side egress rates
        speedBps: null, utilization: null,
        sourceInterface: null, targetInterface: null,
        errors: 0, discards: 0,
      });
    }
    const er = edgeRateMap.get(edgeId);
    er.inBps += rate.inBps || 0;
    er.outBps += rate.outBps || 0;
    er.maxBps = Math.max(er.maxBps, rate.maxBps || 0);
    er.errors += (rate.hasErrors ? 1 : 0);
    er.discards += (rate.hasDiscards ? 1 : 0);

    // Track interface names, speed, and per-side egress rates
    const linkSpeed = speeds[linkKey] || null;
    if (device === edge.data.sourceLabel) {
      er.sourceInterface = ifName;
      er.srcOutBps = rate.outBps || 0;
      if (linkSpeed && (!er.speedBps || linkSpeed < er.speedBps)) er.speedBps = linkSpeed;
    } else {
      er.targetInterface = ifName;
      er.tgtOutBps = rate.outBps || 0;
      if (linkSpeed && (!er.speedBps || linkSpeed < er.speedBps)) er.speedBps = linkSpeed;
    }
  }

  // Compute utilization for each edge
  // Priority: bandwidth override > physical speed
  for (const er of edgeRateMap.values()) {
    const override = overrides[er.edgeId];
    if (override) {
      er.overrideSpeedBps = override.speedBps;
      er.overrideLabel = override.label;
      er.overrideNotes = override.notes;
    }
    // Use override speed for utilization if set, otherwise physical
    const effectiveSpeed = override?.speedBps || er.speedBps;
    er.effectiveSpeedBps = effectiveSpeed || null;
    if (effectiveSpeed && effectiveSpeed > 0) {
      er.utilization = Math.round((er.maxBps / effectiveSpeed) * 10000) / 100;
    }
    edgeRates.push(er);
  }

  return edgeRates;
}

app.get('/api/bandwidth', authService.requireAuth, (_req, res) => {
  const links = counterRates.getLinkRates();
  const summaries = counterRates.getDeviceSummaries();
  const edgeRates = buildEdgeRates(links);
  const speeds = healthStore.getAllInterfaceSpeeds();
  const overrides = db.bandwidthOverrides.getAll();
  res.json({ links, summaries, edgeRates, speeds, overrides, timestamp: Date.now() });
});

// Bandwidth overrides — per-link speed caps for shaped/policed links
// MUST come before /:device to avoid Express matching "overrides" as a device name
app.get('/api/bandwidth/overrides', authService.requireAuth, (_req, res) => {
  res.json(db.bandwidthOverrides.getAll());
});

app.put('/api/bandwidth/override/:edgeId', authService.requireAuth, (req, res) => {
  const { speedBps, label, notes } = req.body || {};
  if (!speedBps || speedBps <= 0) {
    return res.status(400).json({ error: 'speedBps is required and must be positive.' });
  }
  const result = db.bandwidthOverrides.set(
    req.params.edgeId,
    speedBps,
    { label, notes, createdBy: req.authUser?.username }
  );
  res.json(result);
});

app.delete('/api/bandwidth/override/:edgeId', authService.requireAuth, (req, res) => {
  db.bandwidthOverrides.remove(req.params.edgeId);
  res.json({ ok: true });
});

// Per-device bandwidth rates (must come AFTER /overrides and /override routes)
app.get('/api/bandwidth/:device', authService.requireAuth, (req, res) => {
  res.json(counterRates.getDeviceRates(req.params.device));
});

// LLDP neighbors endpoint (protected)
app.get('/api/lldp', authService.requireAuth, (_req, res) => {
  res.json(healthStore.getAllLldpNeighbors());
});

// Global settings endpoints
app.get('/api/settings/bw-thresholds', authService.requireAuth, (_req, res) => {
  const thresholds = db.settings.get('bw_thresholds') || [1, 10, 25, 50, 75, 90];
  res.json({ thresholds });
});

app.put('/api/settings/bw-thresholds', authService.requireRole('admin'), (req, res) => {
  const { thresholds } = req.body || {};
  if (!Array.isArray(thresholds) || thresholds.length !== 6) {
    return res.status(400).json({ error: 'thresholds must be an array of 6 numbers.' });
  }
  db.settings.set('bw_thresholds', thresholds, req.authUser?.username);
  res.json({ ok: true, thresholds });
});

// ---------------------------------------------------------------------------
// SPA Fallback
// ---------------------------------------------------------------------------
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket Server
// ---------------------------------------------------------------------------
const server = http.createServer(app);

// Both WebSocket servers use noServer mode — we route upgrades manually
const wss = new WebSocketServer({ noServer: true });
const sshWss = new WebSocketServer({ noServer: true });

// Route WebSocket upgrades by path
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;

  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (pathname === '/ssh') {
    sshWss.handleUpgrade(request, socket, head, (ws) => {
      sshWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Track connected clients
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

  // Send current topology immediately on connect
  const topo = poller.getTopology();
  if (topo) {
    ws.send(JSON.stringify({ type: 'topology:updated', data: filterHiddenNodes(topo) }));
  }

  // Send current status
  ws.send(JSON.stringify({ type: 'status', data: poller.getStatus() }));

  ws.on('close', () => {
    clients.delete(ws);
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
});

/**
 * Broadcast a message to all connected WebSocket clients.
 */
function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Poller Events → WebSocket Broadcasts
// ---------------------------------------------------------------------------

// Use shared filter from device store
const { filterHiddenNodes } = deviceStore;

poller.on('topology:changed', (topology) => {
  broadcast({ type: 'topology:changed', data: filterHiddenNodes(topology) });
});

poller.on('topology:updated', (topology) => {
  broadcast({
    type: 'topology:updated',
    data: {
      metadata: topology.metadata,
      nodeCount: topology.metadata.nodeCount,
      edgeCount: topology.metadata.edgeCount,
    },
  });
  broadcast({ type: 'status', data: poller.getStatus() });
});

// Collection started
poller.on('status:collecting', () => {
  broadcast({ type: 'status', data: poller.getStatus() });
});

// Collection ended without topology update (error or no data)
poller.on('status:updated', () => {
  broadcast({ type: 'status', data: poller.getStatus() });
});

// ---------------------------------------------------------------------------
// BGP Store Events → WebSocket Broadcasts
// ---------------------------------------------------------------------------
const bgpStore = require('./src/store/bgp');

bgpStore.on('vrfs:updated', (vrfSummary) => {
  broadcast({ type: 'bgp:vrfs:updated', data: vrfSummary });
});

bgpStore.on('rib:updated', (ribInfo) => {
  broadcast({ type: 'bgp:rib:updated', data: ribInfo });
});

bgpStore.on('neighbors:updated', (neighbors) => {
  broadcast({ type: 'bgp:neighbors:updated', data: neighbors });
});

bgpStore.on('status:changed', (status) => {
  broadcast({ type: 'bgp:status', data: status });
});

// ---------------------------------------------------------------------------
// gNMI Subscriber — Real-Time State Streaming
// ---------------------------------------------------------------------------

// Topology change events from gNMI → trigger eAPI refresh + notify clients
gnmiSubscriber.on('topology:changed', ({ device, reason, detail }) => {
  console.log(`  [gNMI] Topology change from ${device}: ${reason}`);
  // Debounce: wait 2s for flap storms to settle, then trigger eAPI refresh
  if (!gnmiSubscriber._refreshTimer) {
    gnmiSubscriber._refreshTimer = setTimeout(async () => {
      gnmiSubscriber._refreshTimer = null;
      // Wait for any in-progress collection to finish (up to 30s)
      for (let i = 0; i < 60; i++) {
        if (!poller.isCollecting()) break;
        console.log('  [gNMI] Waiting for current poll to finish...');
        await new Promise(r => setTimeout(r, 500));
      }
      try {
        console.log('  [gNMI] Triggering eAPI topology refresh...');
        await poller.forceCollect();
        console.log('  [gNMI] eAPI topology refresh complete — broadcast sent');
      } catch (err) {
        console.error('  [gNMI] eAPI refresh failed:', err.message);
      }
    }, 2000);
  }
});

// IS-IS adjacency events → immediate broadcast to clients
gnmiSubscriber.on('isis:adjacency', (event) => {
  broadcast({ type: 'gnmi:isis:adjacency', data: event });
});

// Interface status changes → broadcast + health store
gnmiSubscriber.on('interface:status', (event) => {
  broadcast({ type: 'gnmi:interface:status', data: event });
  healthStore.recordInterfaceStatus(event);
});

// Interface counter samples → feed into rate engine for bandwidth overlay
let _counterDiagDone = false;
gnmiSubscriber.on('interface:counters', (event) => {
  if (!_counterDiagDone) {
    _counterDiagDone = true;
    console.log(`  [Bandwidth] First counter event: ${event.device}:${event.interface} inOctets=${event.counters?.inOctets}`);
  }
  counterRates.processSample(event);
});

// Device sync complete
gnmiSubscriber.on('device:synced', ({ device }) => {
  broadcast({ type: 'gnmi:device:synced', data: { device } });
});

// LLDP neighbor changes → health store + broadcast
let _lldpDiagDone = false;
gnmiSubscriber.on('lldp:neighbor', (event) => {
  if (!_lldpDiagDone) {
    _lldpDiagDone = true;
    console.log(`  [Health] First LLDP event: ${event.device}:${event.interface} → ${event.neighbor?.systemName}`);
  }
  healthStore.recordLldpNeighbor(event);
  broadcast({ type: 'gnmi:lldp:neighbor', data: event });
});

// Temperature updates → health store
gnmiSubscriber.on('system:temperature', (event) => {
  healthStore.recordTemperature(event);
});

// Counter rate engine → broadcast bandwidth snapshots to all clients
counterRates.on('rates:updated', (snapshot) => {
  const edgeRates = buildEdgeRates(snapshot.links);
  broadcast({ type: 'bandwidth:updated', data: { ...snapshot, edgeRates } });
});

// ---------------------------------------------------------------------------
// sFlow Collector + Aggregator — LSP-level traffic visibility
// ---------------------------------------------------------------------------
const sflowCollector = new SflowCollector({ port: 6343 });
const sflowAggregator = new SflowAggregator();

// Share aggregator with routes for LSP/edge detail queries
app.set('sflowAggregator', sflowAggregator);

// Wire collector → aggregator
sflowCollector.on('flow', (flowSample) => {
  sflowAggregator.processFlow(flowSample);
});

// Wire aggregator → store → WebSocket
sflowAggregator.on('flows:updated', (snapshot) => {
  sflowStore.updateSnapshot(snapshot);
  sflowStore.updateCollectorStats(sflowCollector.getStats());
  sflowStore.updateAggregatorStats(sflowAggregator.getStats());
  broadcast({ type: 'sflow:flows:updated', data: snapshot });
});

// Feed topology updates into the aggregator's correlation engine
poller.on('topology:changed', (topology) => {
  sflowAggregator.updateTopology(topology);
});

// Also update on regular polls (ensures aggregator has data on first cycle)
poller.on('topology:updated', (topology) => {
  if (typeof topology === 'object' && topology.nodes) {
    sflowAggregator.updateTopology(topology);
  }
});

// Tunnel counter rates → WebSocket broadcast
poller.on('tunnelCounters:updated', (rates) => {
  broadcast({ type: 'sflow:tunnelRates:updated', data: rates });
});

// ---------------------------------------------------------------------------
// WebSocket SSH Proxy — /ssh?device=<name>
// ---------------------------------------------------------------------------
const { Client: SshClient } = require('ssh2');

sshWss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const deviceName = params.get('device');
  const allDevices = deviceStore.getAllRaw();
  const device = allDevices.find(
    (d) => d.name.toLowerCase() === (deviceName || '').toLowerCase()
  );

  if (!device) {
    ws.send(JSON.stringify({ type: 'error', data: `Unknown device: ${deviceName}\r\n` }));
    return ws.close();
  }

  console.log(`  [SSH] New session → ${device.name} (${device.host})`);
  const ssh = new SshClient();

  ssh.on('ready', () => {
    ws.send(JSON.stringify({ type: 'status', data: 'connected' }));
    ssh.shell({ term: 'xterm-256color', rows: 24, cols: 120 }, (err, stream) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'error', data: `Shell error: ${err.message}\r\n` }));
        return ws.close();
      }

      // SSH → WebSocket
      stream.on('data', (data) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
      });
      stream.stderr.on('data', (data) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
      });
      stream.on('close', () => {
        ws.send(JSON.stringify({ type: 'status', data: 'disconnected' }));
        ws.close();
      });

      // WebSocket → SSH
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'data') stream.write(Buffer.from(msg.data, 'base64'));
          if (msg.type === 'resize') stream.setWindow(msg.rows, msg.cols, 0, 0);
        } catch (e) {
          console.error('  [SSH] ws message error:', e.message);
        }
      });

      ws.on('close', () => { try { stream.close(); ssh.end(); } catch {} });
    });
  });

  ssh.on('error', (err) => {
    console.error(`  [SSH] Error ${device.name}:`, err.message);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'error', data: `\r\nSSH Error: ${err.message}\r\n` }));
    }
    ws.close();
  });

  ssh.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => {
    finish([device.password]);
  });

  ssh.connect({
    host: device.host,
    port: 22,
    username: device.username,
    password: device.password,
    readyTimeout: 20000,
    hostVerifier: () => true,
    tryKeyboard: true,
  });

  ws.on('close', () => { try { ssh.end(); } catch {} });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, async () => {
  // Initialize SQLite database (loads/creates atlas.db)
  await db.init();

  // Load deployment config from atlas.config.json
  deviceStore.loadConfig();

  // Initialize default users if none exist
  await authService.initUsers();

  // Load gNMI config before banner
  let gnmiConfig = null;
  try {
    const configPath = path.join(__dirname, 'atlas.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.gnmi) {
      gnmiConfig = config.gnmi;
      gnmiSubscriber.configure(gnmiConfig);
    }
  } catch {}

  const gnmiStatus = gnmiSubscriber._config.enabled ? 'enabled' : 'disabled';

  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║          A T L A S   v0.7.1          ║`);
  console.log(`  ║   Network Topology & Operations       ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  http://localhost:${PORT}               ║`);
  console.log(`  ║  WebSocket: ws://localhost:${PORT}/ws    ║`);
  console.log(`  ║  SSH Proxy: ws://localhost:${PORT}/ssh   ║`);
  console.log(`  ║  sFlow:    udp://0.0.0.0:6343        ║`);
  console.log(`  ║  gNMI:     port ${gnmiSubscriber._config.port} (${gnmiStatus})       ║`);
  console.log(`  ║  Auth:     JWT (${authService.TOKEN_TTL} TTL)             ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);

  // Start the background poller
  poller.start();

  // Start sFlow collector + aggregator
  sflowCollector.start();
  sflowAggregator.start();
  sflowStore.setConfig({ enabled: true, port: 6343 });
  console.log('  sFlow collector + aggregator started');

  // Start gNMI subscriber
  if (gnmiConfig && gnmiConfig.enabled) {
    const allDevices = deviceStore.getAllRaw();
    gnmiSubscriber.start(allDevices);
    counterRates.start();
    console.log('  Bandwidth rate engine started (5s broadcast interval)');
  } else {
    console.log('  gNMI subscriber disabled in config');
  }
});

// ---------------------------------------------------------------------------
// Graceful Shutdown — kill gnmic subprocesses on exit
// ---------------------------------------------------------------------------
function gracefulShutdown(signal) {
  console.log(`\n  [ATLAS] ${signal} received — shutting down...`);
  gnmiSubscriber.stop();
  counterRates.stop();
  sflowCollector.stop();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
