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
