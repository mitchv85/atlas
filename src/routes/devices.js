// ---------------------------------------------------------------------------
// Device Management Routes — /api/devices
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const deviceStore = require('../store/devices');
const eapi = require('../services/eapi');

// GET /api/devices — List all devices
router.get('/', (_req, res) => {
  res.json(deviceStore.list());
});

// POST /api/devices — Add a new device
router.post('/', (req, res) => {
  const { name, host, port, username, password, transport } = req.body;

  if (!name || !host || !username || !password) {
    return res.status(400).json({
      error: 'Missing required fields: name, host, username, password',
    });
  }

  const device = deviceStore.add({ name, host, port, username, password, transport });
  res.status(201).json(device);
});

// DELETE /api/devices/:id — Remove a device
router.delete('/:id', (req, res) => {
  const removed = deviceStore.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Device not found' });
  res.json({ success: true });
});

// POST /api/devices/:id/test — Test connectivity to a device
router.post('/:id/test', async (req, res) => {
  const device = deviceStore.getRaw(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const result = await eapi.testConnection(device);
  res.json(result);
});

module.exports = router;
