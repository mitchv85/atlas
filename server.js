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
const db = require('./src/db');

const gnmiSubscriber = new GnmiSubscriber();

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

// Interface status changes → immediate broadcast
gnmiSubscriber.on('interface:status', (event) => {
  broadcast({ type: 'gnmi:interface:status', data: event });
});

// Interface counter samples → broadcast for live overlays
gnmiSubscriber.on('interface:counters', (event) => {
  broadcast({ type: 'gnmi:interface:counters', data: event });
});

// Device sync complete
gnmiSubscriber.on('device:synced', ({ device }) => {
  broadcast({ type: 'gnmi:device:synced', data: { device } });
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
  sflowCollector.stop();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
