require('dotenv').config();
const express = require('express');
const path = require('path');

const deviceRoutes = require('./src/routes/devices');
const topologyRoutes = require('./src/routes/topology');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
app.use('/api/devices', deviceRoutes);
app.use('/api/topology', topologyRoutes);

// ---------------------------------------------------------------------------
// SPA Fallback — serve index.html for any non-API route
// ---------------------------------------------------------------------------
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║          A T L A S   v0.1.0          ║`);
  console.log(`  ║   Topology Visualization Engine       ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  http://localhost:${PORT}               ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
