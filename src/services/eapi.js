// ---------------------------------------------------------------------------
// Arista eAPI Client
// ---------------------------------------------------------------------------
// Communicates with Arista EOS devices via JSON-RPC over HTTPS.
// eAPI endpoint: https://<host>:<port>/command-api
// ---------------------------------------------------------------------------

const axios = require('axios');
const https = require('https');

// Lab devices typically use self-signed certs
const agent = new https.Agent({ rejectUnauthorized: false });

/**
 * Execute one or more EOS commands via eAPI.
 *
 * @param {Object}   device   - Device record from the store (with credentials)
 * @param {string[]} commands - Array of CLI commands to execute
 * @param {string}   format   - 'json' (default) or 'text'
 * @returns {Promise<Object[]>} - Array of command results
 */
async function execute(device, commands, format = 'json') {
  const { host, port = 443, username, password, transport = 'https' } = device;
  const url = `${transport}://${host}:${port}/command-api`;

  const payload = {
    jsonrpc: '2.0',
    method: 'runCmds',
    params: {
      version: 1,
      cmds: commands,
      format,
    },
    id: `atlas-${Date.now()}`,
  };

  try {
    const response = await axios.post(url, payload, {
      auth: { username, password },
      httpsAgent: agent,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.data.error) {
      const err = response.data.error;
      throw new Error(`eAPI error (${err.code}): ${err.message}`);
    }

    return response.data.result;
  } catch (err) {
    if (err.response) {
      throw new Error(`eAPI HTTP ${err.response.status}: ${err.response.statusText}`);
    }
    throw err;
  }
}

/**
 * Test connectivity to a device.
 * Returns { success: true, hostname, version } or { success: false, error }.
 */
async function testConnection(device) {
  try {
    const [result] = await execute(device, ['show hostname', 'show version']);
    return {
      success: true,
      hostname: result.hostname || result.fqdn,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { execute, testConnection };
