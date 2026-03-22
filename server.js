require('dotenv').config();
const http = require('http');
const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');

const deviceRoutes = require('./src/routes/devices');
const topologyRoutes = require('./src/routes/topology');
const poller = require('./src/services/poller');

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

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
app.use('/api/devices', deviceRoutes);
app.use('/api/topology', topologyRoutes);

// Poller status endpoint
app.get('/api/status', (_req, res) => {
  res.json(poller.getStatus());
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

const wss = new WebSocketServer({ server, path: '/ws' });

// Track connected clients
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

  // Send current topology immediately on connect
  const topo = poller.getTopology();
  if (topo) {
    ws.send(JSON.stringify({ type: 'topology:updated', data: topo }));
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
poller.on('topology:changed', (topology) => {
  broadcast({ type: 'topology:changed', data: topology });
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
// WebSocket SSH Proxy — /ssh?device=<name>
// ---------------------------------------------------------------------------
const { Client: SshClient } = require('ssh2');
const deviceStore = require('./src/store/devices');

const sshWss = new WebSocketServer({ server, path: '/ssh' });

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
server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║          A T L A S   v0.2.1          ║`);
  console.log(`  ║   Topology Visualization Engine       ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  http://localhost:${PORT}               ║`);
  console.log(`  ║  WebSocket: ws://localhost:${PORT}/ws    ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);

  // Start the background poller
  poller.start();
});
