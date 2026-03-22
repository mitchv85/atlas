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

// ── Static path routes BEFORE :id routes ─────────────────────────────

// POST /api/devices/bulk — Bulk import devices
// Body: { devices: [{ name, host, username, password, port?, transport? }, ...] }
router.post('/bulk', (req, res) => {
  const { devices: incoming } = req.body;

  if (!Array.isArray(incoming) || incoming.length === 0) {
    return res.status(400).json({ error: 'devices array is required and must not be empty.' });
  }

  const results = { added: 0, skipped: 0, errors: [] };
  const existing = deviceStore.list();
  const existingNames = new Set(existing.map((d) => d.name.toLowerCase()));

  for (const d of incoming) {
    if (!d.name || !d.host) {
      results.errors.push(`Missing name or host: ${JSON.stringify(d)}`);
      results.skipped++;
      continue;
    }

    if (existingNames.has(d.name.toLowerCase())) {
      results.skipped++;
      continue;
    }

    try {
      deviceStore.add({
        name: d.name,
        host: d.host,
        port: d.port || 443,
        username: d.username || 'admin',
        password: d.password || 'admin',
        transport: d.transport || 'https',
      });
      existingNames.add(d.name.toLowerCase());
      results.added++;
    } catch (err) {
      results.errors.push(`${d.name}: ${err.message}`);
    }
  }

  res.json(results);
});

// POST /api/devices/by-hostname/:hostname/command — Execute command by hostname
router.post('/by-hostname/:hostname/command', async (req, res) => {
  const hostname = req.params.hostname;
  const allDevices = deviceStore.getAllRaw();
  const device = allDevices.find(
    (d) => d.name.toLowerCase() === hostname.toLowerCase()
  );

  if (!device) {
    return res.status(404).json({
      error: `No configured device matches hostname "${hostname}". Add it to atlas.config.json.`,
    });
  }

  const { cmd, format = 'text' } = req.body;
  if (!cmd) return res.status(400).json({ error: 'cmd is required' });

  const trimmed = cmd.trim().toLowerCase();
  if (!trimmed.startsWith('show ')) {
    return res.status(400).json({ error: 'Only show commands are permitted.' });
  }

  try {
    const results = await eapi.execute(device, ['enable', cmd.trim()], format);
    const output = format === 'json'
      ? JSON.stringify(results[1], null, 2)
      : results[1]?.output || '(no output)';

    res.json({ output, error: null, device: device.name });
  } catch (err) {
    res.json({ output: null, error: err.message });
  }
});

// ── Parameterized :id routes ─────────────────────────────────────────

// DELETE /api/devices/:id — Remove a device
router.delete('/:id', (req, res) => {
  const removed = deviceStore.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Device not found' });
  res.json({ success: true });
});

// PUT /api/devices/:id — Update a device
router.put('/:id', (req, res) => {
  const updated = deviceStore.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Device not found' });
  res.json(updated);
});

// POST /api/devices/:id/test — Test connectivity to a device
router.post('/:id/test', async (req, res) => {
  const device = deviceStore.getRaw(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const result = await eapi.testConnection(device);
  res.json(result);
});

// POST /api/devices/:id/command — Execute a show command on a device
// Body: { cmd: "show ...", format: "text" | "json" }
router.post('/:id/command', async (req, res) => {
  const device = deviceStore.getRaw(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const { cmd, format = 'text' } = req.body;
  if (!cmd) return res.status(400).json({ error: 'cmd is required' });

  const trimmed = cmd.trim().toLowerCase();
  if (!trimmed.startsWith('show ')) {
    return res.status(400).json({ error: 'Only show commands are permitted.' });
  }

  try {
    const results = await eapi.execute(device, ['enable', cmd.trim()], format);
    const output = format === 'json'
      ? JSON.stringify(results[1], null, 2)
      : results[1]?.output || '(no output)';

    res.json({ output, error: null });
  } catch (err) {
    res.json({ output: null, error: err.message });
  }
});

module.exports = router;
