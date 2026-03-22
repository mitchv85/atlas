// ---------------------------------------------------------------------------
// ATLAS — Main Application
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────
  let devices = [];
  let topologyData = null;
  let currentPathResult = null;
  const topo = new TopologyRenderer('cy');
  const socket = new AtlasSocket();

  // ── DOM References ────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const btnCollect = $('#btnCollect');
  const btnEmptyAddDevice = $('#btnEmptyAddDevice');
  const emptyState = $('#emptyState');
  const topoToolbar = $('#topoToolbar');
  const detailPanel = $('#detailPanel');
  const detailTitle = $('#detailTitle');
  const detailBody = $('#detailBody');
  const btnCloseDetail = $('#btnCloseDetail');
  const statusDot = $('.status-dot');
  const statusText = $('.status-text');

  // Tabs
  const mainTabs = document.querySelectorAll('.topbar-tab');
  const viewTopology = $('#viewTopology');
  const viewDevices = $('#viewDevices');

  // Devices page — use containers, re-query children as needed
  const devicesTableView = $('#devicesTableView');
  const devicesDetailView = $('#devicesDetailView');
  const btnRefreshDevices = $('#btnRefreshDevices');
  const btnExportDevices = $('#btnExportDevices');
  const btnTestAll = $('#btnTestAll');
  const btnAddDevice = $('#btnAddDevice');
  const addDeviceError = $('#addDeviceError');
  const devicesDropzone = $('#devicesDropzone');
  const devicesFileInput = $('#devicesFileInput');
  const importStatus = $('#importStatus');

  // Legacy modal (kept for backward compat)
  const deviceModal = $('#deviceModal');
  const btnCloseModal = $('#btnCloseModal');
  const addDeviceForm = $('#addDeviceForm');
  const deviceList = $('#deviceList');

  // Path analysis
  const pathBar = $('#pathBar');
  const pathSource = $('#pathSource');
  const pathDest = $('#pathDest');
  const pathFailNode = $('#pathFailNode');
  const pathFailLink = $('#pathFailLink');
  const pathAlgo = $('#pathAlgo');
  const btnComputePath = $('#btnComputePath');
  const btnClearPath = $('#btnClearPath');

  // ── Tab Switching ───────────────────────────────────────────────
  let activeTab = 'topology';
  const deviceTestResults = new Map(); // id → 'ok' | 'fail' | 'testing'
  let deviceInfo = {};                  // name → { model, serial, eosVersion, ... }
  let selectedDeviceId = null;          // currently viewed device detail

  function switchTab(tabName) {
    activeTab = tabName;
    mainTabs.forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });
    viewTopology.classList.toggle('active', tabName === 'topology');
    viewDevices.classList.toggle('active', tabName === 'devices');

    // Show/hide path bar and collect button based on tab
    if (pathBar) pathBar.style.display = tabName === 'topology' && topologyData ? 'flex' : 'none';
    if (btnCollect) btnCollect.style.display = tabName === 'topology' ? '' : 'none';

    if (tabName === 'devices') {
      refreshDevicesPage();
    }
  }

  // ── Devices Page ────────────────────────────────────────────────
  async function refreshDevicesPage() {
    const list = await API.getDevices();
    devices = list;
    btnCollect.disabled = devices.length === 0;

    if (selectedDeviceId) {
      const dev = devices.find((d) => d.id === selectedDeviceId);
      if (dev) {
        showDeviceDetail(dev);
        return;
      }
      selectedDeviceId = null;
    }

    // Show table view, hide detail view
    devicesTableView.style.display = '';
    devicesDetailView.style.display = 'none';

    renderDevicesTable(list);

    // Fetch device info in background
    API.getDeviceInfo().then((info) => {
      deviceInfo = info;
      if (!selectedDeviceId) renderDevicesTable(devices);
    }).catch(() => {});
  }

  function renderDevicesTable(list) {
    // Re-query mutable DOM children each time
    const tbody = document.getElementById('devicesTableBody');
    const empty = document.getElementById('devicesEmpty');
    const count = document.getElementById('devicesCount');
    if (!tbody || !count) return;

    count.textContent = `${list.length} device${list.length !== 1 ? 's' : ''}`;

    if (list.length === 0) {
      empty.classList.add('visible');
      tbody.innerHTML = '';
      return;
    }

    empty.classList.remove('visible');

    tbody.innerHTML = list.map((d) => {
      const testState = deviceTestResults.get(d.id) || 'unknown';
      const dotClass = testState === 'ok' ? 'ok' : testState === 'fail' ? 'fail' : testState === 'testing' ? 'testing' : '';
      const statusLabel = testState === 'ok' ? 'Reachable' : testState === 'fail' ? 'Unreachable' : testState === 'testing' ? 'Testing...' : '—';
      const info = deviceInfo[d.name] || {};
      const infoCell = (val) => val && val !== '—' ? esc(val) : '<span style="color:var(--text-muted);">—</span>';

      return `<tr data-id="${d.id}" class="dev-row-clickable">
        <td><strong>${esc(d.name)}</strong></td>
        <td>${esc(d.host)}</td>
        <td>${infoCell(info.model)}</td>
        <td>${infoCell(info.eosVersion)}</td>
        <td>${infoCell(info.serial)}</td>
        <td>${infoCell(info.chipset)}</td>
        <td>${infoCell(info.fwdAgent)}</td>
        <td>
          <span class="dev-status">
            <span class="dev-status-dot ${dotClass}"></span>
            ${statusLabel}
          </span>
        </td>
        <td>
          <div class="dev-actions">
            <button class="dev-action-btn dev-test-btn" data-id="${d.id}" title="Test connectivity">⚡ Test</button>
            <button class="dev-action-btn danger dev-delete-btn" data-id="${d.id}" title="Delete device">✕</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    // Wire action buttons
    tbody.querySelectorAll('.dev-test-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        testSingleDevice(btn.dataset.id);
      });
    });

    tbody.querySelectorAll('.dev-delete-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteDevice(btn.dataset.id);
      });
    });

    // Wire row clicks for device detail
    tbody.querySelectorAll('.dev-row-clickable').forEach((row) => {
      row.addEventListener('click', () => {
        const dev = devices.find((d) => d.id === row.dataset.id);
        if (dev) showDeviceDetail(dev);
      });
    });
  }

  async function testSingleDevice(id) {
    deviceTestResults.set(id, 'testing');
    renderDevicesTable(devices);
    try {
      const result = await API.testDevice(id);
      deviceTestResults.set(id, result.success ? 'ok' : 'fail');
    } catch {
      deviceTestResults.set(id, 'fail');
    }
    renderDevicesTable(devices);
  }

  async function testAllDevices() {
    for (const d of devices) {
      deviceTestResults.set(d.id, 'testing');
    }
    renderDevicesTable(devices);

    await Promise.all(devices.map(async (d) => {
      try {
        const result = await API.testDevice(d.id);
        deviceTestResults.set(d.id, result.success ? 'ok' : 'fail');
      } catch {
        deviceTestResults.set(d.id, 'fail');
      }
      renderDevicesTable(devices);
    }));
  }

  async function deleteDevice(id) {
    const device = devices.find((d) => d.id === id);
    if (!device || !confirm(`Delete ${device.name}?`)) return;
    await API.deleteDevice(id);
    deviceTestResults.delete(id);
    await refreshDevicesPage();
  }

  async function addDeviceFromForm() {
    addDeviceError.textContent = '';
    const name = $('#addDevName').value.trim();
    const host = $('#addDevHost').value.trim();
    const username = $('#addDevUser').value.trim();
    const password = $('#addDevPass').value;
    const port = parseInt($('#addDevPort').value, 10) || 443;

    if (!name) return addDeviceError.textContent = 'Name is required';
    if (!host) return addDeviceError.textContent = 'Host / IP is required';
    if (!username) return addDeviceError.textContent = 'Username is required';

    const result = await API.addDevice({ name, host, username, password, port, transport: 'https' });
    if (result.error) return addDeviceError.textContent = result.error;

    // Clear form
    $('#addDevName').value = '';
    $('#addDevHost').value = '';
    await refreshDevicesPage();
  }

  // ── Bulk Import ─────────────────────────────────────────────────
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const devices = [];

    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map((v) => v.trim().replace(/^["']|["']$/g, ''));
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
      if (obj.name && obj.host) devices.push(obj);
    }

    return devices;
  }

  async function handleBulkImport(file) {
    importStatus.textContent = '';
    importStatus.className = 'devices-import-status';

    try {
      const text = await file.text();
      let incoming;

      if (file.name.endsWith('.json')) {
        const parsed = JSON.parse(text);
        incoming = Array.isArray(parsed) ? parsed : parsed.devices || [];
      } else {
        incoming = parseCSV(text);
      }

      if (incoming.length === 0) {
        importStatus.textContent = 'No valid devices found in file.';
        importStatus.classList.add('error');
        return;
      }

      const result = await API.bulkImportDevices(incoming);
      importStatus.textContent = `Imported ${result.added} device(s), ${result.skipped} skipped.`;
      importStatus.classList.add(result.added > 0 ? 'success' : 'error');

      if (result.added > 0) await refreshDevicesPage();
    } catch (err) {
      importStatus.textContent = `Import error: ${err.message}`;
      importStatus.classList.add('error');
    }
  }

  function exportDevicesCSV() {
    const headers = ['name', 'host', 'username', 'port', 'transport'];
    const rows = devices.map((d) =>
      [d.name, d.host, d.username || 'admin', d.port, d.transport].map((v) => `"${v || ''}"`).join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `atlas-devices-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  // ── Device Detail View ──────────────────────────────────────────
  let deviceDetailTab = 'overview';

  function showDeviceDetail(device) {
    selectedDeviceId = device.id;

    // Toggle containers
    devicesTableView.style.display = 'none';
    devicesDetailView.style.display = '';

    const info = deviceInfo[device.name] || {};
    const testState = deviceTestResults.get(device.id) || 'unknown';
    const dotClass = testState === 'ok' ? 'ok' : testState === 'fail' ? 'fail' : '';

    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'commands', label: 'Quick Commands' },
      { id: 'flash', label: 'Flash' },
      { id: 'ssh', label: 'SSH' },
    ];

    const infoFields = [
      { label: 'MGMT IP', value: device.host },
      { label: 'MODEL', value: info.model },
      { label: 'SERIAL', value: info.serial },
      { label: 'SYSTEM MAC', value: info.systemMac },
      { label: 'EOS VERSION', value: info.eosVersion },
      { label: 'ARCH', value: info.arch },
      { label: 'FWD AGENT', value: info.fwdAgent },
      { label: 'CHIPSET', value: info.chipset },
    ];

    devicesDetailView.innerHTML = `
      <!-- Header -->
      <div class="device-detail-header">
        <button class="btn btn-ghost btn-sm" id="btnDevDetailBack">← Back</button>
        <div class="device-detail-identity">
          <span class="dev-status-dot ${dotClass}" style="width:10px;height:10px;"></span>
          <h2>${esc(device.name)}</h2>
          <span class="device-detail-host">${esc(device.host)}:${device.port}</span>
        </div>
      </div>

      <!-- Sub-tabs -->
      <div class="device-detail-tabs">
        ${tabs.map((t) => `
          <button class="device-detail-tab ${t.id === deviceDetailTab ? 'active' : ''}" data-dtab="${t.id}">${t.label}</button>
        `).join('')}
      </div>

      <!-- Tab content -->
      <div id="deviceDetailContent"></div>
    `;

    // Wire back button
    devicesDetailView.querySelector('#btnDevDetailBack').addEventListener('click', () => {
      // Clean up SSH if active
      const content = devicesDetailView.querySelector('#deviceDetailContent');
      if (content?._sshCleanup) { content._sshCleanup(); content._sshCleanup = null; }
      selectedDeviceId = null;
      deviceDetailTab = 'overview';
      devicesDetailView.style.display = 'none';
      devicesTableView.style.display = '';
      renderDevicesTable(devices);
    });

    // Wire sub-tabs
    devicesDetailView.querySelectorAll('.device-detail-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        deviceDetailTab = btn.dataset.dtab;
        showDeviceDetail(device);
      });
    });

    const content = devicesDetailView.querySelector('#deviceDetailContent');

    // Clean up previous SSH session if switching away
    if (content._sshCleanup) {
      content._sshCleanup();
      content._sshCleanup = null;
    }

    if (deviceDetailTab === 'overview') {
      renderDeviceOverview(content, device, infoFields);
    } else if (deviceDetailTab === 'commands') {
      renderDeviceCommands(content, device);
    } else if (deviceDetailTab === 'flash') {
      renderDeviceFlash(content, device);
    } else if (deviceDetailTab === 'ssh') {
      renderDeviceSSH(content, device);
    }
  }

  function renderDeviceOverview(container, device, infoFields) {
    container.innerHTML = `
      <!-- Info cards -->
      <div class="device-info-grid">
        ${infoFields.map(({ label, value }) => `
          <div class="device-info-card">
            <div class="device-info-label">${label}</div>
            <div class="device-info-value">${value && value !== '—' ? esc(value) : '<span style="color:var(--text-muted);">—</span>'}</div>
          </div>
        `).join('')}
      </div>

      <!-- Running Config -->
      <div class="device-config-section">
        <div class="device-config-toolbar">
          <span class="device-config-title">RUNNING CONFIGURATION</span>
          <div class="device-config-actions">
            <input type="text" class="cli-input" id="configFind" placeholder="Find..." style="width:120px;font-size:0.72rem;" />
            <span id="configFindCount" style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-muted);min-width:50px;"></span>
            <button class="btn btn-ghost btn-sm" id="configFindPrev" style="display:none;">↑</button>
            <button class="btn btn-ghost btn-sm" id="configFindNext" style="display:none;">↓</button>
            <button class="btn btn-ghost btn-sm" id="configCopy">Copy</button>
          </div>
        </div>
        <div class="device-config-body" id="configBody">
          <div class="cli-output-empty">Loading running configuration...</div>
        </div>
      </div>
    `;

    // Fetch config
    let configText = '';
    let findText = '';
    let findIdx = 0;

    API.getDeviceConfig(device.id).then((result) => {
      if (result.error) {
        container.querySelector('#configBody').innerHTML =
          `<div class="cli-output-error">ERROR: ${esc(result.error)}</div>`;
        return;
      }

      configText = result.config || '';
      renderConfig();
    });

    function renderConfig() {
      const body = container.querySelector('#configBody');
      const lines = configText.split('\n');
      const lowerFind = findText.toLowerCase();
      const matches = [];

      if (findText) {
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(lowerFind)) matches.push(i);
        });
      }

      const countEl = container.querySelector('#configFindCount');
      const prevBtn = container.querySelector('#configFindPrev');
      const nextBtn = container.querySelector('#configFindNext');

      if (findText) {
        countEl.textContent = matches.length ? `${Math.min(findIdx + 1, matches.length)} / ${matches.length}` : 'NO MATCH';
        countEl.style.color = matches.length ? 'var(--text-secondary)' : 'var(--red)';
        prevBtn.style.display = '';
        nextBtn.style.display = '';
      } else {
        countEl.textContent = `${lines.length} lines`;
        prevBtn.style.display = 'none';
        nextBtn.style.display = 'none';
      }

      body.innerHTML = `<pre style="margin:0;font-family:'JetBrains Mono',monospace;font-size:0.72rem;line-height:1.6;">${
        lines.map((line, i) => {
          const isCurrent = matches[findIdx] === i;
          const isMatch = findText && line.toLowerCase().includes(lowerFind);
          const bg = isCurrent ? 'rgba(245,158,11,0.12)' : 'transparent';
          const color = colorConfigLine(line);
          let rendered = esc(line) || ' ';

          if (isMatch && findText) {
            const re = new RegExp('(' + escRegex(findText) + ')', 'gi');
            rendered = esc(line).replace(re, isCurrent
              ? '<span style="background:#f59e0b;color:#000;border-radius:2px;padding:0 1px;">$1</span>'
              : '<span style="background:#78350f;color:#fcd34d;border-radius:2px;padding:0 1px;">$1</span>');
          }

          return '<div data-line="' + i + '" style="background:' + bg + ';border-radius:2px;"><span style="color:' + color + ';">' + rendered + '</span></div>';
        }).join('')
      }</pre>`;

      // Scroll to current match
      if (matches.length > 0) {
        const target = body.querySelector(`[data-line="${matches[findIdx]}"]`);
        if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    function colorConfigLine(line) {
      if (/^!/.test(line)) return 'var(--text-muted)';
      if (/^(interface|router|vrf|policy-map|class-map|ip access-list|route-map|spanning-tree|mpls|segment-routing|evpn)/.test(line)) return 'var(--accent)';
      if (/^\s+(ip address|ipv6 address|description|shutdown|no shutdown|mtu|isis|ospf|bgp|evpn|neighbor|network|redistribute)/.test(line)) return '#a78bfa';
      if (/^\s+no /.test(line)) return '#f87171';
      return 'var(--text-primary)';
    }

    function escRegex(str) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Wire find
    const findInput = container.querySelector('#configFind');
    findInput.addEventListener('input', () => {
      findText = findInput.value;
      findIdx = 0;
      if (configText) renderConfig();
    });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.shiftKey ? findIdx-- : findIdx++;
        const lines = configText.split('\n');
        const matches = lines.reduce((acc, l, i) => {
          if (l.toLowerCase().includes(findText.toLowerCase())) acc.push(i);
          return acc;
        }, []);
        if (matches.length) {
          findIdx = ((findIdx % matches.length) + matches.length) % matches.length;
        }
        renderConfig();
      }
    });

    container.querySelector('#configFindPrev').addEventListener('click', () => {
      findIdx--;
      const lines = configText.split('\n');
      const matches = lines.reduce((acc, l, i) => {
        if (l.toLowerCase().includes(findText.toLowerCase())) acc.push(i);
        return acc;
      }, []);
      if (matches.length) findIdx = ((findIdx % matches.length) + matches.length) % matches.length;
      renderConfig();
    });

    container.querySelector('#configFindNext').addEventListener('click', () => {
      findIdx++;
      const lines = configText.split('\n');
      const matches = lines.reduce((acc, l, i) => {
        if (l.toLowerCase().includes(findText.toLowerCase())) acc.push(i);
        return acc;
      }, []);
      if (matches.length) findIdx = findIdx % matches.length;
      renderConfig();
    });

    // Wire copy
    container.querySelector('#configCopy').addEventListener('click', async () => {
      if (!configText) return;
      const btn = container.querySelector('#configCopy');
      try {
        await navigator.clipboard.writeText(configText);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = configText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  }

  function renderDeviceCommands(container, device) {
    const quickPicks = [
      { label: 'show isis neighbors', fmt: 'text' },
      { label: 'show isis database detail', fmt: 'text' },
      { label: 'show isis segment-routing tunnel', fmt: 'text' },
      { label: 'show tunnel fib', fmt: 'text' },
      { label: 'show isis ti-lfa path detail', fmt: 'text' },
      { label: 'show mpls lfib route', fmt: 'text' },
      { label: 'show interfaces status', fmt: 'text' },
      { label: 'show interfaces counters errors', fmt: 'text' },
      { label: 'show ip interface brief', fmt: 'text' },
      { label: 'show ip route summary', fmt: 'text' },
      { label: 'show ip bgp summary', fmt: 'text' },
      { label: 'show bgp evpn summary', fmt: 'text' },
      { label: 'show version', fmt: 'text' },
      { label: 'show log last 50', fmt: 'text' },
    ];

    container.innerHTML = `
      <div class="cli-section" style="margin-top:0;padding-top:0;border-top:none;">
        <div class="cli-input-row">
          <input type="text" class="cli-input" id="devCmdInput" placeholder="show ... (↑↓ for history)" />
          <select class="cli-format-select" id="devCmdFormat">
            <option value="text">text</option>
            <option value="json">json</option>
          </select>
          <button class="cli-run-btn" id="devCmdRun">▶ RUN</button>
        </div>
        <div class="cli-quick-picks">
          <span class="cli-quick-label">QUICK:</span>
          ${quickPicks.map((qp) =>
            `<button class="cli-quick-btn" data-cmd="${esc(qp.label)}" data-fmt="${qp.fmt}">${esc(qp.label)}</button>`
          ).join('')}
        </div>
        <div class="cli-output-header" id="devCmdHeader" style="display:none;">
          <button class="btn btn-ghost btn-sm" id="devCmdCopy">Copy</button>
        </div>
        <div class="cli-output" id="devCmdOutput">
          <div class="cli-output-empty">ENTER A COMMAND OR CLICK A QUICK PICK</div>
        </div>
      </div>
    `;

    const cmdInput = container.querySelector('#devCmdInput');
    const cmdFormat = container.querySelector('#devCmdFormat');
    const cmdRun = container.querySelector('#devCmdRun');
    const cmdOutput = container.querySelector('#devCmdOutput');
    const cmdHeader = container.querySelector('#devCmdHeader');
    const cmdCopy = container.querySelector('#devCmdCopy');

    const history = [];
    let histIdx = -1;
    let lastOutput = '';

    const runCommand = async (cmd, fmt) => {
      cmd = cmd || cmdInput.value;
      fmt = fmt || cmdFormat.value;
      if (!cmd.trim()) return;

      const idx = history.indexOf(cmd);
      if (idx > -1) history.splice(idx, 1);
      history.unshift(cmd);
      histIdx = -1;

      cmdRun.disabled = true;
      cmdRun.textContent = '...';
      cmdOutput.innerHTML = '<div class="cli-output-empty">Running...</div>';
      cmdHeader.style.display = 'none';
      lastOutput = '';

      try {
        const result = await API.runCommand(device.name, cmd.trim(), fmt);
        if (result.error) {
          cmdOutput.innerHTML = `<div class="cli-output-error">ERROR: ${esc(result.error)}</div>`;
        } else {
          lastOutput = result.output || '(no output)';
          cmdOutput.innerHTML = `<pre>${esc(lastOutput)}</pre>`;
          cmdHeader.style.display = 'flex';
        }
      } catch (err) {
        cmdOutput.innerHTML = `<div class="cli-output-error">ERROR: ${esc(err.message)}</div>`;
      }

      cmdRun.disabled = false;
      cmdRun.textContent = '▶ RUN';
    };

    cmdRun.addEventListener('click', () => runCommand());

    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { runCommand(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); histIdx = Math.min(histIdx + 1, history.length - 1); cmdInput.value = history[histIdx] || ''; }
      if (e.key === 'ArrowDown') { e.preventDefault(); histIdx = Math.max(histIdx - 1, -1); cmdInput.value = histIdx === -1 ? '' : history[histIdx]; }
    });

    container.querySelectorAll('.cli-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        cmdInput.value = btn.dataset.cmd;
        cmdFormat.value = btn.dataset.fmt;
        runCommand(btn.dataset.cmd, btn.dataset.fmt);
      });
    });

    cmdCopy.addEventListener('click', async () => {
      if (!lastOutput) return;
      try { await navigator.clipboard.writeText(lastOutput); } catch {
        const ta = document.createElement('textarea');
        ta.value = lastOutput; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      }
      cmdCopy.textContent = 'Copied!';
      setTimeout(() => { cmdCopy.textContent = 'Copy'; }, 1500);
    });
  }

  // ── Flash Tab ───────────────────────────────────────────────────
  function renderDeviceFlash(container, device) {
    let currentPath = '';
    const pathStack = [];

    container.innerHTML = `
      <div class="flash-nav">
        <div class="flash-breadcrumb" id="flashBreadcrumb">
          <span class="flash-crumb flash-crumb-root" data-idx="-1">flash:</span>
        </div>
        <div class="flash-toolbar-right">
          <button class="btn btn-ghost btn-sm" id="flashRefresh">⟳ Refresh</button>
        </div>
      </div>
      <div class="flash-listing" id="flashListing">
        <div class="cli-output-empty">Loading...</div>
      </div>
    `;

    async function loadDir(path) {
      const listing = container.querySelector('#flashListing');
      listing.innerHTML = '<div class="cli-output-empty">Loading...</div>';

      const flashPath = path ? `flash:/${path}` : 'flash:';
      const cmd = `dir ${flashPath}`;

      try {
        const result = await API.runCommand(device.name, cmd, 'text');
        if (result.error) {
          listing.innerHTML = `<div class="cli-output-error">ERROR: ${esc(result.error)}</div>`;
          return;
        }

        const entries = parseDirOutput(result.output || '');
        renderFlashListing(listing, entries);
      } catch (err) {
        listing.innerHTML = `<div class="cli-output-error">ERROR: ${esc(err.message)}</div>`;
      }
    }

    function parseDirOutput(text) {
      const entries = [];
      for (const line of text.split('\n')) {
        // Match lines like: -rwx  145637376  May 11 2025 17:25:34  EOS-4.33.2F-DPE.swi
        // Or: drwx      4096  Mar 20 2025 17:22:08  .boot-config
        const m = line.match(/^\s*([d-][rwx-]{3})\s+(\d+)\s+(\w+\s+\d+\s+\d+\s+[\d:]+)\s+(.+)$/);
        if (m) {
          const isDir = m[1].startsWith('d');
          const name = m[4].trim();
          if (name === '.' || name === '..') continue;
          entries.push({
            type: isDir ? 'dir' : 'file',
            name,
            size: parseInt(m[2], 10),
            date: m[3].trim(),
          });
        }
      }
      // Sort: dirs first, then by name
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return entries;
    }

    function humanSize(bytes) {
      if (!bytes) return '—';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0, n = bytes;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
    }

    function fileIcon(entry) {
      if (entry.type === 'dir') return '📁';
      const ext = entry.name.split('.').pop().toLowerCase();
      if (['swi', 'swix'].includes(ext)) return '💿';
      if (['log'].includes(ext)) return '📜';
      if (['cfg', 'conf', 'config'].includes(ext)) return '⚙️';
      if (['json'].includes(ext)) return '📋';
      return '📄';
    }

    function renderFlashListing(listingEl, entries) {
      if (entries.length === 0) {
        listingEl.innerHTML = '<div class="cli-output-empty">Directory is empty</div>';
        return;
      }

      listingEl.innerHTML = `
        <table class="devices-table flash-table">
          <thead>
            <tr><th></th><th>Name</th><th>Size</th><th>Modified</th></tr>
          </thead>
          <tbody>
            ${entries.map((e) => `
              <tr class="${e.type === 'dir' ? 'flash-dir-row' : ''}" data-name="${esc(e.name)}" data-type="${e.type}">
                <td style="width:28px;text-align:center;">${fileIcon(e)}</td>
                <td>${e.type === 'dir' ? `<strong>${esc(e.name)}/</strong>` : esc(e.name)}</td>
                <td style="white-space:nowrap;">${e.type === 'dir' ? '—' : humanSize(e.size)}</td>
                <td style="white-space:nowrap;">${esc(e.date)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

      // Wire directory clicks
      listingEl.querySelectorAll('.flash-dir-row').forEach((row) => {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          const dirName = row.dataset.name;
          pathStack.push(dirName);
          currentPath = pathStack.join('/');
          updateBreadcrumb();
          loadDir(currentPath);
        });
      });
    }

    function updateBreadcrumb() {
      const bc = container.querySelector('#flashBreadcrumb');
      let html = '<span class="flash-crumb flash-crumb-root" data-idx="-1">flash:</span>';
      pathStack.forEach((dir, idx) => {
        html += ` / <span class="flash-crumb" data-idx="${idx}">${esc(dir)}</span>`;
      });
      bc.innerHTML = html;

      // Wire breadcrumb clicks
      bc.querySelectorAll('.flash-crumb').forEach((crumb) => {
        crumb.style.cursor = 'pointer';
        crumb.addEventListener('click', () => {
          const idx = parseInt(crumb.dataset.idx, 10);
          if (idx === -1) {
            pathStack.length = 0;
          } else {
            pathStack.length = idx + 1;
          }
          currentPath = pathStack.join('/');
          updateBreadcrumb();
          loadDir(currentPath);
        });
      });
    }

    // Wire refresh
    container.querySelector('#flashRefresh').addEventListener('click', () => loadDir(currentPath));

    // Initial load
    loadDir('');
  }

  // ── SSH Tab ──────────────────────────────────────────────────────
  function renderDeviceSSH(container, device) {
    container.innerHTML = `
      <div class="ssh-wrapper">
        <div class="ssh-toolbar">
          <div class="ssh-status">
            <span class="dev-status-dot" id="sshDot"></span>
            <span id="sshStatusText" style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--text-muted);">
              SSH — ${esc(device.name)} (${esc(device.host)})
            </span>
            <span id="sshError" style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--red);"></span>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" id="sshClear">Clear</button>
            <button class="btn btn-ghost btn-sm" id="sshReconnect">⟳ Reconnect</button>
          </div>
        </div>
        <div id="sshTerminal" class="ssh-terminal"></div>
      </div>
    `;

    initSSHSession(container, device);
  }

  function initSSHSession(container, device) {
    const termEl = container.querySelector('#sshTerminal');
    const sshDot = container.querySelector('#sshDot');
    const sshError = container.querySelector('#sshError');

    if (!termEl || typeof Terminal === 'undefined') {
      termEl.innerHTML = '<div class="cli-output-error">xterm.js not loaded. Check network connectivity to CDN.</div>';
      return;
    }

    const term = new Terminal({
      theme: {
        background: '#05070d',
        foreground: '#e2e8f0',
        cursor: '#22d3ee',
        black: '#0f172a', brightBlack: '#475569',
        red: '#f87171', brightRed: '#ef4444',
        green: '#4ade80', brightGreen: '#86efac',
        yellow: '#fbbf24', brightYellow: '#fde68a',
        blue: '#22d3ee', brightBlue: '#93c5fd',
        magenta: '#c084fc', brightMagenta: '#e879f9',
        cyan: '#22d3ee', brightCyan: '#67e8f9',
        white: '#cbd5e1', brightWhite: '#f1f5f9',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termEl);

    // Small delay to let the DOM settle before fitting
    setTimeout(() => fitAddon.fit(), 50);

    // Observe resize
    const ro = new ResizeObserver(() => {
      try { fitAddon.fit(); sendResize(); } catch {}
    });
    ro.observe(termEl);

    // WebSocket connection
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ssh?device=${encodeURIComponent(device.name)}`;
    const ws = new WebSocket(wsUrl);

    term.write(`\r\n\x1b[33mConnecting to ${device.name} (${device.host})...\x1b[0m\r\n`);
    sshDot.className = 'dev-status-dot testing';

    function sendResize() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }));
      }
    }

    ws.onopen = () => {};

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'data') {
          const bin = atob(msg.data);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          term.write(arr);
        } else if (msg.type === 'status') {
          if (msg.data === 'connected') {
            sshDot.className = 'dev-status-dot ok';
            sendResize();
          }
          if (msg.data === 'disconnected') {
            sshDot.className = 'dev-status-dot fail';
            term.write('\r\n\x1b[31m[Session closed]\x1b[0m\r\n');
          }
        } else if (msg.type === 'error') {
          sshDot.className = 'dev-status-dot fail';
          sshError.textContent = msg.data;
          term.write(`\r\n\x1b[31m${msg.data}\x1b[0m\r\n`);
        }
      } catch {}
    };

    ws.onerror = () => {
      sshDot.className = 'dev-status-dot fail';
      sshError.textContent = 'WebSocket connection failed';
    };

    ws.onclose = () => {
      if (sshDot.classList.contains('testing')) {
        sshDot.className = 'dev-status-dot fail';
      }
    };

    // Terminal input → SSH
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data: btoa(unescape(encodeURIComponent(data))) }));
      }
    });

    term.onResize(() => sendResize());

    // Toolbar buttons
    container.querySelector('#sshClear').addEventListener('click', () => term.clear());
    container.querySelector('#sshReconnect').addEventListener('click', () => {
      ws.close();
      term.dispose();
      ro.disconnect();
      renderDeviceSSH(container, device);
    });

    // Cleanup when switching tabs — store disposer on the container
    container._sshCleanup = () => {
      ro.disconnect();
      ws.close();
      term.dispose();
    };
  }

  // ── Init ──────────────────────────────────────────────────────────
  async function init() {
    topo.init();
    topo.onNodeClick = showNodeDetail;
    topo.onEdgeClick = showEdgeDetail;

    // Save positions to server when nodes are dragged
    topo.onNodeDragEnd = (positions) => {
      API.savePositions(positions);
    };

    bindEvents();
    await refreshDevices();

    // Load saved positions before loading topology
    try {
      const savedPositions = await API.getPositions();
      topo.setSavedPositions(savedPositions);
    } catch (e) {
      // No positions saved yet — that's fine
    }

    // Try loading any cached topology (from a prior poll or manual collect)
    const existing = await API.getTopology();
    if (existing) {
      loadTopologyIntoView(existing);
    }

    // Connect WebSocket for real-time updates
    initSocket();
  }

  /**
   * Wire up WebSocket event handlers.
   */
  function initSocket() {
    // Topology changed — full reload
    socket.on('topology:changed', (topology) => {
      loadTopologyIntoView(topology, true); // true = preserve layout
    });

    // Status updates from poller
    socket.on('status', (status) => {
      if (status.collecting) {
        setStatus('collecting', 'Polling...');
      } else if (status.lastError) {
        setStatus('error', `Poll error: ${status.lastError}`);
      } else if (status.nodeCount > 0) {
        setStatus('live', `${status.nodeCount} nodes, ${status.edgeCount} links`);
      }
    });

    // Connection state
    socket.on('connection', ({ status }) => {
      const dot = document.querySelector('.status-dot');
      if (status === 'websocket') {
        dot.title = 'WebSocket connected';
      } else if (status === 'polling') {
        dot.title = 'Polling fallback';
      } else {
        dot.title = 'Disconnected';
      }
    });

    socket.connect();
  }

  // ── Event Binding ─────────────────────────────────────────────────
  function bindEvents() {
    // Tab navigation
    mainTabs.forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // "Add Your First Device" button switches to Devices tab
    btnEmptyAddDevice.addEventListener('click', () => switchTab('devices'));

    // Legacy modal handlers (still used if modal HTML exists)
    if (btnCloseModal) btnCloseModal.addEventListener('click', closeDeviceModal);
    if (deviceModal) deviceModal.addEventListener('click', (e) => {
      if (e.target === deviceModal) closeDeviceModal();
    });
    if (addDeviceForm) addDeviceForm.addEventListener('submit', handleAddDevice);

    btnCollect.addEventListener('click', handleCollect);
    btnCloseDetail.addEventListener('click', closeDetail);

    // Topology toolbar
    $('#btnFit').addEventListener('click', () => topo.fit());
    $('#btnZoomIn').addEventListener('click', () => topo.zoomIn());
    $('#btnZoomOut').addEventListener('click', () => topo.zoomOut());
    $('#btnLayoutCose').addEventListener('click', () => topo.runLayout('cose'));

    // Path analysis
    btnComputePath.addEventListener('click', handleComputePath);
    btnClearPath.addEventListener('click', handleClearPath);

    // Mutual exclusion: selecting a node failure clears link failure and vice versa
    pathFailNode.addEventListener('change', () => {
      if (pathFailNode.value) pathFailLink.value = '';
    });
    pathFailLink.addEventListener('change', () => {
      if (pathFailLink.value) pathFailNode.value = '';
    });

    // ── Devices page bindings ───────────────────────────────────
    if (btnAddDevice) btnAddDevice.addEventListener('click', addDeviceFromForm);
    if (btnRefreshDevices) btnRefreshDevices.addEventListener('click', refreshDevicesPage);
    if (btnExportDevices) btnExportDevices.addEventListener('click', exportDevicesCSV);
    if (btnTestAll) btnTestAll.addEventListener('click', testAllDevices);

    // Bulk import — dropzone
    if (devicesDropzone) {
      devicesDropzone.addEventListener('click', () => devicesFileInput.click());
      devicesDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        devicesDropzone.classList.add('dragover');
      });
      devicesDropzone.addEventListener('dragleave', () => {
        devicesDropzone.classList.remove('dragover');
      });
      devicesDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        devicesDropzone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) handleBulkImport(file);
      });
    }
    if (devicesFileInput) {
      devicesFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleBulkImport(file);
        devicesFileInput.value = ''; // Reset so same file can be re-imported
      });
    }

    // Enter key on add device form fields
    ['addDevName', 'addDevHost', 'addDevUser', 'addDevPass', 'addDevPort'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addDeviceFromForm(); }
      });
    });
  }

  // ── Device Management (legacy modal + init helper) ───────────────
  async function refreshDevices() {
    devices = await API.getDevices();
    btnCollect.disabled = devices.length === 0;
    // Also update legacy modal list if it exists
    if (deviceList) renderDeviceList();
  }

  function renderDeviceList() {
    if (!deviceList) return;
    if (devices.length === 0) {
      deviceList.innerHTML = '<p class="text-muted">No devices configured yet.</p>';
      return;
    }

    deviceList.innerHTML = devices
      .map(
        (d) => `
      <div class="device-card" data-id="${d.id}">
        <div class="device-card-info">
          <span class="device-card-name">${esc(d.name)}</span>
          <span class="device-card-host">${esc(d.host)}:${d.port || 443}</span>
        </div>
        <div class="device-card-actions">
          <button class="btn btn-ghost btn-sm btn-test" data-id="${d.id}">Test</button>
          <button class="btn btn-danger btn-sm btn-remove" data-id="${d.id}">Remove</button>
        </div>
      </div>`
      )
      .join('');

    // Bind test/remove buttons
    deviceList.querySelectorAll('.btn-test').forEach((btn) =>
      btn.addEventListener('click', () => handleTestDevice(btn.dataset.id))
    );
    deviceList.querySelectorAll('.btn-remove').forEach((btn) =>
      btn.addEventListener('click', () => handleRemoveDevice(btn.dataset.id))
    );
  }

  async function handleAddDevice(e) {
    e.preventDefault();
    const device = {
      name: $('#devName').value.trim(),
      host: $('#devHost').value.trim(),
      username: $('#devUser').value.trim(),
      password: $('#devPass').value,
      port: parseInt($('#devPort').value) || 443,
    };

    await API.addDevice(device);
    addDeviceForm.reset();
    $('#devPort').value = 443;
    await refreshDevices();
  }

  async function handleRemoveDevice(id) {
    await API.removeDevice(id);
    await refreshDevices();
  }

  async function handleTestDevice(id) {
    const btn = deviceList.querySelector(`.btn-test[data-id="${id}"]`);
    const original = btn.textContent;
    btn.textContent = 'Testing...';
    btn.disabled = true;

    const result = await API.testDevice(id);

    if (result.success) {
      btn.textContent = 'Connected!';
      btn.style.color = 'var(--green)';
    } else {
      btn.textContent = 'Failed';
      btn.style.color = 'var(--red)';
    }

    setTimeout(() => {
      btn.textContent = original;
      btn.style.color = '';
      btn.disabled = false;
    }, 2000);
  }

  // ── Topology Collection ───────────────────────────────────────────
  async function handleCollect() {
    btnCollect.classList.add('loading');
    btnCollect.disabled = true;
    setStatus('collecting', 'Collecting LSDB...');

    try {
      const data = await API.collectTopology();
      loadTopologyIntoView(data);
      setStatus('live', `${data.metadata.nodeCount} nodes, ${data.metadata.edgeCount} links`);
    } catch (err) {
      setStatus('error', `Error: ${err.message}`);
    } finally {
      btnCollect.classList.remove('loading');
      btnCollect.disabled = false;
    }
  }

  function loadTopologyIntoView(data, preserveLayout = false) {
    const hadTopology = !!topologyData;
    topologyData = data;
    emptyState.classList.add('hidden');
    topoToolbar.style.display = 'flex';
    pathBar.style.display = 'flex';

    if (preserveLayout && hadTopology) {
      // Smart update: refresh data without resetting the layout.
      // Save current positions, reload data, restore positions.
      const positions = {};
      topo.cy.nodes().forEach((n) => {
        positions[n.id()] = { ...n.position() };
      });

      // Also merge into saved positions cache
      topo.setSavedPositions({ ...topo._savedPositions, ...positions });

      topo.cy.elements().remove();
      topo.cy.add(data.nodes);
      topo.cy.add(data.edges);

      // Restore known positions; new nodes get auto-placed
      topo.cy.nodes().forEach((n) => {
        if (positions[n.id()]) {
          n.position(positions[n.id()]);
        }
      });

      // Run layout only if there are new nodes without positions
      const newNodes = topo.cy.nodes().filter((n) => !positions[n.id()]);
      if (newNodes.length > 0) {
        topo.runLayout('cose');
      }
    } else {
      topo.loadTopology({ nodes: data.nodes, edges: data.edges });
    }

    populatePathDropdowns();
  }

  /**
   * Populate the source/destination/failure dropdowns from the topology.
   */
  function populatePathDropdowns() {
    const nodes = topo.getNodeList();

    // Save current selections
    const prevSrc = pathSource.value;
    const prevDst = pathDest.value;
    const prevFail = pathFailNode.value;
    const prevFailLink = pathFailLink.value;

    // Clear and rebuild node dropdowns
    pathSource.innerHTML = '<option value="">Select source...</option>';
    pathDest.innerHTML = '<option value="">Select destination...</option>';
    pathFailNode.innerHTML = '<option value="">None</option>';

    for (const node of nodes) {
      const optSrc = new Option(node.label, node.id);
      const optDst = new Option(node.label, node.id);
      const optFail = new Option(node.label, node.id);
      pathSource.add(optSrc);
      pathDest.add(optDst);
      pathFailNode.add(optFail);
    }

    // Populate link failure dropdown from topology edges
    pathFailLink.innerHTML = '<option value="">None</option>';
    if (topologyData && topologyData.edges) {
      for (const edge of topologyData.edges) {
        const d = edge.data;
        const label = `${d.sourceLabel} ↔ ${d.targetLabel}`;
        const detail = d.localAddr ? ` (${d.localAddr})` : '';
        const opt = new Option(label + detail, d.id);
        pathFailLink.add(opt);
      }
    }

    // Restore selections if still valid
    if (prevSrc && nodes.some(n => n.id === prevSrc)) pathSource.value = prevSrc;
    if (prevDst && nodes.some(n => n.id === prevDst)) pathDest.value = prevDst;
    if (prevFail && nodes.some(n => n.id === prevFail)) pathFailNode.value = prevFail;
    if (prevFailLink) pathFailLink.value = prevFailLink;
  }

  // ── Path Computation ─────────────────────────────────────────────
  async function handleComputePath() {
    const source = pathSource.value;
    const dest = pathDest.value;
    const failNode = pathFailNode.value;
    const failLink = pathFailLink.value;

    if (!source || !dest) {
      setStatus('error', 'Select both source and destination');
      return;
    }

    if (source === dest) {
      setStatus('error', 'Source and destination must be different');
      return;
    }

    btnComputePath.disabled = true;
    btnComputePath.classList.add('loading');

    try {
      // No failure selected — check for ECMP first
      if (!failNode && !failLink) {
        const ecmpResult = await API.computeECMP(source, dest);

        if (ecmpResult.pathCount > 1) {
          // ECMP detected — use ECMP visualization
          currentPathResult = ecmpResult;
          topo.highlightECMP(ecmpResult);
          showECMPDetail(ecmpResult);
          btnClearPath.style.display = 'inline-flex';
          setStatus('live', `ECMP: ${ecmpResult.pathCount} equal-cost paths, metric ${ecmpResult.totalMetric}`);
          return;
        }
      }

      // Single path or failure simulation — existing logic
      const analysis = await API.analyzePath(source, dest);
      currentPathResult = analysis;

      let displayPath;
      let failedNodes = [];
      let failedEdges = [];
      let failureLabel = '';

      if (failNode) {
        const backup = analysis.nodeBackups.find((b) => b.failedNode === failNode);
        if (backup) {
          displayPath = backup.backupPath;
          failureLabel = backup.failedHostname;
        } else {
          const result = await API.computePath(source, dest, [failNode], []);
          displayPath = result.reachable ? result : null;
          failureLabel = getHostname(failNode);
        }
        failedNodes = [failNode];
      } else if (failLink) {
        const backup = analysis.linkBackups.find((b) => b.failedEdgeId === failLink);
        if (backup) {
          displayPath = backup.backupPath;
          failureLabel = backup.failedLinkLabel;
        } else {
          const result = await API.computePath(source, dest, [], [failLink]);
          displayPath = result.reachable ? result : null;
          failureLabel = failLink;
        }
        failedEdges = [failLink];
      } else {
        displayPath = analysis.primary;
      }

      if (displayPath) {
        topo.highlightPath(displayPath, failedNodes, failedEdges);
      } else {
        topo.clearPath();
        if (failedNodes.length > 0 || failedEdges.length > 0) {
          topo.highlightPath(
            analysis.primary || { source, destination: dest, hops: [] },
            failedNodes,
            failedEdges
          );
        }
      }

      showPathDetail(displayPath, analysis, failedNodes, failedEdges, failureLabel);
      btnClearPath.style.display = 'inline-flex';

      if (displayPath) {
        const failSuffix = failureLabel ? ` (${failureLabel} failed)` : '';
        setStatus('live', `Path: ${displayPath.hopCount} hops, metric ${displayPath.totalMetric}${failSuffix}`);
      } else {
        setStatus('error', `Unreachable: ${getHostname(source)} → ${getHostname(dest)} with ${failureLabel} failed`);
      }
    } catch (err) {
      setStatus('error', `Path error: ${err.message}`);
    } finally {
      btnComputePath.disabled = false;
      btnComputePath.classList.remove('loading');
    }
  }

  function handleClearPath() {
    topo.clearPath();
    currentPathResult = null;
    btnClearPath.style.display = 'none';
    closeDetail();
    if (topologyData) {
      setStatus('live', `${topologyData.metadata.nodeCount} nodes, ${topologyData.metadata.edgeCount} links`);
    }
  }

  function getHostname(systemId) {
    if (!topologyData) return systemId;
    const node = topologyData.nodes.find((n) => n.data.id === systemId);
    return node?.data?.hostname || systemId;
  }

  // ── ECMP Detail Panel ────────────────────────────────────────────
  function showECMPDetail(ecmpResult) {
    const srcName = getHostname(pathSource.value);
    const dstName = getHostname(pathDest.value);

    detailTitle.textContent = `${srcName} → ${dstName} (ECMP)`;
    detailBody.innerHTML = buildECMPDetailHTML(ecmpResult);
    detailPanel.classList.add('open');

    // Wire hover-to-isolate on path rows
    const pathRows = detailBody.querySelectorAll('.ecmp-path-row');
    pathRows.forEach((row) => {
      row.addEventListener('mouseenter', () => {
        const idx = parseInt(row.dataset.pathIdx, 10);
        isolateECMPPath(ecmpResult, idx);
      });
      row.addEventListener('mouseleave', () => {
        topo.highlightECMP(ecmpResult);
      });
    });
  }

  function buildECMPDetailHTML(ecmpResult) {
    const colors = ['#22d3ee', '#fbbf24', '#a78bfa', '#fb7185'];

    let html = `
      <div class="path-result-banner">
        <svg class="path-result-icon" viewBox="0 0 20 20" fill="#22d3ee">
          <path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/>
        </svg>
        <span class="path-result-text">
          <strong>ECMP — ${ecmpResult.pathCount} Equal-Cost Paths</strong><br>
          Total metric ${ecmpResult.totalMetric}, Algo 0
        </span>
      </div>`;

    // Color legend with label stacks
    html += `
      <div class="detail-section">
        <h4>Path Legend</h4>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:8px;">
          Hover a path below to isolate it on the topology
        </div>`;

    for (let i = 0; i < ecmpResult.paths.length && i < 4; i++) {
      const path = ecmpResult.paths[i];
      const chain = [path.sourceHostname, ...path.hops.map(h => h.toHostname)];
      const color = colors[i];

      // Extract label stack for this path
      const labelEntry = (path.labelStack && path.labelStack.length > 0) ? path.labelStack[0] : null;
      const labels = labelEntry?.labels || [];

      html += `
        <div class="ecmp-path-row" data-path-idx="${i}" style="
          display:flex;align-items:flex-start;gap:10px;padding:8px 10px;
          background:var(--bg-elevated);border:1px solid var(--border);
          border-radius:var(--radius-sm);margin-bottom:4px;cursor:pointer;
          transition:background 0.15s;
        ">
          <div style="width:12px;height:12px;border-radius:2px;background:${color};flex-shrink:0;margin-top:3px;"></div>
          <div style="flex:1;">
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:${color};">
              ${chain.join(' → ')}
            </div>
            <div style="font-size:0.68rem;color:var(--text-muted);margin-top:2px;">
              ${path.hopCount} hops
            </div>
            ${labels.length > 0 ? `
              <div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:4px;">
                ${labels.map(l => {
                  const decoded = decodeSrLabel(l);
                  return '<span class="detail-badge ' + decoded.color + '" title="' + esc(decoded.description) + '" style="cursor:help;font-size:0.65rem;">' + esc(l) + '</span>';
                }).join('')}
              </div>
              <div style="font-size:0.62rem;color:var(--text-muted);margin-top:2px;">
                ${labels.map(l => decodeSrLabel(l).description).join(' → ')}
              </div>` : ''}
          </div>
        </div>`;
    }

    html += `</div>`;

    // Per-hop breakdown for each path
    html += `
      <div class="detail-section">
        <h4>Hop Details</h4>`;

    for (let i = 0; i < ecmpResult.paths.length && i < 4; i++) {
      const path = ecmpResult.paths[i];
      const color = colors[i];
      const labelEntry = (path.labelStack && path.labelStack.length > 0) ? path.labelStack[0] : null;
      const labels = labelEntry?.labels || [];

      html += `
        <div style="margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <div style="width:8px;height:8px;border-radius:2px;background:${color};"></div>
            <span style="font-size:0.72rem;font-weight:600;color:${color};">Path ${i + 1}</span>
            ${labels.length > 0 ? `<span style="font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--text-muted);">[ ${labels.join(' ')} ]</span>` : ''}
          </div>`;

      // Build a set of labels actually in the stack for filtering
      const labelSet = new Set(labels.map(l => String(l)));

      for (const hop of path.hops) {
        // Only show Adj-SIDs that are actually in the pushed label stack
        const activeAdjSids = (hop.adjSids || []).filter(s => labelSet.has(String(s.sid)));
        const adjSidStr = activeAdjSids.length > 0 ? activeAdjSids.map(s => s.sid).join(', ') : '';
        html += `
          <div style="font-size:0.72rem;color:var(--text-secondary);padding:2px 0 2px 14px;border-left:2px solid ${color}22;">
            ${esc(hop.fromHostname)} → ${esc(hop.toHostname)}
            <span style="color:var(--text-muted);">via ${esc(hop.localAddr || '?')} → ${esc(hop.neighborAddr || '?')}</span>
            ${adjSidStr ? `<span class="detail-badge green" style="font-size:0.65rem;margin-left:4px;">Adj ${adjSidStr}</span>` : ''}
          </div>`;
      }

      html += `</div>`;
    }

    html += `</div>`;

    return html;
  }

  /**
   * Temporarily isolate a single ECMP path (on hover).
   */
  function isolateECMPPath(ecmpResult, pathIdx) {
    topo._clearHighlight();
    const path = ecmpResult.paths[pathIdx];
    if (!path) return;

    // Dim everything
    topo.cy.elements().addClass('path-dimmed');

    // Highlight just this path's nodes and edges
    const nodeIds = new Set([path.source, path.destination]);
    for (const hop of path.hops) {
      nodeIds.add(hop.from);
      nodeIds.add(hop.to);
    }

    for (const nid of nodeIds) {
      const node = topo.cy.getElementById(nid);
      if (node.length) {
        node.removeClass('path-dimmed');
        node.addClass('ecmp-node');
      }
    }

    const src = topo.cy.getElementById(path.source);
    const dst = topo.cy.getElementById(path.destination);
    if (src.length) src.addClass('ecmp-source');
    if (dst.length) dst.addClass('ecmp-dest');

    for (const hop of path.hops) {
      if (!hop.edgeId) continue;
      const edge = topo.cy.getElementById(hop.edgeId);
      if (edge.length) {
        edge.removeClass('path-dimmed');
        edge.addClass('ecmp-path-' + pathIdx);
      }
    }
  }

  // ── Path Detail Panel ──────────────────────────────────────────────
  function showPathDetail(pathData, analysis, failedNodes, failedEdges, failureLabel) {
    const srcName = getHostname(pathSource.value);
    const dstName = getHostname(pathDest.value);

    if (failureLabel) {
      detailTitle.textContent = `${srcName} → ${dstName} (${failureLabel} ✕)`;
    } else {
      detailTitle.textContent = `${srcName} → ${dstName}`;
    }

    detailBody.innerHTML = buildPathDetailHTML(pathData, analysis, failedNodes, failedEdges, failureLabel);
    detailPanel.classList.add('open');

    // Wire up backup section toggles
    const backupHeaders = detailBody.querySelectorAll('.backup-header');
    backupHeaders.forEach((header) => {
      header.addEventListener('click', () => {
        const body = header.nextElementSibling;
        body.classList.toggle('open');
        const toggle = header.querySelector('.backup-toggle');
        toggle.textContent = body.classList.contains('open') ? '▾' : '▸';
      });
    });

    // Wire up "Show on Map" buttons for node failures
    detailBody.querySelectorAll('.btn-show-node-backup').forEach((btn) => {
      btn.addEventListener('click', () => {
        pathFailLink.value = '';
        pathFailNode.value = btn.dataset.failNode;
        handleComputePath();
      });
    });

    // Wire up "Show on Map" buttons for link failures
    detailBody.querySelectorAll('.btn-show-link-backup').forEach((btn) => {
      btn.addEventListener('click', () => {
        pathFailNode.value = '';
        pathFailLink.value = btn.dataset.failEdge;
        handleComputePath();
      });
    });
  }

  function buildPathDetailHTML(pathData, analysis, failedNodes, failedEdges, failureLabel) {
    let html = '';

    // Unreachable state
    if (!pathData) {
      html += `
        <div class="path-result-banner failure">
          <svg class="path-result-icon" viewBox="0 0 20 20" fill="#f87171">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
          </svg>
          <span class="path-result-text"><strong>Unreachable</strong> — destination cannot be reached with <strong>${esc(failureLabel)}</strong> failed</span>
        </div>`;

      if (analysis?.primary) {
        html += `
          <div class="detail-section">
            <h4>Primary Path (no failure)</h4>
            ${buildHopListHTML(analysis.primary)}
          </div>`;
      }

      return html;
    }

    // Result banner
    const isBackup = failedNodes.length > 0 || failedEdges.length > 0;
    const protectionType = failedNodes.length > 0 ? 'Node Protection' : 'Link Protection';
    html += `
      <div class="path-result-banner">
        <svg class="path-result-icon" viewBox="0 0 20 20" fill="${isBackup ? '#fbbf24' : '#22d3ee'}">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
        </svg>
        <span class="path-result-text">
          <strong>${isBackup ? 'TI-LFA Backup (' + protectionType + ')' : 'Primary Path'}</strong> — 
          ${pathData.hopCount} hops, total metric ${pathData.totalMetric}, Algo ${pathData.algorithm}
        </span>
      </div>`;

    // Label stack
    if (pathData.labelStack && pathData.labelStack.length > 0) {
      html += `
        <div class="detail-section">
          <h4>SR Label Stack</h4>`;

      if (pathData.labelStackSource === 'tunnel-fib') {
        // Tunnel FIB format: [{ labels: [...], nexthop, interface, type }]
        for (const entry of pathData.labelStack) {
          const labels = entry.labels || [];
          html += `<div style="margin-bottom:10px;">`;
          if (entry.nexthop) {
            html += `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;">via ${esc(entry.nexthop)} (${esc(entry.interface || '')})</div>`;
          }
          html += `<div style="display:flex;gap:4px;flex-wrap:wrap;">`;
          for (const lbl of labels) {
            const decoded = decodeSrLabel(lbl);
            html += `<span class="detail-badge ${decoded.color}" title="${esc(decoded.description)}" style="cursor:help;">${esc(lbl)}</span>`;
          }
          html += `</div>`;
          if (labels.length > 0) {
            html += `<div style="font-size:0.68rem;color:var(--text-muted);margin-top:4px;">`;
            html += labels.map(l => decodeSrLabel(l).description).join(' → ');
            html += `</div>`;
          }
          html += `</div>`;
        }
      } else {
        // SPF-computed format: [{ label, type, prefix }]
        for (const label of pathData.labelStack) {
          const srgbBase = 900000;
          const globalLabel = srgbBase + label.label;
          html += `
            <div class="detail-row">
              <span class="detail-label">${esc(label.type)} (${esc(label.prefix)})</span>
              <span class="detail-value">
                <span class="detail-badge cyan">SID ${label.label}</span>
                <span class="prefix-metric" style="margin-left:6px;">→ label ${globalLabel}</span>
              </span>
            </div>`;
        }
      }

      html += `</div>`;
    }

    // Hop-by-hop path
    html += `
      <div class="detail-section">
        <h4>Hop-by-Hop Path</h4>
        ${buildHopListHTML(pathData)}
      </div>`;

    // ── TI-LFA Node Protection backups ──
    if (analysis?.nodeBackups && analysis.nodeBackups.length > 0 && !isBackup) {
      html += `
        <div class="backup-section">
          <div class="backup-header">
            <h4>Node Protection Backups</h4>
            <span class="backup-toggle">▸</span>
          </div>
          <div class="backup-body">`;

      for (const backup of analysis.nodeBackups) {
        html += `<div class="backup-item">`;
        html += `<div class="backup-item-header">If <strong>${esc(backup.failedHostname)}</strong> fails:</div>`;

        if (backup.backupPath) {
          const hopNames = [backup.backupPath.sourceHostname];
          for (const hop of backup.backupPath.hops) hopNames.push(hop.toHostname);
          html += `<div class="backup-item-path">${hopNames.join(' → ')}</div>`;
          html += `<div style="margin-top:4px;font-size:0.72rem;color:var(--text-muted);">
            ${backup.backupPath.hopCount} hops, metric ${backup.backupPath.totalMetric}
          </div>`;
          html += `<button class="btn btn-ghost btn-sm btn-show-node-backup" data-fail-node="${backup.failedNode}" style="margin-top:6px;">Show on Map</button>`;
        } else {
          html += `<div class="backup-item-unreachable">Destination unreachable</div>`;
        }

        html += `</div>`;
      }

      html += `</div></div>`;
    }

    // ── TI-LFA Link Protection backups ──
    if (analysis?.linkBackups && analysis.linkBackups.length > 0 && !isBackup) {
      html += `
        <div class="backup-section">
          <div class="backup-header">
            <h4>Link Protection Backups</h4>
            <span class="backup-toggle">▸</span>
          </div>
          <div class="backup-body">`;

      for (const backup of analysis.linkBackups) {
        html += `<div class="backup-item">`;
        html += `<div class="backup-item-header">If link <strong>${esc(backup.failedLinkLabel)}</strong> fails:</div>`;
        if (backup.failedLinkDetail) {
          html += `<div style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;">${esc(backup.failedLinkDetail)}</div>`;
        }

        if (backup.backupPath) {
          const hopNames = [backup.backupPath.sourceHostname];
          for (const hop of backup.backupPath.hops) hopNames.push(hop.toHostname);
          html += `<div class="backup-item-path">${hopNames.join(' → ')}</div>`;
          html += `<div style="margin-top:4px;font-size:0.72rem;color:var(--text-muted);">
            ${backup.backupPath.hopCount} hops, metric ${backup.backupPath.totalMetric}
          </div>`;
          html += `<button class="btn btn-ghost btn-sm btn-show-link-backup" data-fail-edge="${backup.failedEdgeId}" style="margin-top:6px;">Show on Map</button>`;
        } else {
          html += `<div class="backup-item-unreachable">Destination unreachable</div>`;
        }

        html += `</div>`;
      }

      html += `</div></div>`;
    }

    return html;
  }

  function buildHopListHTML(pathData) {
    if (!pathData || !pathData.hops || pathData.hops.length === 0) {
      return '<p class="text-muted">No path data</p>';
    }

    // Build a set of labels actually in the pushed stack for filtering
    const labelSet = new Set();
    if (pathData.labelStack) {
      for (const entry of pathData.labelStack) {
        // Tunnel FIB format: { labels: [...] }
        if (entry.labels) {
          entry.labels.forEach(l => labelSet.add(String(l)));
        }
        // SPF-computed format: { label: N }
        if (entry.label != null) {
          const srgbBase = 900000;
          labelSet.add(String(srgbBase + entry.label));
        }
      }
    }

    let html = '<ul class="path-hops">';

    // Source node
    html += `
      <li class="path-hop">
        <div class="path-hop-dot source"><div class="path-hop-dot-inner"></div></div>
        <div class="path-hop-info">
          <div class="path-hop-name">${esc(pathData.sourceHostname)}</div>
          <div class="path-hop-detail">source</div>
        </div>
      </li>`;

    // Each hop
    for (let i = 0; i < pathData.hops.length; i++) {
      const hop = pathData.hops[i];
      const isLast = i === pathData.hops.length - 1;

      // Only show Adj-SIDs that are actually in the pushed label stack
      const activeAdjSids = (hop.adjSids || []).filter(s => labelSet.has(String(s.sid)));
      const adjSidLabel = activeAdjSids.length > 0
        ? activeAdjSids.map((s) => s.sid).join(', ')
        : '';

      html += `
        <li class="path-hop">
          <div class="path-hop-dot ${isLast ? 'dest' : ''}"></div>
          <div class="path-hop-info">
            <div class="path-hop-name">${esc(hop.toHostname)}</div>
            <div class="path-hop-detail">
              via ${esc(hop.localAddr || '?')} → ${esc(hop.neighborAddr || '?')}, metric ${hop.metric}
            </div>
            ${adjSidLabel ? `<div class="path-hop-label">Adj-SID: ${adjSidLabel}</div>` : ''}
          </div>
        </li>`;
    }

    html += '</ul>';
    return html;
  }

  // ── Detail Panel ──────────────────────────────────────────────────
  async function showNodeDetail(nodeData) {
    detailTitle.textContent = nodeData.hostname || nodeData.label;
    detailBody.innerHTML = buildNodeDetailHTML(nodeData);
    detailPanel.classList.add('open');

    // Async: fetch reachability data and populate the section
    const reachContainer = detailBody.querySelector('#reachabilitySection');
    if (reachContainer) {
      try {
        const reachData = await API.getNodeReachability(nodeData.systemId);
        if (reachData && reachData.entries.length > 0) {
          reachContainer.innerHTML = buildReachabilityHTML(reachData);
          wireReachabilityHandlers(reachContainer, nodeData.systemId);
        } else {
          reachContainer.innerHTML = '<p class="text-muted">No remote Node SIDs found.</p>';
        }
      } catch (err) {
        reachContainer.innerHTML = '<p class="text-muted">Error loading reachability.</p>';
      }
    }

    // Wire CLI panel
    wireCLIPanel(nodeData.hostname);
  }

  /**
   * Wire up the CLI panel event handlers.
   */
  function wireCLIPanel(hostname) {
    const cliInput = detailBody.querySelector('#cliInput');
    const cliFormat = detailBody.querySelector('#cliFormat');
    const cliRunBtn = detailBody.querySelector('#cliRunBtn');
    const cliOutput = detailBody.querySelector('#cliOutput');
    const cliOutputHeader = detailBody.querySelector('#cliOutputHeader');
    const cliCopyBtn = detailBody.querySelector('#cliCopyBtn');

    if (!cliInput || !cliRunBtn || !cliOutput) return;

    // Track last output for copy
    let lastOutput = '';

    // Command history
    const history = [];
    let histIdx = -1;

    const runCommand = async (cmd, fmt) => {
      cmd = cmd || cliInput.value;
      fmt = fmt || cliFormat.value;
      if (!cmd.trim()) return;

      // Add to history
      const idx = history.indexOf(cmd);
      if (idx > -1) history.splice(idx, 1);
      history.unshift(cmd);
      histIdx = -1;

      cliRunBtn.disabled = true;
      cliRunBtn.textContent = '...';
      cliOutput.innerHTML = '<div class="cli-output-empty">Running...</div>';
      cliOutputHeader.style.display = 'none';
      lastOutput = '';

      try {
        const result = await API.runCommand(hostname, cmd.trim(), fmt);
        if (result.error) {
          cliOutput.innerHTML = `<div class="cli-output-error">ERROR: ${esc(result.error)}</div>`;
        } else {
          lastOutput = result.output || '(no output)';
          cliOutput.innerHTML = `<pre>${esc(lastOutput)}</pre>`;
          cliOutputHeader.style.display = 'flex';
        }
      } catch (err) {
        cliOutput.innerHTML = `<div class="cli-output-error">ERROR: ${esc(err.message)}</div>`;
      }

      cliRunBtn.disabled = false;
      cliRunBtn.textContent = '▶ RUN';
    };

    // Copy button
    if (cliCopyBtn) {
      cliCopyBtn.addEventListener('click', async () => {
        if (!lastOutput) return;
        try {
          await navigator.clipboard.writeText(lastOutput);
          cliCopyBtn.textContent = 'Copied!';
          setTimeout(() => { cliCopyBtn.textContent = 'Copy'; }, 1500);
        } catch {
          // Fallback for non-HTTPS contexts
          const ta = document.createElement('textarea');
          ta.value = lastOutput;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          cliCopyBtn.textContent = 'Copied!';
          setTimeout(() => { cliCopyBtn.textContent = 'Copy'; }, 1500);
        }
      });
    }

    // Run button
    cliRunBtn.addEventListener('click', () => runCommand());

    // Enter key + history navigation
    cliInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        runCommand();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        histIdx = Math.min(histIdx + 1, history.length - 1);
        cliInput.value = history[histIdx] || '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        histIdx = Math.max(histIdx - 1, -1);
        cliInput.value = histIdx === -1 ? '' : history[histIdx];
      }
    });

    // Quick pick buttons
    detailBody.querySelectorAll('.cli-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        const fmt = btn.dataset.fmt;
        cliInput.value = cmd;
        cliFormat.value = fmt;
        runCommand(cmd, fmt);
      });
    });
  }

  function showEdgeDetail(edgeData) {
    detailTitle.textContent = `${edgeData.sourceLabel} ↔ ${edgeData.targetLabel}`;
    detailBody.innerHTML = buildEdgeDetailHTML(edgeData);
    detailPanel.classList.add('open');
  }

  function closeDetail() {
    detailPanel.classList.remove('open');
  }

  function buildNodeDetailHTML(d) {
    let html = `
      <div class="detail-section">
        <h4>Identity</h4>
        <div class="detail-row">
          <span class="detail-label">Hostname</span>
          <span class="detail-value">${esc(d.hostname)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">System ID</span>
          <span class="detail-value">${esc(d.systemId)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">LSP ID</span>
          <span class="detail-value">${esc(d.lspId)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Instance</span>
          <span class="detail-value">${esc(d.instance)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Level</span>
          <span class="detail-badge cyan">L${d.level}</span>
        </div>
        ${d.overload ? '<div class="detail-row"><span class="detail-label">Overload</span><span class="detail-badge amber">OL</span></div>' : ''}
      </div>

      <div class="detail-section">
        <h4>LSP State</h4>
        <div class="detail-row">
          <span class="detail-label">Sequence #</span>
          <span class="detail-value">${d.sequenceNumber}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Checksum</span>
          <span class="detail-value">0x${(d.checksum || 0).toString(16).toUpperCase()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Neighbors</span>
          <span class="detail-value">${d.neighborCount}</span>
        </div>
      </div>`;

    // Router Capabilities — SR
    const caps = d.routerCaps;
    if (caps) {
      html += `<div class="detail-section"><h4>Segment Routing</h4>`;

      if (caps.routerId) {
        html += `<div class="detail-row"><span class="detail-label">Router ID</span><span class="detail-value">${esc(caps.routerId)}</span></div>`;
      }
      if (caps.srgb && caps.srgb.length > 0) {
        for (const srgb of caps.srgb) {
          html += `<div class="detail-row"><span class="detail-label">SRGB</span><span class="detail-value">${srgb.base} - ${srgb.base + srgb.range - 1}</span></div>`;
        }
      }
      if (caps.srlb && caps.srlb.length > 0) {
        for (const srlb of caps.srlb) {
          html += `<div class="detail-row"><span class="detail-label">SRLB</span><span class="detail-value">${srlb.base} - ${srlb.base + srlb.range - 1}</span></div>`;
        }
      }
      if (caps.maxSIDDepth) {
        html += `<div class="detail-row"><span class="detail-label">Max SID Depth</span><span class="detail-value">${caps.maxSIDDepth}</span></div>`;
      }
      html += `</div>`;
    }

    // SR Prefix SIDs
    if (d.srPrefixSids && d.srPrefixSids.length > 0) {
      html += `
        <div class="detail-section">
          <h4>SR Prefix SIDs (${d.srPrefixSids.length})</h4>
          <ul class="prefix-list">
            ${d.srPrefixSids
              .map(
                (s) =>
                  `<li>${esc(s.prefix)}<span class="detail-badge cyan" style="margin-left:8px;">SID ${s.sid}</span><span class="prefix-metric">algo ${s.algorithm}${s.isNodeSid ? ' [N]' : ''}</span></li>`
              )
              .join('')}
          </ul>
        </div>`;
    }

    // SR Adj-SIDs
    if (d.srAdjSids && d.srAdjSids.length > 0) {
      html += `
        <div class="detail-section">
          <h4>SR Adjacency SIDs (${d.srAdjSids.length})</h4>
          <ul class="prefix-list">
            ${d.srAdjSids
              .map(
                (s) =>
                  `<li>→ ${esc(s.neighbor)}<span class="detail-badge green" style="margin-left:8px;">${s.sid}</span></li>`
              )
              .join('')}
          </ul>
        </div>`;
    }

    // IP Reachability
    if (d.prefixes && d.prefixes.length > 0) {
      html += `
        <div class="detail-section">
          <h4>IP Reachability (${d.prefixes.length})</h4>
          <ul class="prefix-list">
            ${d.prefixes
              .map(
                (p) =>
                  `<li>${esc(p.prefix)}/${p.mask}<span class="prefix-metric">metric ${p.metric}</span></li>`
              )
              .join('')}
          </ul>
        </div>`;
    }

    // Remote Node SID Reachability (async-loaded)
    html += `
      <div class="detail-section" style="margin-top:8px;padding-top:16px;border-top:1px solid var(--border);">
        <h4>Remote Node SID Reachability</h4>
        <div id="reachabilitySection">
          <div class="reach-loading">Loading reachability...</div>
        </div>
      </div>`;

    // CLI Panel
    html += buildCLIPanelHTML(d.hostname);

    return html;
  }

  /**
   * Build the CLI panel HTML for a given device hostname.
   */
  function buildCLIPanelHTML(hostname) {
    const quickPicks = [
      { label: 'show isis neighbors',              fmt: 'text' },
      { label: 'show isis database detail',         fmt: 'text' },
      { label: 'show isis segment-routing tunnel',  fmt: 'text' },
      { label: 'show tunnel fib',                   fmt: 'text' },
      { label: 'show isis ti-lfa path detail',      fmt: 'text' },
      { label: 'show mpls lfib route',              fmt: 'text' },
      { label: 'show interfaces status',            fmt: 'text' },
      { label: 'show interfaces counters errors',   fmt: 'text' },
      { label: 'show ip interface brief',           fmt: 'text' },
      { label: 'show ip route summary',             fmt: 'text' },
      { label: 'show version',                      fmt: 'text' },
      { label: 'show log last 50',                  fmt: 'text' },
    ];

    return `
      <div class="cli-section">
        <h4>CLI — ${esc(hostname)}</h4>
        <div class="cli-input-row">
          <input type="text" class="cli-input" id="cliInput" placeholder="show ... (↑↓ for history)" />
          <select class="cli-format-select" id="cliFormat">
            <option value="text">text</option>
            <option value="json">json</option>
          </select>
          <button class="cli-run-btn" id="cliRunBtn" data-hostname="${esc(hostname)}">▶ RUN</button>
        </div>
        <div class="cli-quick-picks">
          <span class="cli-quick-label">QUICK:</span>
          ${quickPicks.map(
            (qp) =>
              `<button class="cli-quick-btn" data-cmd="${esc(qp.label)}" data-fmt="${qp.fmt}">${esc(qp.label)}</button>`
          ).join('')}
        </div>
        <div class="cli-output-header" id="cliOutputHeader" style="display:none;">
          <button class="btn btn-ghost btn-sm" id="cliCopyBtn">Copy</button>
        </div>
        <div class="cli-output" id="cliOutput">
          <div class="cli-output-empty">ENTER A COMMAND OR CLICK A QUICK PICK</div>
        </div>
      </div>`;
  }

  /**
   * Build the reachability table HTML.
   */
  function buildReachabilityHTML(reachData) {
    let html = '<div class="reach-table">';

    for (const entry of reachData.entries) {
      const statusInfo = getProtectionInfo(entry.protectionStatus);
      const rowId = `reach-${entry.systemId}`;

      html += `
        <div class="reach-row" data-system-id="${entry.systemId}" data-row-id="${rowId}">
          <div class="reach-shield" title="${esc(statusInfo.title)}">${statusInfo.icon}</div>
          <div class="reach-info">
            <span class="reach-hostname">${esc(entry.hostname)}</span>
            <span class="reach-sid detail-badge cyan">SID ${entry.sid}</span>
          </div>
          <span class="reach-meta">${entry.hopCount}h / m${entry.metric}</span>
        </div>
        <div class="reach-expand" id="${rowId}">
          <div class="reach-expand-section">
            <div class="reach-expand-label">Primary Path</div>
            <div class="reach-path-chain">${entry.primaryChain.join(' → ')}</div>
            ${entry.primaryLabelStack.length > 0 ? `
              <div class="reach-label-stack">
                ${entry.primaryLabelStack.map(l => {
                  const decoded = decodeSrLabel(l);
                  return '<span class="detail-badge ' + decoded.color + '" title="' + esc(decoded.description) + '" style="cursor:help;font-size:0.7rem;">' + esc(l) + '</span>';
                }).join('')}
              </div>` : ''}
          </div>
          ${entry.backupLabelStack.length > 0 ? `
            <div class="reach-expand-section">
              <div class="reach-expand-label">TI-LFA Backup Stack</div>
              <div class="reach-label-stack">
                ${entry.backupLabelStack.map(l => {
                  const decoded = decodeSrLabel(l);
                  return '<span class="detail-badge ' + decoded.color + '" title="' + esc(decoded.description) + '" style="cursor:help;font-size:0.7rem;">' + esc(l) + '</span>';
                }).join('')}
              </div>
              <div style="font-size:0.68rem;color:var(--text-muted);margin-top:3px;">
                ${entry.backupLabelStack.map(l => decodeSrLabel(l).description).join(' → ')}
              </div>
              ${entry.backupNexthop ? `<div style="font-size:0.68rem;color:var(--text-muted);margin-top:2px;">via ${esc(entry.backupNexthop)} (${esc(entry.backupInterface)})</div>` : ''}
            </div>` : ''}
          <div class="reach-actions">
            <button class="btn btn-primary btn-sm btn-reach-primary" data-dest="${entry.systemId}">Show Primary</button>
            ${entry.backupLabelStack.length > 0 ? `<button class="btn btn-ghost btn-sm btn-reach-backup" data-dest="${entry.systemId}">Show Backup</button>` : ''}
          </div>
        </div>`;
    }

    html += '</div>';
    return html;
  }

  /**
   * Get protection status icon and label.
   */
  function getProtectionInfo(status) {
    switch (status) {
      case 'node-protected':
      case 'node-protected+ecmp':
        return {
          title: 'TI-LFA Node Protected',
          icon: '<svg viewBox="0 0 20 20" fill="#34d399"><path fill-rule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM13.707 8.707a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>',
        };
      case 'ecmp':
        return {
          title: 'ECMP (Multiple Equal-Cost Paths)',
          icon: '<svg viewBox="0 0 20 20" fill="#22d3ee"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>',
        };
      default:
        return {
          title: 'Unprotected',
          icon: '<svg viewBox="0 0 20 20" fill="#fbbf24"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>',
        };
    }
  }

  /**
   * Wire up click handlers for reachability rows.
   */
  function wireReachabilityHandlers(container, sourceId) {
    // Toggle expand on row click
    container.querySelectorAll('.reach-row').forEach((row) => {
      row.addEventListener('click', () => {
        const rowId = row.dataset.rowId;
        const expand = document.getElementById(rowId);
        const wasOpen = expand.classList.contains('open');

        // Close all expanded rows
        container.querySelectorAll('.reach-expand').forEach((e) => e.classList.remove('open'));
        container.querySelectorAll('.reach-row').forEach((r) => r.classList.remove('expanded'));

        if (!wasOpen) {
          expand.classList.add('open');
          row.classList.add('expanded');
        }
      });
    });

    // "Show Primary" buttons
    container.querySelectorAll('.btn-reach-primary').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const destId = btn.dataset.dest;
        pathSource.value = sourceId;
        pathDest.value = destId;
        pathFailNode.value = '';
        pathFailLink.value = '';
        handleComputePath();
      });
    });

    // "Show Backup" buttons
    container.querySelectorAll('.btn-reach-backup').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const destId = btn.dataset.dest;

        // Find the first transit node on the primary path to simulate failure
        pathSource.value = sourceId;
        pathDest.value = destId;
        pathFailLink.value = '';

        // Compute primary first to find a transit node to fail
        const analysis = await API.analyzePath(sourceId, destId);
        if (analysis.nodeBackups && analysis.nodeBackups.length > 0) {
          // Pick the first node-protected backup
          const firstBackup = analysis.nodeBackups.find((b) => b.backupPath);
          if (firstBackup) {
            pathFailNode.value = firstBackup.failedNode;
          }
        }

        handleComputePath();
      });
    });
  }

  function buildEdgeDetailHTML(d) {
    let html = `
      <div class="detail-section">
        <h4>Link Endpoints</h4>
        <div class="detail-row">
          <span class="detail-label">Source</span>
          <span class="detail-value">${esc(d.sourceLabel)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Target</span>
          <span class="detail-value">${esc(d.targetLabel)}</span>
        </div>
      </div>

      <div class="detail-section">
        <h4>Metrics</h4>
        <div class="detail-row">
          <span class="detail-label">${esc(d.sourceLabel)} → ${esc(d.targetLabel)}</span>
          <span class="detail-badge cyan">${d.metric}</span>
        </div>`;

    if (d.reverseMetric !== null) {
      html += `
        <div class="detail-row">
          <span class="detail-label">${esc(d.targetLabel)} → ${esc(d.sourceLabel)}</span>
          <span class="detail-badge cyan">${d.reverseMetric}</span>
        </div>`;
    }

    html += `</div>`;

    // IP Addresses
    if (d.localAddr || d.neighborAddr) {
      html += `
        <div class="detail-section">
          <h4>Addresses</h4>
          ${d.localAddr ? `<div class="detail-row"><span class="detail-label">${esc(d.sourceLabel)}</span><span class="detail-value">${esc(d.localAddr)}</span></div>` : ''}
          ${d.neighborAddr ? `<div class="detail-row"><span class="detail-label">${esc(d.targetLabel)}</span><span class="detail-value">${esc(d.neighborAddr)}</span></div>` : ''}
        </div>`;
    }

    // Adj-SIDs (forward direction)
    if (d.adjSids && d.adjSids.length > 0) {
      html += `
        <div class="detail-section">
          <h4>Adjacency SIDs</h4>
          ${d.adjSids.map(s =>
            `<div class="detail-row"><span class="detail-label">${esc(d.sourceLabel)} → ${esc(d.targetLabel)}</span><span class="detail-badge green">${s.sid}</span></div>`
          ).join('')}`;

      // Reverse Adj-SIDs
      if (d.reverseAdjSids && d.reverseAdjSids.length > 0) {
        html += d.reverseAdjSids.map(s =>
          `<div class="detail-row"><span class="detail-label">${esc(d.targetLabel)} → ${esc(d.sourceLabel)}</span><span class="detail-badge green">${s.sid}</span></div>`
        ).join('');
      }

      html += `</div>`;
    }

    html += `
      <div class="detail-section">
        <h4>Metadata</h4>
        <div class="detail-row">
          <span class="detail-label">IS-IS Level</span>
          <span class="detail-badge cyan">L${d.level}</span>
        </div>
        ${d.linkHealth ? `
          <div class="detail-row">
            <span class="detail-label">Link Health</span>
            <span class="detail-badge ${d.linkHealth === 'healthy' ? 'green' : d.linkHealth === 'degraded' ? 'amber' : d.linkHealth === 'down' ? 'red' : 'cyan'}">${d.linkHealth}</span>
          </div>` : ''}
      </div>`;

    // Adjacency Health — both directions
    const healthSides = [
      { label: d.sourceLabel, health: d.forwardHealth },
      { label: d.targetLabel, health: d.reverseHealth },
    ].filter(s => s.health);

    if (healthSides.length > 0) {
      html += `<div class="detail-section"><h4>Adjacency Health</h4>`;

      for (const side of healthSides) {
        const h = side.health;
        const stateColor = h.state === 'up' ? 'green' : h.state === 'down' ? 'red' : 'amber';
        html += `
          <div style="margin-bottom:12px;">
            <div style="font-size:0.75rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">${esc(side.label)}</div>
            <div class="detail-row">
              <span class="detail-label">State</span>
              <span class="detail-badge ${stateColor}">${esc(h.state)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Interface</span>
              <span class="detail-value">${esc(h.localInterface)}</span>
            </div>
            ${h.mtu ? `<div class="detail-row">
              <span class="detail-label">MTU</span>
              <span class="detail-value">${h.mtu}</span>
            </div>` : ''}
            <div class="detail-row">
              <span class="detail-label">Uptime</span>
              <span class="detail-value">${esc(h.uptimeFormatted)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Hold Timer</span>
              <span class="detail-value">${h.holdRemaining}s / ${h.holdTime}s</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">BFD (IPv4)</span>
              <span class="detail-badge ${h.bfdState === 'up' ? 'green' : h.bfdState === 'adminDown' ? 'cyan' : 'amber'}">${esc(h.bfdState)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">SR Enabled</span>
              <span class="detail-badge ${h.srEnabled ? 'green' : 'amber'}">${h.srEnabled ? 'yes' : 'no'}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Graceful Restart</span>
              <span class="detail-value">${esc(h.grSupported)}</span>
            </div>
          </div>`;
      }

      html += `</div>`;
    }

    return html;
  }

  // ── Modal Helpers ─────────────────────────────────────────────────
  function openDeviceModal() {
    deviceModal.classList.add('open');
  }

  function closeDeviceModal() {
    deviceModal.classList.remove('open');
  }

  // ── Status Indicator ──────────────────────────────────────────────
  function setStatus(state, text) {
    statusDot.className = 'status-dot';
    if (state === 'live') statusDot.classList.add('live');
    if (state === 'collecting') statusDot.classList.add('collecting');
    if (state === 'error') statusDot.classList.add('error');
    statusText.textContent = text;
  }

  // ── Utility ───────────────────────────────────────────────────────
  function esc(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  /**
   * Decode an SR MPLS label into a human-readable description.
   * Uses knowledge of the SRGB range and known prefix-SIDs.
   */
  function decodeSrLabel(labelStr) {
    const label = parseInt(labelStr, 10);
    const srgbBase = 900000;
    const srgbEnd = 965536;
    const srlbBase = 965536;
    const srlbEnd = 1031072;

    // Implicit null (PHP)
    if (label === 3) {
      return { description: 'Implicit Null (PHP)', color: 'green' };
    }

    // SRGB range — Prefix-SID
    if (label >= srgbBase && label < srgbEnd) {
      const sid = label - srgbBase;
      // Try to find the node with this prefix-SID
      let nodeName = '';
      if (topologyData) {
        for (const node of topologyData.nodes) {
          const match = (node.data.srPrefixSids || []).find((s) => s.sid === sid);
          if (match) {
            nodeName = ` (${node.data.hostname})`;
            break;
          }
        }
      }
      return { description: `Prefix-SID ${sid}${nodeName}`, color: 'cyan' };
    }

    // SRLB range — likely Adj-SID (dynamic)
    if (label >= srlbBase && label < srlbEnd) {
      return { description: `Adj-SID ${label} (SRLB)`, color: 'green' };
    }

    // Below SRGB — likely a dynamic Adj-SID from the local label space
    if (label > 15 && label < srgbBase) {
      // Try to identify by looking up adj-SIDs in the topology
      let adjInfo = '';
      if (topologyData) {
        for (const node of topologyData.nodes) {
          const match = (node.data.srAdjSids || []).find((s) => s.sid === label);
          if (match) {
            adjInfo = ` (${node.data.hostname} → ${match.neighbor})`;
            break;
          }
        }
      }
      return { description: `Adj-SID ${label}${adjInfo}`, color: 'green' };
    }

    return { description: `Label ${label}`, color: 'cyan' };
  }

  // ── Boot ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
