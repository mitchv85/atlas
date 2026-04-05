// ---------------------------------------------------------------------------
// ATLAS — Main Application
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────
  let devices = [];
  let topologyData = null;
  let currentPathResult = null;
  let lastViewedNode = null; // Track node for "back" navigation from path views
  let lastFlowSnapshot = null; // Latest sFlow flow data
  let lastTunnelRates = [];    // Latest tunnel counter rates (deterministic)
  let flowOverlayActive = false; // Is the heatmap overlay on?
  let bandwidthOverlayActive = false; // Is the bandwidth heatmap overlay on?
  let lastBandwidthData = null;  // Latest bandwidth:updated snapshot
  let authUser = null;          // Current authenticated user { username, role }
  const topo = new TopologyRenderer('cy');
  const socket = new AtlasSocket();

  // ── Shared Constants ────────────────────────────────────────────
  const SR_QUICK_PICKS = [
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
    { label: 'show ip bgp summary',              fmt: 'text' },
    { label: 'show bgp evpn summary',            fmt: 'text' },
    { label: 'show version',                      fmt: 'text' },
    { label: 'show log last 50',                  fmt: 'text' },
  ];

  // SR label range constants — lab SRGB 900000–965535, SRLB 965536–1031071
  const SRGB_BASE = 900000;
  const SRGB_END  = 965536;
  const SRLB_BASE = 965536;
  const SRLB_END  = 1031072;

  /**
   * Copy text to clipboard with fallback for non-HTTPS contexts.
   * Updates a button element with a brief "Copied!" flash.
   * @param {string} text - Text to copy
   * @param {HTMLElement} [btn] - Optional button to flash with confirmation
   */
  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (btn) {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  }

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
  const viewBgp = $('#viewBgp');
  const viewFlows = $('#viewFlows');
  const viewMgmt = $('#viewMgmt');

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

  // Path analysis — SearchableCombo instances with .value proxy
  const pathBar = $('#pathBar');
  const pathAlgo = $('#pathAlgo');
  const btnComputePath = $('#btnComputePath');
  const btnClearPath = $('#btnClearPath');

  // Create searchable combos — proxy objects mimic select.value for backward compat
  const comboPathSource = new SearchableCombo($('#comboPathSource'), { placeholder: 'Search source...' });
  const comboPathDest = new SearchableCombo($('#comboPathDest'), { placeholder: 'Search destination...' });
  const comboPathFailNode = new SearchableCombo($('#comboPathFailNode'), { placeholder: 'None' });
  const comboPathFailLink = new SearchableCombo($('#comboPathFailLink'), { placeholder: 'None' });

  // Proxy objects so existing code like pathSource.value = 'x' still works
  const pathSource = { get value() { return comboPathSource.getValue(); }, set value(v) { comboPathSource.setValue(v); } };
  const pathDest = { get value() { return comboPathDest.getValue(); }, set value(v) { comboPathDest.setValue(v); } };
  const pathFailNode = { get value() { return comboPathFailNode.getValue(); }, set value(v) { comboPathFailNode.setValue(v); } };
  const pathFailLink = { get value() { return comboPathFailLink.getValue(); }, set value(v) { comboPathFailLink.setValue(v); } };

  // Service trace bar
  const svcTraceBar = $('#svcTraceBar');
  const svcTracePrefix = $('#svcTracePrefix');
  const btnSvcTrace = $('#btnSvcTrace');
  const btnSvcModeToggle = $('#btnSvcModeToggle');
  const btnSvcTraceToggle = $('#btnSvcTraceToggle');

  const comboSvcSource = new SearchableCombo($('#comboSvcSource'), { placeholder: 'Search PE...' });
  const comboSvcVrf = new SearchableCombo($('#comboSvcVrf'), { placeholder: 'All VRFs' });
  const svcTraceSource = { get value() { return comboSvcSource.getValue(); }, set value(v) { comboSvcSource.setValue(v); } };

  // Prefix autocomplete — feeds from /api/bgp/prefix-list, scoped by VRF
  const prefixAutocomplete = new PrefixAutocomplete(
    $('#svcTracePrefix'),
    $('#prefixAutocompleteDropdown'),
    { vrfGetter: () => comboSvcVrf.getValue() }
  );

  // Bust prefix cache when VRF selection changes
  comboSvcVrf.onSelect = () => prefixAutocomplete.invalidateCache();

  // ── Tab Switching ───────────────────────────────────────────────
  let activeTab = 'topology';
  const deviceTestResults = new Map(); // id → 'ok' | 'fail' | 'testing'
  let deviceInfo = {};                  // name → { model, serial, eosVersion, ... }
  let gnmiStatus = {};                  // name → { status, streams, updateCount, ... }
  let selectedDeviceId = null;          // currently viewed device detail

  /** Switch the active tab and update path bar visibility. */
  function switchTab(tabName) {
    activeTab = tabName;
    mainTabs.forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });
    viewTopology.classList.toggle('active', tabName === 'topology');
    viewDevices.classList.toggle('active', tabName === 'devices');
    viewBgp.classList.toggle('active', tabName === 'bgp');
    viewFlows.classList.toggle('active', tabName === 'flows');
    viewMgmt.classList.toggle('active', tabName === 'mgmt');

    // Show/hide path bar and collect button based on tab
    // Only show the path bar OR service trace bar — whichever was active
    const svcMode = svcTraceBar.style.display === 'flex';
    if (pathBar) pathBar.style.display = tabName === 'topology' && topologyData && !svcMode ? 'flex' : 'none';
    if (svcTraceBar) svcTraceBar.style.display = tabName === 'topology' && topologyData && svcMode ? 'flex' : 'none';
    if (btnCollect) btnCollect.style.display = tabName === 'topology' ? '' : 'none';

    if (tabName === 'devices') {
      refreshDevicesPage();
    }
    if (tabName === 'bgp') {
      refreshBgpPage();
    }
    if (tabName === 'flows') {
      refreshFlowsPage();
    }
    if (tabName === 'mgmt') {
      refreshMgmtPage();
    }
  }

  // ── Devices Page ────────────────────────────────────────────────
  async function refreshDevicesPage() {
    try {
      const list = await API.getDevices();
      devices = list;
      btnCollect.disabled = devices.length === 0;
    } catch (err) {
      console.error('Failed to refresh devices:', err.message);
      return;
    }

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

    renderDevicesTable(devices);

    // Fetch device info in background
    API.getDeviceInfo().then((info) => {
      deviceInfo = info;
      if (!selectedDeviceId) renderDevicesTable(devices);
    }).catch(() => {});

    // Fetch gNMI streaming status
    API.getGnmiStatus().then((status) => {
      gnmiStatus = status?.connections || {};
      if (!selectedDeviceId) renderDevicesTable(devices);
    }).catch(() => {});

    // Auto-test connectivity for all devices
    testAllDevices();
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

      // gNMI streaming status for this device
      const gn = gnmiStatus[d.name];
      let gnmiCell;
      if (!gn) {
        gnmiCell = '<span class="dev-status"><span class="dev-status-dot"></span> —</span>';
        gnmiCell += ` <button class="dev-action-btn gnmi-reconnect-btn" data-name="${esc(d.name)}" title="Start gNMI streams">⟳</button>`;
      } else if (gn.status === 'connected') {
        gnmiCell = `<span class="dev-status"><span class="dev-status-dot ok"></span> ${gn.streams}</span>`;
      } else if (gn.status === 'connecting') {
        gnmiCell = `<span class="dev-status"><span class="dev-status-dot testing"></span> ${gn.streams}</span>`;
      } else {
        gnmiCell = `<span class="dev-status"><span class="dev-status-dot fail"></span> ${gn.status}</span>`;
      }
      // Add reconnect button if not fully synced
      if (gn && gn.status !== 'connected') {
        gnmiCell += ` <button class="dev-action-btn gnmi-reconnect-btn" data-name="${esc(d.name)}" title="Reconnect gNMI streams">⟳</button>`;
      }

      const roleLabel = { pe: 'PE', p: 'P', cpe: 'CPE' }[d.role] || 'PE';
      const roleClass = d.role === 'cpe' ? 'cpe' : 'pe';
      const roleBadge = `<span class="dev-role-badge ${roleClass} clickable" data-id="${d.id}" data-role="${d.role || 'pe'}" title="Click to change role">${roleLabel}</span>`;

      return `<tr data-id="${d.id}" class="dev-row-clickable">
        <td><strong>${esc(d.name)}</strong> ${roleBadge}</td>
        <td>${esc(d.host)}</td>
        <td>${infoCell(info.model)}</td>
        <td>${infoCell(info.eosVersion)}</td>
        <td>${infoCell(info.serial)}</td>
        <td>${infoCell(info.chipset)}</td>
        <td>${infoCell(info.fwdAgent)}</td>
        <td>${gnmiCell}</td>
        <td>
          <span class="dev-status">
            <span class="dev-status-dot ${dotClass}"></span>
            ${statusLabel}
          </span>
        </td>
        <td>
          <div class="dev-actions">
            <button class="dev-action-btn dev-visibility-btn ${d.hideFromTopology ? 'hidden-from-topo' : ''}" data-id="${d.id}" data-hidden="${d.hideFromTopology ? '1' : '0'}" title="${d.hideFromTopology ? 'Hidden from topology for all users — click to show' : 'Visible in topology for all users — click to hide'}">${d.hideFromTopology ? '👁‍🗨' : '👁'}</button>
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

    tbody.querySelectorAll('.dev-visibility-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const isHidden = btn.dataset.hidden === '1';
        await API.updateDevice(id, { hideFromTopology: !isHidden });
        // Update local state
        const dev = devices.find(d => d.id === id);
        if (dev) dev.hideFromTopology = !isHidden;
        renderDevicesTable(devices);
        // Re-fetch topology so the filter takes effect immediately for all users
        try {
          const topo = await API.getTopology();
          if (topo) loadTopologyIntoView(topo, true);
        } catch {}
      });
    });

    // Wire gNMI reconnect buttons
    tbody.querySelectorAll('.gnmi-reconnect-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.name;
        btn.disabled = true;
        btn.textContent = '...';
        try {
          await API.reconnectGnmi(name);
          // Wait a moment for streams to start, then refresh status
          setTimeout(async () => {
            const status = await API.getGnmiStatus();
            gnmiStatus = status?.connections || {};
            renderDevicesTable(devices);
          }, 3000);
        } catch {
          btn.textContent = '⟳';
          btn.disabled = false;
        }
      });
    });

    // Wire role badge clicks — cycle through P → PE → CPE
    const ROLE_CYCLE = { pe: 'p', p: 'cpe', cpe: 'pe' };
    tbody.querySelectorAll('.dev-role-badge.clickable').forEach((badge) => {
      badge.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = badge.dataset.id;
        const currentRole = badge.dataset.role || 'pe';
        const nextRole = ROLE_CYCLE[currentRole] || 'pe';
        await API.updateDevice(id, { role: nextRole });
        const dev = devices.find(d => d.id === id);
        if (dev) dev.role = nextRole;
        renderDevicesTable(devices);
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
    try {
      await API.deleteDevice(id);
      deviceTestResults.delete(id);
      await refreshDevicesPage();
    } catch (err) {
      console.error('Failed to delete device:', err.message);
    }
  }

  async function addDeviceFromForm() {
    addDeviceError.textContent = '';
    const name = $('#addDevName').value.trim();
    const host = $('#addDevHost').value.trim();
    const username = $('#addDevUser').value.trim();
    const password = $('#addDevPass').value;
    const port = parseInt($('#addDevPort').value, 10) || 443;
    const role = $('#addDevRole')?.value || 'pe';

    if (!name) return addDeviceError.textContent = 'Name is required';
    if (!host) return addDeviceError.textContent = 'Host / IP is required';
    if (!username) return addDeviceError.textContent = 'Username is required';

    try {
      const result = await API.addDevice({ name, host, username, password, port, transport: 'https', role });
      if (result.error) return addDeviceError.textContent = result.error;
      $('#addDevName').value = '';
      $('#addDevHost').value = '';
      await refreshDevicesPage();
    } catch (err) {
      addDeviceError.textContent = `Error: ${err.message}`;
    }
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
      if (/^\s+no /.test(line)) return 'var(--red)';
      return 'var(--text-primary)';
    }

  /** Escape HTML entities to prevent XSS in dynamic content. */
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
    container.querySelector('#configCopy').addEventListener('click', () => {
      if (!configText) return;
      copyToClipboard(configText, container.querySelector('#configCopy'));
    });
  }

  function renderDeviceCommands(container, device) {
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
          ${SR_QUICK_PICKS.map((qp) =>
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

    cmdCopy.addEventListener('click', () => {
      if (!lastOutput) return;
      copyToClipboard(lastOutput, cmdCopy);
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
      for (const line of text.replace(/\r/g, '').split('\n')) {
        // EOS dir output formats:
        //   -rw-       10164           Feb 19 16:22  AsuFastPktTransmit.log
        //   drwx        4096           Nov 26  2025  Fossil
        // Date is 3 segments: "month day time" or "month day year"
        const m = line.match(/^\s*([d-][rwx-]{3})\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/);
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

  // ── Auth Flow ────────────────────────────────────────────────────
  function showLogin() {
    document.getElementById('loginOverlay').style.display = 'flex';
    document.getElementById('loginUsername').focus();
  }

  function hideLogin() {
    document.getElementById('loginOverlay').style.display = 'none';
  }

  function showApp() {
    hideLogin();
    document.getElementById('changePasswordModal').style.display = 'none';
    document.getElementById('userBadge').style.display = 'flex';
    document.getElementById('userBadgeName').textContent = authUser.username;
    document.getElementById('userBadgeRole').textContent = authUser.role;
    // Hide Users tab for non-admins
    const usersTab = document.getElementById('mgmtTabUsers');
    if (usersTab) usersTab.style.display = authUser.role === 'admin' ? '' : 'none';
    // Initialize the app if not already done
    if (!topo.cy) initApp();
  }

  function doLogout() {
    API.logout();
    localStorage.removeItem('atlas-token');
    authUser = null;
    document.getElementById('userBadge').style.display = 'none';
    showLogin();
    checkGitHubSSO();
  }

  function initAuthHandlers() {
    const loginBtn = document.getElementById('btnLogin');
    const loginUser = document.getElementById('loginUsername');
    const loginPass = document.getElementById('loginPassword');
    const loginErr = document.getElementById('loginError');

    async function doLogin() {
      loginErr.style.display = 'none';
      const username = loginUser.value.trim();
      const password = loginPass.value;
      if (!username || !password) {
        loginErr.textContent = 'Please enter username and password.';
        loginErr.style.display = 'block';
        return;
      }
      loginBtn.disabled = true;
      loginBtn.textContent = 'Signing in...';
      try {
        const result = await API.login(username, password);
        if (result.ok) {
          localStorage.setItem('atlas-token', result.data.token);
          authUser = result.data.user;
          loginPass.value = '';
          if (authUser.mustChangePassword) {
            hideLogin();
            document.getElementById('changePasswordModal').style.display = 'flex';
          } else {
            showApp();
          }
        } else {
          loginErr.textContent = result.data.error || 'Login failed.';
          loginErr.style.display = 'block';
        }
      } catch (e) {
        loginErr.textContent = 'Connection error. Please try again.';
        loginErr.style.display = 'block';
      }
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
    }

    loginBtn.addEventListener('click', doLogin);
    loginPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    loginUser.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginPass.focus(); });

    // Change password
    const cpBtn = document.getElementById('btnChangePassword');
    const cpErr = document.getElementById('cpError');
    cpBtn.addEventListener('click', async () => {
      cpErr.style.display = 'none';
      const cur = document.getElementById('cpCurrent').value;
      const np  = document.getElementById('cpNew').value;
      const nc  = document.getElementById('cpConfirm').value;
      if (np !== nc) { cpErr.textContent = 'Passwords do not match.'; cpErr.style.display = 'block'; return; }
      if (np.length < 8) { cpErr.textContent = 'Minimum 8 characters.'; cpErr.style.display = 'block'; return; }
      cpBtn.disabled = true;
      try {
        const result = await API.changePassword(cur, np);
        if (result.ok) {
          localStorage.setItem('atlas-token', result.data.token);
          authUser.mustChangePassword = false;
          showApp();
        } else {
          cpErr.textContent = result.data.error || 'Failed.';
          cpErr.style.display = 'block';
        }
      } catch { cpErr.textContent = 'Connection error.'; cpErr.style.display = 'block'; }
      cpBtn.disabled = false;
    });

    // Sign out
    document.getElementById('btnSignOut').addEventListener('click', doLogout);

    // Listen for 401s from API
    window.addEventListener('atlas:unauthorized', () => {
      if (authUser) doLogout();
    });
  }

  async function checkAuth() {
    // Check for GitHub SSO callback token in URL
    const params = new URLSearchParams(window.location.search);
    const callbackToken = params.get('auth_token');
    const authError = params.get('auth_error');

    // Clean URL
    if (callbackToken || authError) {
      window.history.replaceState({}, '', '/');
    }

    if (callbackToken) {
      localStorage.setItem('atlas-token', callbackToken);
    }

    if (authError) {
      const handle = params.get('handle') || '';
      const errorMap = {
        'missing_code': 'GitHub authentication failed.',
        'token_exchange_failed': 'GitHub token exchange failed.',
        'not_authorized': handle ? `GitHub user "${handle}" is not pre-authorized. Ask an admin to add your GitHub account.` : 'GitHub user not pre-authorized.',
        'server_error': 'Server error during GitHub authentication.',
      };
      setTimeout(() => {
        const loginErr = document.getElementById('loginError');
        loginErr.textContent = errorMap[authError] || 'Authentication error.';
        loginErr.style.display = 'block';
      }, 100);
      return false;
    }

    const token = localStorage.getItem('atlas-token');
    if (!token) return false;
    try {
      const me = await API.getMe();
      if (me && me.username) {
        authUser = me;
        // Apply user's server-side theme preference (overrides localStorage)
        if (me.theme) {
          localStorage.setItem('atlas-theme', me.theme);
          applyTheme(me.theme);
        }
        if (me.mustChangePassword) {
          document.getElementById('loginOverlay').style.display = 'none';
          document.getElementById('changePasswordModal').style.display = 'flex';
          return false;
        }
        return true;
      }
    } catch {}
    return false;
  }

  let _githubSSOChecked = false;
  async function checkGitHubSSO() {
    try {
      const status = await API.getGitHubSSOStatus();
      if (status.enabled) {
        document.getElementById('btnGitHubSSO').style.display = 'flex';
        document.getElementById('loginDivider').style.display = 'flex';
        // Only wire click handler once
        if (!_githubSSOChecked) {
          _githubSSOChecked = true;
          document.getElementById('btnGitHubSSO').addEventListener('click', () => {
            window.location.href = '/api/auth/github';
          });
        }
      }
    } catch {}
  }

  // ── Mgmt Page ───────────────────────────────────────────────────
  let activeMgmtTab = 'profile';

  function refreshMgmtPage() {
    if (activeMgmtTab === 'profile') loadProfile();
    else if (activeMgmtTab === 'users') loadUsers();
    else if (activeMgmtTab === 'audit') loadAuditLog();
    else if (activeMgmtTab === 'system') loadSystemInfo();
  }

  function initMgmtPage() {
    // Sub-tab switching
    document.querySelectorAll('.mgmt-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.mgmt;
        activeMgmtTab = target;
        document.querySelectorAll('.mgmt-tab').forEach(t => t.classList.toggle('active', t.dataset.mgmt === target));
        document.querySelectorAll('.mgmt-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('mgmt' + target.charAt(0).toUpperCase() + target.slice(1)).classList.add('active');
        refreshMgmtPage();
      });
    });

    document.getElementById('btnRefreshAudit')?.addEventListener('click', loadAuditLog);
    document.getElementById('btnRefreshSystem')?.addEventListener('click', loadSystemInfo);
    document.getElementById('btnAddUser')?.addEventListener('click', showAddUserForm);
    document.getElementById('btnAddGitHubUser')?.addEventListener('click', showAddGitHubUserForm);

    // Show GitHub preauth button if SSO is configured
    API.getGitHubSSOStatus().then(s => {
      if (s.enabled) {
        const btn = document.getElementById('btnAddGitHubUser');
        if (btn) btn.style.display = 'inline-flex';
      }
    }).catch(() => {});
  }

  // ── Profile ──
  async function loadProfile() {
    const container = document.getElementById('profileContent');
    try {
      const p = await API.getProfile();

      // GitHub profile link row (only for GitHub SSO users)
      const githubRow = p.githubUrl
        ? `<tr><td style="font-weight:600;">GitHub</td><td><a href="${esc(p.githubUrl)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;">@${esc(p.githubLogin || p.username)} ↗</a></td></tr>`
        : '';

      // Theme options (match the ATLAS theme picker)
      const themes = [
        { value: 'github-dark',  label: 'GitHub Dark' },
        { value: 'midnight',     label: 'Midnight' },
        { value: 'nord',         label: 'Nord' },
        { value: 'dracula',      label: 'Dracula' },
        { value: 'monokai',      label: 'Monokai' },
        { value: 'arista-dark',  label: 'Arista Dark' },
        { value: 'horizon',      label: 'Horizon' },
        { value: 'solarized',    label: 'Solarized Light' },
        { value: 'github',       label: 'GitHub Light' },
        { value: 'quiet',        label: 'Quiet Light' },
        { value: 'sand',         label: 'Sand' },
        { value: 'arista-light', label: 'Arista Light' },
      ];
      const currentTheme = p.theme || localStorage.getItem('atlas-theme') || 'github-dark';
      const themeOptions = themes.map(t =>
        `<option value="${t.value}" ${currentTheme === t.value ? 'selected' : ''}>${t.label}</option>`
      ).join('');

      container.innerHTML = `
        <div class="devices-table-wrap" style="max-width:600px;">
          <table class="devices-table">
            <tbody>
              <tr><td style="font-weight:600;width:160px;">Username</td><td>${esc(p.username)}</td></tr>
              <tr><td style="font-weight:600;">Role</td><td><span class="detail-badge cyan">${esc(p.role)}</span></td></tr>
              <tr><td style="font-weight:600;">Type</td><td>${p.type === 'github' ? 'GitHub SSO' : 'Local'}</td></tr>
              ${githubRow}
              <tr><td style="font-weight:600;">First Name</td><td><input class="input-field" id="profFirstName" value="${esc(p.firstName)}" /></td></tr>
              <tr><td style="font-weight:600;">Last Name</td><td><input class="input-field" id="profLastName" value="${esc(p.lastName)}" /></td></tr>
              <tr><td style="font-weight:600;">Email</td><td><input class="input-field" id="profEmail" type="email" value="${esc(p.email)}" /></td></tr>
              <tr><td style="font-weight:600;">Phone</td><td><input class="input-field" id="profPhone" type="tel" value="${esc(p.phone)}" /></td></tr>
              <tr><td style="font-weight:600;">Notes</td><td><textarea class="input-field" id="profNotes" rows="3" style="resize:vertical;">${esc(p.notes)}</textarea></td></tr>
              <tr><td style="font-weight:600;">Theme</td><td><select class="input-field" id="profTheme">${themeOptions}</select></td></tr>
              <tr><td style="font-weight:600;">Created</td><td>${p.createdAt ? new Date(p.createdAt).toLocaleString() : '—'}</td></tr>
              <tr><td style="font-weight:600;">Last Updated</td><td>${p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '—'}</td></tr>
            </tbody>
          </table>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" id="btnSaveProfile">Save Profile</button>
          <button class="btn btn-ghost btn-sm" id="btnShowChangePw">Change Password</button>
        </div>
        <div id="profileMsg" style="margin-top:8px;font-size:0.78rem;"></div>`;

      document.getElementById('btnSaveProfile').addEventListener('click', async () => {
        const fields = {
          firstName: document.getElementById('profFirstName').value,
          lastName: document.getElementById('profLastName').value,
          email: document.getElementById('profEmail').value,
          phone: document.getElementById('profPhone').value,
          notes: document.getElementById('profNotes').value,
          theme: document.getElementById('profTheme').value,
        };
        const result = await API.updateProfile(fields);
        document.getElementById('profileMsg').innerHTML = '<span style="color:var(--green);">Profile saved.</span>';
        // Apply theme immediately and sync to localStorage
        if (fields.theme) {
          localStorage.setItem('atlas-theme', fields.theme);
          applyTheme(fields.theme);
        }
      });

      document.getElementById('btnShowChangePw').addEventListener('click', () => {
        document.getElementById('changePasswordModal').style.display = 'flex';
      });
    } catch { container.innerHTML = '<p class="text-muted">Error loading profile.</p>'; }
  }

  // ── Users ──
  async function loadUsers() {
    const container = document.getElementById('usersContent');
    try {
      const users = await API.getUsers();
      document.getElementById('mgmtUserCount').textContent = `${users.length} user${users.length !== 1 ? 's' : ''}`;

      let html = `<div class="devices-table-wrap"><table class="devices-table">
        <thead><tr>
          <th>Username</th><th>Type</th><th>Role</th><th>Name</th><th>Email</th>
          <th>Theme</th><th>Created</th><th>Actions</th>
        </tr></thead><tbody>`;

      for (const u of users) {
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || '—';
        const roleBadge = u.role === 'admin' ? 'cyan' : u.role === 'operator' ? 'green' : 'blue';
        const typeBadge = u.githubLogin
          ? `<a href="${esc(u.githubUrl || '#')}" target="_blank" rel="noopener" style="text-decoration:none;"><span class="detail-badge" style="font-size:0.6rem;background:rgba(255,255,255,0.08);color:var(--text-secondary);">GitHub ↗</span></a>`
          : '<span class="detail-badge" style="font-size:0.6rem;background:rgba(255,255,255,0.08);color:var(--text-muted);">Local</span>';
        const themeBadge = `<span class="detail-badge" style="font-size:0.6rem;background:rgba(255,255,255,0.06);color:var(--text-muted);">${esc(u.theme || 'github-dark')}</span>`;
        html += `<tr>
          <td style="font-weight:600;">${esc(u.username)}</td>
          <td>${typeBadge}</td>
          <td><span class="detail-badge ${roleBadge}" style="font-size:0.68rem;">${esc(u.role)}</span>
            ${u.mustChangePassword ? '<span class="detail-badge amber" style="font-size:0.6rem;margin-left:4px;">PW Reset</span>' : ''}</td>
          <td>${esc(name)}</td>
          <td>${esc(u.email || '—')}</td>
          <td>${themeBadge}</td>
          <td style="font-size:0.72rem;">${u.createdAt ? new Date(u.createdAt).toLocaleString() : '—'}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-ghost btn-sm btn-edit-user" data-username="${esc(u.username)}" data-role="${esc(u.role)}">Edit</button>
            ${u.username !== 'admin' ? `<button class="btn btn-ghost btn-sm btn-delete-user" data-username="${esc(u.username)}" style="color:var(--red);">×</button>` : ''}
          </td>
        </tr>`;
      }
      html += '</tbody></table></div>';
      container.innerHTML = html;

      // Wire edit buttons
      container.querySelectorAll('.btn-edit-user').forEach(btn => {
        btn.addEventListener('click', () => showEditUserForm(btn.dataset.username, btn.dataset.role));
      });
      // Wire delete buttons
      container.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Delete user "${btn.dataset.username}"?`)) return;
          await API.deleteUser(btn.dataset.username);
          loadUsers();
        });
      });
    } catch { container.innerHTML = '<p class="text-muted">Error loading users.</p>'; }
  }

  /** Build profile fields HTML for user forms. */
  function _profileFieldsHTML(data = {}) {
    return `
      <div class="login-field"><label>First Name</label><input class="input-field" id="ufFirstName" value="${esc(data.firstName || '')}" /></div>
      <div class="login-field"><label>Last Name</label><input class="input-field" id="ufLastName" value="${esc(data.lastName || '')}" /></div>
      <div class="login-field"><label>Email</label><input class="input-field" id="ufEmail" type="email" value="${esc(data.email || '')}" /></div>
      <div class="login-field"><label>Phone</label><input class="input-field" id="ufPhone" type="tel" value="${esc(data.phone || '')}" /></div>
      <div class="login-field"><label>Notes</label><textarea class="input-field" id="ufNotes" rows="2" style="resize:vertical;">${esc(data.notes || '')}</textarea></div>`;
  }

  /** Read profile fields from the form. */
  function _readProfileFields() {
    return {
      firstName: document.getElementById('ufFirstName')?.value?.trim() || '',
      lastName: document.getElementById('ufLastName')?.value?.trim() || '',
      email: document.getElementById('ufEmail')?.value?.trim() || '',
      phone: document.getElementById('ufPhone')?.value?.trim() || '',
      notes: document.getElementById('ufNotes')?.value?.trim() || '',
    };
  }

  function showAddUserForm() {
    const container = document.getElementById('usersContent');
    const formHTML = `
      <div class="devices-table-wrap" style="max-width:500px;padding:16px;margin-bottom:16px;">
        <h3 style="font-size:0.88rem;margin-bottom:12px;">Add New User</h3>
        <div class="login-field"><label>Username</label><input class="input-field" id="newUserName" /></div>
        <div class="login-field"><label>Password (min 8 chars)</label><input type="password" class="input-field" id="newUserPass" /></div>
        <div class="login-field"><label>Role</label>
          <select class="input-field" id="newUserRole"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select>
        </div>
        ${_profileFieldsHTML()}
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-primary btn-sm" id="btnConfirmAddUser">Create User</button>
          <button class="btn btn-ghost btn-sm" id="btnCancelAddUser">Cancel</button>
        </div>
        <div id="addUserMsg" style="margin-top:8px;font-size:0.78rem;"></div>
      </div>`;
    container.insertAdjacentHTML('afterbegin', formHTML);

    document.getElementById('btnConfirmAddUser').addEventListener('click', async () => {
      const u = document.getElementById('newUserName').value.trim();
      const p = document.getElementById('newUserPass').value;
      const r = document.getElementById('newUserRole').value;
      const msg = document.getElementById('addUserMsg');
      if (!u || !p) { msg.innerHTML = '<span style="color:var(--red);">Username and password are required.</span>'; return; }
      const fields = { username: u, password: p, role: r, ..._readProfileFields() };
      const result = await API.addUser(fields);
      if (result.ok) { loadUsers(); } else { msg.innerHTML = `<span style="color:var(--red);">${esc(result.data.error)}</span>`; }
    });
    document.getElementById('btnCancelAddUser').addEventListener('click', loadUsers);
  }

  function showAddGitHubUserForm() {
    const container = document.getElementById('usersContent');
    const formHTML = `
      <div class="devices-table-wrap" style="max-width:500px;padding:16px;margin-bottom:16px;">
        <h3 style="font-size:0.88rem;margin-bottom:4px;">Pre-Authorize GitHub User</h3>
        <p class="text-muted" style="font-size:0.72rem;margin-bottom:12px;">The user will be able to sign in with GitHub SSO after being pre-authorized.</p>
        <div class="login-field"><label>GitHub Username</label><input class="input-field" id="ghPreauthHandle" placeholder="e.g. mitchv85" /></div>
        <div class="login-field"><label>Role</label>
          <select class="input-field" id="ghPreauthRole"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select>
        </div>
        ${_profileFieldsHTML()}
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-primary btn-sm" id="btnConfirmGhPreauth">Pre-Authorize</button>
          <button class="btn btn-ghost btn-sm" id="btnCancelGhPreauth">Cancel</button>
        </div>
        <div id="ghPreauthMsg" style="margin-top:8px;font-size:0.78rem;"></div>
      </div>`;
    container.insertAdjacentHTML('afterbegin', formHTML);

    document.getElementById('btnConfirmGhPreauth').addEventListener('click', async () => {
      const handle = document.getElementById('ghPreauthHandle').value.trim();
      const role = document.getElementById('ghPreauthRole').value;
      const msg = document.getElementById('ghPreauthMsg');
      if (!handle) { msg.innerHTML = '<span style="color:var(--red);">GitHub username is required.</span>'; return; }
      const fields = { githubHandle: handle, role, ..._readProfileFields() };
      const result = await API.githubPreauth(fields);
      if (result.ok) { loadUsers(); } else { msg.innerHTML = `<span style="color:var(--red);">${esc(result.data.error)}</span>`; }
    });
    document.getElementById('btnCancelGhPreauth').addEventListener('click', loadUsers);
  }

  function showEditUserForm(username, currentRole) {
    // Fetch the full user list to get current profile data
    API.getUsers().then(users => {
      const user = users.find(u => u.username === username) || {};
      const isGithub = user.type === 'github';

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.style.display = 'flex';
      modal.innerHTML = `<div class="login-card" style="max-width:460px;max-height:90vh;overflow-y:auto;">
        <h2 style="font-size:1rem;margin-bottom:12px;">Edit User: ${esc(username)}
          ${isGithub && user.githubUrl ? `<a href="${esc(user.githubUrl)}" target="_blank" rel="noopener" style="font-size:0.72rem;margin-left:8px;color:var(--accent);">GitHub ↗</a>` : ''}
        </h2>
        <div class="login-field"><label>Role</label>
          <select class="input-field" id="editRole">
            <option value="viewer" ${currentRole==='viewer'?'selected':''}>Viewer</option>
            <option value="operator" ${currentRole==='operator'?'selected':''}>Operator</option>
            <option value="admin" ${currentRole==='admin'?'selected':''}>Admin</option>
          </select>
        </div>
        ${_profileFieldsHTML(user)}
        ${!isGithub ? '<div class="login-field"><label>Reset Password (optional)</label><input type="password" class="input-field" id="editNewPw" placeholder="Leave blank to keep current" /></div>' : ''}
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-primary btn-sm" id="btnConfirmEdit">Save</button>
          <button class="btn btn-ghost btn-sm" id="btnCancelEdit">Cancel</button>
        </div>
        <div id="editMsg" style="margin-top:8px;font-size:0.78rem;"></div>
      </div>`;
      document.body.appendChild(modal);

      document.getElementById('btnConfirmEdit').addEventListener('click', async () => {
        const fields = { role: document.getElementById('editRole').value, ..._readProfileFields() };
        const pw = document.getElementById('editNewPw')?.value;
        if (pw) { fields.resetPassword = true; fields.newPassword = pw; }
        const result = await API.editUser(username, fields);
        if (result.ok) { modal.remove(); loadUsers(); }
        else { document.getElementById('editMsg').innerHTML = `<span style="color:var(--red);">${esc(result.data.error)}</span>`; }
      });
      document.getElementById('btnCancelEdit').addEventListener('click', () => modal.remove());
    });
  }

  // ── Audit Log ──
  async function loadAuditLog() {
    const container = document.getElementById('auditContent');
    try {
      const log = await API.getAuditLog(300);
      document.getElementById('mgmtAuditCount').textContent = `${log.length} entries`;

      let html = `<div class="devices-table-wrap"><table class="devices-table">
        <thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Target</th><th>Result</th><th>Detail</th></tr></thead><tbody>`;

      for (const e of log) {
        const resultBadge = e.result === 'success' ? 'green' : e.result === 'denied' ? 'amber' : 'red';
        html += `<tr>
          <td style="font-size:0.7rem;white-space:nowrap;">${new Date(e.timestamp).toLocaleString()}</td>
          <td style="font-weight:600;">${esc(e.user)}</td>
          <td><span class="detail-badge cyan" style="font-size:0.6rem;">${esc(e.role)}</span></td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;">${esc(e.action)}</td>
          <td>${esc(e.target)}</td>
          <td><span class="detail-badge ${resultBadge}" style="font-size:0.65rem;">${esc(e.result)}</span></td>
          <td style="font-size:0.7rem;color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;">${esc(e.detail || '')}</td>
        </tr>`;
      }
      html += '</tbody></table></div>';
      container.innerHTML = html;
    } catch { container.innerHTML = '<p class="text-muted">Error loading audit log.</p>'; }
  }

  // ── System Info ──
  async function loadSystemInfo() {
    const container = document.getElementById('systemContent');
    try {
      const s = await API.getSystemInfo();
      const uptimeStr = formatUptime(s.uptimeSeconds);

      container.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:800px;">
          <div class="devices-table-wrap">
            <table class="devices-table">
              <thead><tr><th colspan="2">Server</th></tr></thead>
              <tbody>
                <tr><td style="font-weight:600;">Node.js</td><td>${esc(s.nodeVersion)}</td></tr>
                <tr><td style="font-weight:600;">Platform</td><td>${esc(s.platform)}</td></tr>
                <tr><td style="font-weight:600;">Uptime</td><td style="color:var(--accent);">${uptimeStr}</td></tr>
                <tr><td style="font-weight:600;">Memory (RSS)</td><td>${s.memUsedMb} MB</td></tr>
                <tr><td style="font-weight:600;">ATLAS Commit</td><td style="color:var(--accent);font-family:'JetBrains Mono',monospace;">${esc(s.atlasCommit)}</td></tr>
                <tr><td style="font-weight:600;">Token TTL</td><td>${esc(s.tokenTtl)}</td></tr>
              </tbody>
            </table>
          </div>
          <div class="devices-table-wrap">
            <table class="devices-table">
              <thead><tr><th colspan="2">Application</th></tr></thead>
              <tbody>
                <tr><td style="font-weight:600;">Users</td><td>${s.userCount}</td></tr>
                <tr><td style="font-weight:600;">Audit Entries</td><td>${s.auditCount} / ${s.auditMax}</td></tr>
                <tr><td style="font-weight:600;">Devices</td><td>${s.deviceCount}</td></tr>
              </tbody>
            </table>
          </div>
        </div>`;
    } catch { container.innerHTML = '<p class="text-muted">Error loading system info.</p>'; }
  }

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  }

  // ── Theme System ──────────────────────────────────────────────────
  const THEMES = [
    { group: 'Dark' },
    { id: 'github-dark',    label: 'GitHub Dark',     swatches: ['#0d1117', '#1c2128', '#58a6ff'] },
    { id: 'midnight',       label: 'Midnight',        swatches: ['#0d1220', '#1e3a5f', '#22d3ee'] },
    { id: 'nord',           label: 'Nord',            swatches: ['#2e3440', '#3b4252', '#88c0d0'] },
    { id: 'dracula',        label: 'Dracula',         swatches: ['#21222c', '#343746', '#bd93f9'] },
    { id: 'monokai',        label: 'Monokai',         swatches: ['#1e1f1c', '#32332c', '#66d9ef'] },
    { id: 'arista-dark',    label: 'Arista Dark',     swatches: ['#0c1a30', '#16325b', '#4473a9'] },
    { group: 'Light' },
    { id: 'horizon',        label: 'Horizon',         swatches: ['#f1f5f9', '#dbeafe', '#0284c7'] },
    { id: 'solarized',      label: 'Solarized Light', swatches: ['#fdf6e3', '#e0dbc5', '#2aa198'] },
    { id: 'github',         label: 'GitHub Light',    swatches: ['#f6f8fa', '#ddf4ff', '#0969da'] },
    { id: 'quiet',          label: 'Quiet Light',     swatches: ['#f5f3f7', '#ede9fe', '#7c3aed'] },
    { id: 'sand',           label: 'Sand',            swatches: ['#f5f0e8', '#e8dcc8', '#b45309'] },
    { id: 'arista-light',   label: 'Arista Light',    swatches: ['#eef2f6', '#d6e3f0', '#146095'] },
  ];

  function initThemePicker() {
    const dropdown = $('#themeDropdown');
    const btn = $('#themePickerBtn');
    const current = localStorage.getItem('atlas-theme') || 'github-dark';

    // Build dropdown options with group dividers
    dropdown.innerHTML = THEMES.map(t => {
      if (t.group) {
        return `<div style="padding:4px 14px 2px;font-size:0.65rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);${t.group === 'Light' ? 'border-top:1px solid var(--border);margin-top:4px;padding-top:8px;' : ''}">${t.group}</div>`;
      }
      const swatchHTML = t.swatches.map(c => `<span style="background:${c};"></span>`).join('');
      return `<div class="theme-option${t.id === current ? ' active' : ''}" data-theme="${t.id}">
        <div class="theme-option-swatch">${swatchHTML}</div>
        ${t.label}
      </div>`;
    }).join('');

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    // Close on outside click
    document.addEventListener('click', () => dropdown.classList.remove('open'));
    dropdown.addEventListener('click', (e) => e.stopPropagation());

    // Theme selection
    dropdown.querySelectorAll('.theme-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const themeId = opt.dataset.theme;
        applyTheme(themeId);
        localStorage.setItem('atlas-theme', themeId);

        // Sync to server profile
        API.updateProfile({ theme: themeId }).catch(() => {});

        // Update active state
        dropdown.querySelectorAll('.theme-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        dropdown.classList.remove('open');
      });
    });
  }

  function applyTheme(themeId) {
    if (themeId === 'github-dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', themeId);
    }
    // Re-apply Cytoscape styles with new colors (no-op if cy not initialized)
    topo.refreshStyles();
  }

  // ── Init ──────────────────────────────────────────────────────────
  async function init() {
    // Apply saved theme BEFORE anything renders
    const savedTheme = localStorage.getItem('atlas-theme') || 'github-dark';
    if (savedTheme !== 'github-dark') {
      document.documentElement.setAttribute('data-theme', savedTheme);
    }

    // Wire auth handlers (login form, sign out, etc.)
    initAuthHandlers();

    // Check if user has a valid session
    const isAuthenticated = await checkAuth();
    if (isAuthenticated) {
      showApp();
    } else {
      showLogin();
      checkGitHubSSO(); // Show GitHub button if SSO is configured
    }
  }

  /**
   * Initialize the full application after successful authentication.
   * Called once on page load (if token is valid) or after login success.
   */
  async function initApp() {
    topo.init();
    initThemePicker();
    initMgmtPage();

    topo.onNodeClick = showNodeDetail;
    topo.onEdgeClick = showEdgeDetail;

    // Context menu (right-click) handlers
    topo.onNodeContext = showNodeContextMenu;
    topo.onEdgeContext = showEdgeContextMenu;
    topo.onDismissContext = hideContextMenus;

    // Save positions to server when nodes are dragged
    topo.onNodeDragEnd = (positions) => {
      API.savePositions(positions);
    };

    bindEvents();
    initBgpPage();
    initFlowsPage();
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

    // gNMI device sync — refresh streaming status in Devices tab
    socket.on('gnmi:device:synced', () => {
      API.getGnmiStatus().then((status) => {
        gnmiStatus = status?.connections || {};
        if (!selectedDeviceId) renderDevicesTable(devices);
      }).catch(() => {});
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

    // sFlow flow updates (real-time)
    socket.on('sflow:flows:updated', (snapshot) => {
      lastFlowSnapshot = snapshot;
      if (activeTab === 'flows') {
        renderFlowsTable(lastTunnelRates, snapshot);
      }
      // Update heatmap if overlay is active
      if (flowOverlayActive && activeTab === 'topology') {
        topo.applyFlowHeatmap(snapshot);
      }
    });

    // Tunnel counter rate updates (deterministic, every poll cycle)
    socket.on('sflow:tunnelRates:updated', (rates) => {
      lastTunnelRates = rates || [];
      if (activeTab === 'flows') {
        renderFlowsTable(lastTunnelRates, lastFlowSnapshot);
      }
    });

    // Live bandwidth rate updates from gNMI counter deltas
    socket.on('bandwidth:updated', (data) => {
      lastBandwidthData = data;
      if (bandwidthOverlayActive && activeTab === 'topology' && data.edgeRates) {
        topo.applyBandwidthHeatmap(data.edgeRates);
      }
    });
  }

  // ── Event Binding ─────────────────────────────────────────────────
  function bindEvents() {
    // Tab navigation
    mainTabs.forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // "Add Your First Device" button switches to Devices tab
    btnEmptyAddDevice.addEventListener('click', () => switchTab('devices'));

    btnCollect.addEventListener('click', handleCollect);
    btnCloseDetail.addEventListener('click', closeDetail);

    // ── Detail panel resize handle ─────────────────────────────────
    {
      const handle = $('#detailResizeHandle');
      const MIN_W = 280;
      const MAX_W = Math.min(900, window.innerWidth * 0.8);
      let dragging = false;

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const newW = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - e.clientX));
        detailPanel.style.width = newW + 'px';
      });

      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    }

    // Topology toolbar
    $('#btnFit').addEventListener('click', () => topo.fit());
    $('#btnZoomIn').addEventListener('click', () => topo.zoomIn());
    $('#btnZoomOut').addEventListener('click', () => topo.zoomOut());
    $('#btnLayoutCose').addEventListener('click', () => topo.runLayout('cose'));

    // Path analysis
    btnComputePath.addEventListener('click', handleComputePath);
    btnClearPath.addEventListener('click', handleClearPath);

    // Combo selection changes update topology markers
    comboPathSource.onSelect = () => updateSelectionMarkers();
    comboPathDest.onSelect = () => updateSelectionMarkers();
    comboPathFailNode.onSelect = () => updateSelectionMarkers();
    comboPathFailLink.onSelect = () => updateSelectionMarkers();

    // Algorithm dropdown switches edge metric overlay
    pathAlgo.addEventListener('change', () => {
      const algoNum = parseInt(pathAlgo.value, 10) || 0;
      topo.setAlgorithmOverlay(algoNum);
    });

    // Service trace mode toggle
    btnSvcModeToggle.addEventListener('click', async () => {
      pathBar.style.display = 'none';
      svcTraceBar.style.display = 'flex';
      // Ensure VRFs are loaded (triggers BGP collect if needed)
      try { await API.collectBgp(); } catch {}
      refreshSvcTraceVrfs();
    });
    btnSvcTraceToggle.addEventListener('click', () => {
      svcTraceBar.style.display = 'none';
      pathBar.style.display = topologyData ? 'flex' : 'none';
    });

    // Service trace execution
    btnSvcTrace.addEventListener('click', handleSvcTrace);
    svcTracePrefix.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSvcTrace();
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

  // ── Device Init ──────────────────────────────────────────────────
  async function refreshDevices() {
    try {
      devices = await API.getDevices();
      btnCollect.disabled = devices.length === 0;
    } catch (err) {
      console.error('Failed to load devices:', err.message);
    }
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

  /** Load topology data into the Cytoscape renderer and update all dropdowns. */
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

    // Re-apply bandwidth overlay if active (topology rebuild creates fresh
    // elements that lose the label overrides)
    if (bandwidthOverlayActive && lastBandwidthData?.edgeRates) {
      topo.applyBandwidthHeatmap(lastBandwidthData.edgeRates);
    }
  }

  /**
   * Populate the source/destination/failure dropdowns from the topology.
   */
  /** Populate all path bar and service trace dropdowns from topology data. */
  function populatePathDropdowns() {
    const nodes = topo.getNodeList();

    // Save current selections
    const prevSrc = pathSource.value;
    const prevDst = pathDest.value;
    const prevFail = pathFailNode.value;
    const prevFailLink = pathFailLink.value;

    // Build node options
    const nodeOpts = nodes.map(n => ({ value: n.id, label: n.label }));

    // Populate combos
    comboPathSource.setOptions(nodeOpts);
    comboPathDest.setOptions(nodeOpts);
    comboPathFailNode.setOptions([{ value: '', label: 'None' }, ...nodeOpts]);

    // Service trace source (uses hostnames as values)
    const peOpts = nodes.map(n => ({ value: n.label, label: n.label }));
    comboSvcSource.setOptions(peOpts);

    // Service trace VRF (populated from BGP store)
    refreshSvcTraceVrfs();

    // Link failure dropdown
    const linkOpts = [{ value: '', label: 'None' }];
    if (topologyData?.edges) {
      for (const edge of topologyData.edges) {
        const d = edge.data;
        const label = `${d.sourceLabel} ↔ ${d.targetLabel}`;
        const detail = d.localAddr ? ` (${d.localAddr})` : '';
        linkOpts.push({ value: d.id, label: label + detail });
      }
    }
    comboPathFailLink.setOptions(linkOpts);

    // Restore selections if still valid
    if (prevSrc && nodes.some(n => n.id === prevSrc)) pathSource.value = prevSrc;
    if (prevDst && nodes.some(n => n.id === prevDst)) pathDest.value = prevDst;
    if (prevFail && nodes.some(n => n.id === prevFail)) pathFailNode.value = prevFail;
    if (prevFailLink) pathFailLink.value = prevFailLink;

    // Populate algorithm dropdown from discovered FlexAlgos
    const prevAlgo = pathAlgo.value;
    pathAlgo.innerHTML = '<option value="0">Algo 0 (SPF)</option>';
    if (topologyData?.metadata?.algorithms) {
      for (const algo of topologyData.metadata.algorithms) {
        if (algo.number === 0) continue; // Already added
        const label = `Algo ${algo.number} (${algo.name})`;
        const opt = new Option(label, algo.number);
        pathAlgo.add(opt);
      }
    }
    if (prevAlgo) pathAlgo.value = prevAlgo;
  }

  // ── Path Computation ─────────────────────────────────────────────
  /** Handle Compute Path button — dispatches to FlexAlgo or standard SPF. */
  async function handleComputePath() {
    const source = pathSource.value;
    const dest = pathDest.value;
    const failNode = pathFailNode.value;
    const failLink = pathFailLink.value;
    const algo = parseInt(pathAlgo.value, 10) || 0;

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
      // ── FlexAlgo path (algo >= 128) — query device via eAPI ──
      if (algo >= 128) {
        await handleFlexAlgoPath(source, dest, algo);
        return;
      }

      // ── Algo 0 — standard SPF/ECMP ──
      // No failure selected — check for ECMP first
      if (!failNode && !failLink) {
        const ecmpResult = await API.computeECMP(source, dest);

        if (ecmpResult.pathCount > 1) {
          currentPathResult = ecmpResult;
          topo.highlightECMP(ecmpResult);
          showECMPDetail(ecmpResult);
          btnClearPath.style.display = 'inline-flex';
          setStatus('live', `ECMP: ${ecmpResult.pathCount} equal-cost paths, metric ${ecmpResult.totalMetric}`);
          return;
        }
      }

      // Path with optional failure simulation
      const analysis = await API.analyzePath(source, dest);
      currentPathResult = analysis;

      let displayPath;
      let failedNodes = failNode ? [failNode] : [];
      let failedEdges = failLink ? [failLink] : [];
      let failureLabels = [];

      if (failNode && failLink) {
        // Dual failure — compute from scratch with both exclusions
        const result = await API.computePath(source, dest, [failNode], [failLink]);
        displayPath = result.reachable ? result : null;
        failureLabels.push(getHostname(failNode));
        failureLabels.push(getEdgeLabel(failLink));
      } else if (failNode) {
        // Single node failure — try TI-LFA backup first
        const backup = analysis.nodeBackups.find((b) => b.failedNode === failNode);
        if (backup) {
          displayPath = backup.backupPath;
          failureLabels.push(backup.failedHostname);
        } else {
          const result = await API.computePath(source, dest, [failNode], []);
          displayPath = result.reachable ? result : null;
          failureLabels.push(getHostname(failNode));
        }
      } else if (failLink) {
        // Single link failure — try TI-LFA backup first
        const backup = analysis.linkBackups.find((b) => b.failedEdgeId === failLink);
        if (backup) {
          displayPath = backup.backupPath;
          failureLabels.push(backup.failedLinkLabel);
        } else {
          const result = await API.computePath(source, dest, [], [failLink]);
          displayPath = result.reachable ? result : null;
          failureLabels.push(getEdgeLabel(failLink));
        }
      } else {
        displayPath = analysis.primary;
      }

      const failureLabel = failureLabels.join(' + ');

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

  /**
   * Handle FlexAlgo path computation.
   * Traces the constrained path hop-by-hop by querying each device via eAPI.
   */
  /** Compute and display a FlexAlgo path between two nodes. */
  async function handleFlexAlgoPath(source, dest, algo) {
    try {
      const result = await API.traceFlexAlgoPath(source, dest, algo);

      if (result.error && !result.hops) {
        setStatus('error', result.error);
        return;
      }

      btnClearPath.style.display = 'inline-flex';

      if (result.reachable && result.hops?.length > 1) {
        // Build a path-like structure for the topology highlighter
        const pathHops = [];
        for (let i = 0; i < result.hops.length - 1; i++) {
          const hop = result.hops[i];
          const nextHop = result.hops[i + 1];
          pathHops.push({
            from: hop.systemId,
            to: nextHop.systemId,
            fromHostname: hop.hostname,
            toHostname: nextHop.hostname,
            edgeId: hop.edgeId || null,
          });
        }

        const faPath = {
          source: result.hops[0].systemId,
          destination: result.hops[result.hops.length - 1].systemId,
          sourceHostname: result.source,
          destinationHostname: result.destination,
          hops: pathHops,
          hopCount: result.hopCount,
          totalMetric: result.totalMetric,
          algorithm: algo,
        };

        topo.highlightPath(faPath, [], []);
        showFlexAlgoDetail(result, algo);
        setStatus('live', `FlexAlgo ${algo} (${result.algorithmName}): ${result.hopCount} hops, metric ${result.totalMetric ?? '—'}`);
      } else {
        topo.clearPath();
        showFlexAlgoDetail(result, algo);
        setStatus('error', `FlexAlgo ${algo}: ${result.source} → ${result.destination} — ${result.error || 'unreachable'}`);
      }
    } catch (err) {
      setStatus('error', `FlexAlgo error: ${err.message}`);
    } finally {
      btnComputePath.disabled = false;
      btnComputePath.classList.remove('loading');
    }
  }

  /**
   * Show FlexAlgo path detail in the side panel.
   */
  /** Show FlexAlgo path detail in the side panel. */
  function showFlexAlgoDetail(result, algo) {
    const srcName = result.source || getHostname(pathSource.value);
    const dstName = result.destination || getHostname(pathDest.value);

    detailTitle.textContent = `${srcName} → ${dstName} (Algo ${algo})`;

    let html = '';

    // Back button
    if (lastViewedNode) {
      html += `<button class="btn btn-ghost btn-sm btn-back-to-node" style="margin-bottom:10px;display:inline-flex;align-items:center;gap:4px;">← Back to ${esc(lastViewedNode.hostname || lastViewedNode.label)}</button>`;
    }

    // Result banner
    const bannerColor = result.reachable ? 'var(--accent)' : 'var(--red)';
    html += `
      <div class="path-result-banner" style="border-left:3px solid ${bannerColor};">
        <span class="path-result-text">
          <strong>FlexAlgo ${algo} — ${esc(result.algorithmName || '')}</strong><br>
          ${result.reachable
            ? `${result.hopCount} hops, metric ${result.totalMetric ?? '—'}`
            : (result.error || 'Destination unreachable via this algorithm')}
        </span>
      </div>`;

    // FlexAlgo Label Stack
    if (result.reachable && topologyData) {
      const destId = result.hops?.[result.hops.length - 1]?.systemId;
      const destNode = destId ? topologyData.nodes.find(n => n.data.systemId === destId || n.data.id === destId) : null;
      const srcId = result.hops?.[0]?.systemId;
      const srcNode = srcId ? topologyData.nodes.find(n => n.data.systemId === srcId || n.data.id === srcId) : null;

      if (destNode) {
        const destData = destNode.data;
        const faSid = (destData.srPrefixSids || []).find(s => s.algorithm === algo);
        const srgbBase = destData.routerCaps?.srgb?.[0]?.base || (srcNode?.data?.routerCaps?.srgb?.[0]?.base) || SRGB_BASE;

        if (faSid) {
          const globalLabel = srgbBase + faSid.sid;
          html += `
            <div class="detail-section">
              <h4>SR Label Stack</h4>
              <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">
                <span class="detail-badge cyan" title="FlexAlgo ${algo} Prefix-SID ${faSid.sid} for ${esc(destData.hostname)}" style="cursor:help;">${globalLabel}</span>
              </div>
              <div style="font-size:0.68rem;color:var(--text-muted);">
                Algo ${algo} Prefix-SID ${faSid.sid} (${esc(destData.hostname)}) → label ${globalLabel} (SRGB ${srgbBase} + ${faSid.sid})
              </div>
            </div>`;
        }
      }
    }

    // Hop-by-hop path
    if (result.hops && result.hops.length > 0) {
      html += `<div class="detail-section"><h4>Hop-by-Hop Path</h4>`;
      html += '<ul class="path-hops">';

      for (let i = 0; i < result.hops.length; i++) {
        const hop = result.hops[i];
        const isFirst = i === 0;
        const isLast = i === result.hops.length - 1;
        const dotClass = isFirst ? 'source' : isLast ? 'dest' : '';

        html += `<li class="path-hop">
          <div class="path-hop-dot ${dotClass}">${isFirst ? '<div class="path-hop-dot-inner"></div>' : ''}</div>
          <div class="path-hop-info">
            <div class="path-hop-name">${esc(hop.hostname)}</div>
            <div class="path-hop-detail">${isFirst ? 'source' : isLast ? 'destination' : `via ${esc(hop.nexthop || '?')} (${esc(hop.interface || '?')})`}</div>
            ${hop.note ? `<div class="path-hop-detail" style="color:var(--amber);">${esc(hop.note)}</div>` : ''}
          </div>
        </li>`;
      }

      html += '</ul></div>';
    }

    detailBody.innerHTML = html;
    detailPanel.classList.add('open');

    // Wire back button
    const btnBack = detailBody.querySelector('.btn-back-to-node');
    if (btnBack) btnBack.addEventListener('click', backToNode);
  }

  /** Clear path highlighting and reset all path state. */
  function handleClearPath() {
    topo.clearPath();
    currentPathResult = null;
    btnClearPath.style.display = 'none';
    closeDetail();
    // Reset algo overlay to default IS-IS metrics
    topo.setAlgorithmOverlay(0);
    pathAlgo.value = '0';
    // Clear all dropdown values — path analysis combos
    comboPathSource.clear();
    comboPathDest.clear();
    comboPathFailNode.setValue('');   // has an empty 'None' option
    comboPathFailLink.setValue('');   // has an empty 'None' option
    // Clear service trace inputs
    comboSvcSource.clear();
    comboSvcVrf.clear();
    svcTracePrefix.value = '';
    prefixAutocomplete._close();
    // Clear selection markers
    topo.updateSelectionMarkers({ source: null, dest: null, failNode: null, failEdge: null });
    if (topologyData) {
      setStatus('live', `${topologyData.metadata.nodeCount} nodes, ${topologyData.metadata.edgeCount} links`);
    }
  }

  // ── BGP Page ──────────────────────────────────────────────────────
  let bgpConfigLoaded = false;

  /** Refresh the BGP tab — collect from FRR, then update status/VRFs/neighbors. */
  async function refreshBgpPage() {
    // Bust the prefix autocomplete cache so new prefixes appear
    prefixAutocomplete.invalidateCache();
    // Trigger collection from FRR first
    try {
      await API.collectBgp();
    } catch (err) {
      console.error('BGP collect error:', err.message);
    }

    // Load status
    try {
      const status = await API.getBgpStatus();
      renderBgpStatus(status);
    } catch (err) {
      console.error('BGP status error:', err.message);
    }

    // Load config into form (once)
    if (!bgpConfigLoaded) {
      try {
        const config = await API.getBgpConfig();
        populateBgpForm(config);
        bgpConfigLoaded = true;
      } catch (err) {
        console.error('BGP config error:', err.message);
      }
    }
  }

  function renderBgpStatus(status) {
    // FRR Service
    const frrEl = document.getElementById('bgpFrrStatus');
    if (status.frr?.running) {
      frrEl.innerHTML = '<span class="bgp-dot ok"></span> Running';
    } else if (status.enabled) {
      frrEl.innerHTML = '<span class="bgp-dot fail"></span> Stopped';
    } else {
      frrEl.innerHTML = '<span class="bgp-dot"></span> Not Configured';
    }

    // FRR Query Method
    const grpcEl = document.getElementById('bgpGrpcStatus');
    if (status.grpc?.connected) {
      grpcEl.innerHTML = '<span class="bgp-dot ok"></span> FRR gRPC';
    } else if (status.enabled && status.grpc?.available && status.grpc?.connecting) {
      grpcEl.innerHTML = '<span class="bgp-dot warn"></span> FRR gRPC (connecting...)';
    } else if (status.enabled && status.grpc?.available && status.grpc?.reconnectAttempts > 0) {
      grpcEl.innerHTML = '<span class="bgp-dot fail"></span> FRR gRPC (disconnected)';
    } else {
      grpcEl.innerHTML = '<span class="bgp-dot ok"></span> vtysh (CLI)';
    }

    // Neighbors
    const nbrEl = document.getElementById('bgpNeighborStatus');
    const est = status.store?.neighborsEstablished || 0;
    const total = status.store?.neighborCount || 0;
    if (total > 0) {
      nbrEl.innerHTML = `<span class="bgp-dot ${est === total ? 'ok' : 'warn'}"></span> ${est}/${total} Established`;
    } else {
      nbrEl.textContent = '0';
    }

    // VRFs
    document.getElementById('bgpVrfStatus').textContent = status.store?.vrfCount || '0';

    // RIB
    document.getElementById('bgpRibStatus').textContent = (status.store?.ribCount || 0).toLocaleString();

    // Neighbor table
    renderBgpNeighborTable(status.store?.neighborCount || 0);

    // VRF table
    renderBgpVrfTable(status.store?.vrfCount || 0);
  }

  async function renderBgpNeighborTable(count) {
    const section = document.getElementById('bgpNeighborsSection');
    const tbody = document.getElementById('bgpNeighborTableBody');

    if (count === 0) {
      section.style.display = 'none';
      return;
    }

    try {
      const neighbors = await API.getBgpNeighbors();
      if (!neighbors || neighbors.length === 0) {
        section.style.display = 'none';
        return;
      }

      section.style.display = '';
      tbody.innerHTML = neighbors.map((n) => {
        const stateClass = n.state === 'Established' ? 'ok' : n.state === 'Active' || n.state === 'Connect' ? 'warn' : 'fail';
        return `<tr>
          <td><strong>${esc(n.address)}</strong>${n.description ? `<br><span style="font-size:0.72rem;color:var(--text-muted);">${esc(n.description)}</span>` : ''}</td>
          <td>${n.remoteAs}</td>
          <td><span class="dev-status"><span class="dev-status-dot ${stateClass}"></span>${esc(n.state)}</span></td>
          <td>${esc(n.uptimeFormatted || '—')}</td>
          <td>${n.prefixReceived}</td>
          <td style="font-size:0.72rem;">${n.afis.join(', ')}</td>
        </tr>`;
      }).join('');
    } catch {
      section.style.display = 'none';
    }
  }

  // ── VRF Table ───────────────────────────────────────────────────
  async function renderBgpVrfTable(count) {
    const section = document.getElementById('bgpVrfSection');
    const tbody = document.getElementById('bgpVrfTableBody');
    const countEl = document.getElementById('bgpVrfCount');

    if (count === 0) {
      section.style.display = 'none';
      return;
    }

    try {
      const vrfGroups = await API.getBgpVrfsByRT();
      if (!vrfGroups || vrfGroups.length === 0) {
        section.style.display = 'none';
        return;
      }

      section.style.display = '';
      countEl.textContent = `${vrfGroups.length} VRF${vrfGroups.length !== 1 ? 's' : ''}`;

      tbody.innerHTML = vrfGroups.map((g) => {
        const rowId = `vrf-rt-${g.rt.replace(/[:.]/g, '-')}`;
        const peNames = g.rds.map(r => resolveOriginPE(r.rd)).filter(Boolean);
        const uniquePEs = [...new Set(peNames)];
        const peDisplay = uniquePEs.length > 0 ? uniquePEs.join(', ') : '<span style="color:var(--text-muted);">—</span>';

        return `<tr class="bgp-vrf-row" data-rt="${esc(g.rt)}" data-row-id="${rowId}">
          <td class="bgp-vrf-chevron">▸</td>
          <td><strong class="mono-lg">${esc(g.rt)}</strong></td>
          <td>${peDisplay}</td>
          <td><span class="detail-badge cyan">${g.totalPrefixes}</span></td>
        </tr>
        <tr class="bgp-vrf-expand" id="${rowId}" style="display:none;">
          <td colspan="4">
            <div class="bgp-vrf-detail" id="${rowId}-detail">
            </div>
          </td>
        </tr>`;
      }).join('');

      // Wire click-to-expand
      tbody.querySelectorAll('.bgp-vrf-row').forEach((row) => {
        row.addEventListener('click', () => {
          const rt = row.dataset.rt;
          const rowId = row.dataset.rowId;
          const expandRow = document.getElementById(rowId);
          const chevron = row.querySelector('.bgp-vrf-chevron');
          const wasOpen = expandRow.style.display !== 'none';

          // Close all others
          tbody.querySelectorAll('.bgp-vrf-expand').forEach(r => r.style.display = 'none');
          tbody.querySelectorAll('.bgp-vrf-chevron').forEach(c => c.textContent = '▸');
          tbody.querySelectorAll('.bgp-vrf-row').forEach(r => r.classList.remove('expanded'));

          if (!wasOpen) {
            expandRow.style.display = '';
            chevron.textContent = '▾';
            row.classList.add('expanded');
            renderVrfSearchPanel(rt, `${rowId}-detail`);
          }
        });
      });
    } catch {
      section.style.display = 'none';
    }
  }

  /**
   * Resolve the origin PE hostname from an RD like "100.0.0.1:91".
   */
  function resolveOriginPE(rd) {
    const pePart = rd.split(':')[0];
    if (!topologyData?.nodes) return pePart;

    for (const node of topologyData.nodes) {
      const d = node.data;
      if (d.routerCaps?.routerId === pePart) return d.hostname;
      if ((d.interfaceAddresses || []).includes(pePart)) return d.hostname;
    }
    return pePart;
  }

  /**
   * Render the prefix search panel inside a VRF expand row.
   */
  function renderVrfSearchPanel(rt, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const searchId = `vrf-search-${rt.replace(/[:.]/g, '-')}`;
    const dropdownId = `vrf-ac-${rt.replace(/[:.]/g, '-')}`;
    const resultsId = `vrf-results-${rt.replace(/[:.]/g, '-')}`;

    container.innerHTML = `
      <div class="bgp-vrf-search-bar">
        <div class="prefix-autocomplete-wrap" style="flex:1;min-width:0;">
          <input type="text" class="bgp-vrf-search-input" id="${searchId}" placeholder="Search by prefix, next-hop, or origin PE..." />
          <div class="prefix-autocomplete-dropdown" id="${dropdownId}" style="display:none;"></div>
        </div>
        <button class="btn btn-primary btn-sm" id="${searchId}-btn">Search</button>
        <button class="btn btn-ghost btn-sm" id="${searchId}-all">Show All (first 100)</button>
      </div>
      <div id="${resultsId}">
        <p class="text-muted" style="font-size:0.78rem;padding:8px 0;">Enter a search term or click "Show All" to view prefixes.</p>
      </div>`;

    const input = document.getElementById(searchId);
    const dropdown = document.getElementById(dropdownId);
    const btnSearch = document.getElementById(`${searchId}-btn`);
    const btnAll = document.getElementById(`${searchId}-all`);

    const doSearch = () => {
      const query = input.value.trim();
      loadVrfPrefixes(rt, resultsId, query, 100);
    };

    // Wire prefix autocomplete scoped to this VRF
    const ac = new PrefixAutocomplete(input, dropdown, {
      vrfGetter: () => rt
    });
    // Override _select to also trigger the search when a prefix is picked
    const origSelect = ac._select.bind(ac);
    ac._select = (value) => {
      origSelect(value);
      loadVrfPrefixes(rt, resultsId, value, 100);
    };

    btnSearch.addEventListener('click', doSearch);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    btnAll.addEventListener('click', () => {
      input.value = '';
      loadVrfPrefixes(rt, resultsId, '', 100);
    });
  }

  /**
   * Load and render prefixes for a VRF (by RT), with optional search filter.
   */
  /** Load prefix entries for a VRF into a container, with search and pagination. */
  async function loadVrfPrefixes(rt, containerId, searchQuery, limit) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="reach-loading">Searching...</div>';

    try {
      const filters = { rt, bestOnly: 'true', limit: limit || 100 };

      // Apply search query as prefix or originPE filter
      if (searchQuery) {
        if (/^\d/.test(searchQuery)) {
          filters.prefix = searchQuery;
        } else {
          filters.originPE = searchQuery;
        }
      }

      const result = await API.getBgpRib(filters);
      if (!result.entries || result.entries.length === 0) {
        container.innerHTML = `<p class="text-muted" style="font-size:0.78rem;padding:8px 0;">No prefixes found${searchQuery ? ` matching "${esc(searchQuery)}"` : ''}.</p>`;
        return;
      }

      let html = `<table class="devices-table bgp-prefix-table">
        <thead>
          <tr>
            <th>Prefix</th>
            <th>Next-Hop</th>
            <th>Origin PE</th>
            <th>AS Path</th>
            <th>FlexAlgo</th>
            <th>Service Label</th>
            <th>Local Pref</th>
            <th></th>
          </tr>
        </thead>
        <tbody>`;

      // Build PE list for trace source selector
      const peOptions = topologyData?.nodes
        ? topologyData.nodes.map(n => n.data.hostname).sort().map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join('')
        : '';

      for (let i = 0; i < result.entries.length; i++) {
        const e = result.entries[i];
        const peLabel = e.originPE || resolveOriginPE(e.rd);
        const pfxKey = `${e.prefix}/${e.prefixLen}`;
        const detailId = `pfx-detail-${containerId}-${i}`;

        // Resolve FlexAlgo from Color extended community
        const colorComm = (e.extCommunities || []).find(c => c.type === 'Color');
        const algoNum   = colorComm ? colorComm.value : 0;
        const algoIsFA  = algoNum >= 128;
        const algoCell  = algoIsFA
          ? `<span class="detail-badge pink"  title="Color community ${algoNum} → FlexAlgo ${algoNum}">Algo ${algoNum}</span>`
          : `<span class="detail-badge green" title="No Color community — standard SPF">Algo 0</span>`;

        html += `<tr class="bgp-pfx-row" data-prefix="${esc(pfxKey)}" data-detail-id="${detailId}" title="Click for full path details">
          <td class="mono-lg">${esc(pfxKey)}</td>
          <td class="mono-lg">${esc(e.nextHop)}</td>
          <td>${esc(peLabel)}</td>
          <td class="mono-lg">${esc(e.asPath || '—')}</td>
          <td>${algoCell}</td>
          <td>${e.label ? `<span class="detail-badge blue">${e.label}</span>` : '<span style="color:var(--text-muted);">—</span>'}</td>
          <td>${e.locPref}</td>
          <td><button class="btn btn-ghost btn-sm btn-trace-svc" data-prefix="${esc(pfxKey)}" title="Trace service path across transport">⤴ Trace</button></td>
        </tr>
        <tr class="bgp-pfx-expand" id="${detailId}" style="display:none;">
          <td colspan="8"><div class="bgp-pfx-detail-body"></div></td>
        </tr>`;
      }

      html += `</tbody></table>`;

      if (result.filtered > result.entries.length) {
        html += `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:6px;">Showing ${result.entries.length} of ${result.filtered} prefixes — refine your search to see more.</div>`;
      }

      container.innerHTML = html;

      // Wire click-to-expand on prefix rows
      container.querySelectorAll('.bgp-pfx-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          // Don't expand if clicking the trace button
          if (e.target.closest('.btn-trace-svc')) return;

          const pfx = row.dataset.prefix;
          const detailId = row.dataset.detailId;
          const expandRow = document.getElementById(detailId);
          const wasOpen = expandRow.style.display !== 'none';

          // Close all others in this table
          container.querySelectorAll('.bgp-pfx-expand').forEach(r => r.style.display = 'none');
          container.querySelectorAll('.bgp-pfx-row').forEach(r => r.classList.remove('expanded'));

          if (!wasOpen) {
            expandRow.style.display = '';
            row.classList.add('expanded');
            loadPrefixDetail(pfx, expandRow.querySelector('.bgp-pfx-detail-body'));
          }
        });
      });

      // Wire Trace buttons (pass VRF RT for disambiguation)
      container.querySelectorAll('.btn-trace-svc').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const pfx = btn.dataset.prefix;
          showTraceSourcePicker(btn, pfx, peOptions, rt);
        });
      });
    } catch (err) {
      container.innerHTML = `<p class="text-muted">Error: ${esc(err.message)}</p>`;
    }
  }

  /**
   * Fetch and render full BGP path detail for a prefix.
   */
  /** Fetch and render full BGP path detail for a prefix (on-demand vtysh query). */
  async function loadPrefixDetail(prefix, container) {
    if (!container) return;
    container.innerHTML = '<div class="reach-loading">Loading path detail...</div>';

    try {
      const result = await API.getBgpPrefixDetail(prefix);
      if (!result.paths || result.paths.length === 0) {
        container.innerHTML = '<p class="text-muted">No path detail available.</p>';
        return;
      }

      let html = '';
      for (const p of result.paths) {
        const originPE = p.originPE || p.originatorId || '—';
        const originatorPE = p.originatorPE || p.originatorId || '—';

        html += `<div class="bgp-path-detail">`;

        // Path summary banner
        html += `<div class="bgp-path-banner">
          ${p.bestpath ? '<span class="detail-badge green" style="font-size:0.65rem;">BEST</span>' : ''}
          ${p.valid ? '<span class="detail-badge cyan" style="font-size:0.65rem;">VALID</span>' : '<span class="detail-badge red" style="font-size:0.65rem;">INVALID</span>'}
          ${p.selectionReason ? `<span style="font-size:0.68rem;color:var(--text-muted);margin-left:6px;">${esc(p.selectionReason)}</span>` : ''}
        </div>`;

        // Two-column detail grid
        html += `<div class="bgp-path-grid">`;

        // Left column — core attributes
        html += `<div class="bgp-path-col">`;
        html += pathRow('Next-Hop', p.nextHop + (p.nextHopAccessible === false ? ' (unreachable)' : ''));
        html += pathRow('Origin PE', originPE);
        html += pathRow('AS Path', p.asPath || '—');
        html += pathRow('Origin', p.origin || '—');
        html += pathRow('Local Pref', p.locPref);
        if (p.med) html += pathRow('MED', p.med);
        html += pathRow('Label', p.label ? `<span class="detail-badge blue">${p.label}</span>` : '—', true);
        if (p.nextHopMetric !== null && p.nextHopMetric !== undefined) {
          html += pathRow('IGP Metric to NH', p.nextHopMetric);
        }
        html += `</div>`;

        // Right column — communities + reflection
        html += `<div class="bgp-path-col">`;

        // Extended Communities
        const extComms = (p.extCommunities || []).map(c => `${c.type}:${c.value}`);
        html += pathRow('Ext Communities', extComms.length > 0
          ? (p.extCommunities || []).map(c => {
              const badge = c.type === 'Color' ? 'pink' : 'cyan';
              return `<span class="detail-badge ${badge}" style="font-size:0.65rem;">${esc(c.type)}:${esc(String(c.value))}</span>`;
            }).join(' ')
          : '—', true);

        // Standard Communities
        html += pathRow('Communities', (p.communities || []).length > 0
          ? p.communities.map(c => `<span class="detail-badge cyan" style="font-size:0.65rem;">${esc(c)}</span>`).join(' ')
          : '—', true);

        // Originator & Cluster List
        html += pathRow('Originator ID', `${esc(p.originatorId || '—')}${p.originatorPE ? ` (${esc(p.originatorPE)})` : ''}`);
        html += pathRow('Cluster List', (p.clusterList || []).length > 0
          ? p.clusterList.map(c => `<span style="font-family:'JetBrains Mono',monospace;font-size:0.75rem;">${esc(c)}</span>`).join(' → ')
          : '—', true);

        // Peer info
        html += pathRow('Peer', `${esc(p.peer || '—')}${p.peerType ? ` (${esc(p.peerType)})` : ''}`);
        if (p.lastUpdate) html += pathRow('Last Update', p.lastUpdate);

        html += `</div>`;
        html += `</div>`; // close grid
        html += `</div>`; // close path-detail
      }

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<p class="text-muted">Error: ${esc(err.message)}</p>`;
    }
  }

  /** Helper: render a detail row. */
  function pathRow(label, value, isHtml) {
    return `<div class="bgp-path-row">
      <span class="bgp-path-label">${esc(label)}</span>
      <span class="bgp-path-value">${isHtml ? value : esc(String(value))}</span>
    </div>`;
  }

  // ── Service Path Trace ──────────────────────────────────────────
  let activeTracePicker = null;

  /**
   * Handle service trace from the topology-tab trace bar.
   */
  /** Handle Trace Service Path button from the topology-tab service bar. */
  async function handleSvcTrace() {
    const source = svcTraceSource.value;
    const prefix = svcTracePrefix.value.trim();
    const vrf = comboSvcVrf.getValue(); // RT value, or empty for all

    if (!source) {
      setStatus('error', 'Select a source PE');
      return;
    }
    if (!prefix || !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(prefix)) {
      setStatus('error', 'Enter a valid prefix (e.g., 92.1.1.2/32)');
      return;
    }

    await executeServiceTrace(source, prefix, vrf);
  }

  /**
   * Populate the VRF combo in the service trace bar from BGP data.
   */
  /** Populate the VRF combo in the service trace bar from BGP data. */
  async function refreshSvcTraceVrfs() {
    try {
      const vrfs = await API.getBgpVrfsByRT();
      const opts = [{ value: '', label: 'All VRFs' }];
      for (const v of (vrfs || [])) {
        opts.push({ value: v.rt, label: `RT ${v.rt}` });
      }
      comboSvcVrf.setOptions(opts);
    } catch {
      comboSvcVrf.setOptions([{ value: '', label: 'All VRFs' }]);
    }
  }

  /**
   * Show a small popup to pick the source PE for a service path trace.
   */
  /** Show source PE picker popup for tracing from the BGP tab. */
  function showTraceSourcePicker(btn, prefix, peOptions, vrfRt) {
    // Remove any existing picker
    if (activeTracePicker) { activeTracePicker.remove(); activeTracePicker = null; }

    const picker = document.createElement('div');
    picker.className = 'trace-picker';
    picker.innerHTML = `
      <div class="trace-picker-title">Trace service path to <strong>${esc(prefix)}</strong>${vrfRt ? ` <span class="detail-badge cyan" style="font-size:0.6rem;">RT ${esc(vrfRt)}</span>` : ''}</div>
      <div class="trace-picker-row">
        <label>From:</label>
        <select class="trace-picker-select">${peOptions}</select>
        <button class="btn btn-primary btn-sm trace-picker-go">Trace</button>
      </div>
    `;

    // Position below the button
    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(picker);
    activeTracePicker = picker;

    // Stop clicks inside the picker from bubbling to the VRF row collapse handler
    picker.addEventListener('click', (e) => e.stopPropagation());

    // Wire Go button
    picker.querySelector('.trace-picker-go').addEventListener('click', async () => {
      const source = picker.querySelector('.trace-picker-select').value;
      picker.remove();
      activeTracePicker = null;
      await executeServiceTrace(source, prefix, vrfRt || '');
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function dismiss(e) {
        if (!picker.contains(e.target) && e.target !== btn) {
          picker.remove();
          activeTracePicker = null;
          document.removeEventListener('click', dismiss);
        }
      });
    }, 0);
  }

  /**
   * Execute a service path trace and switch to topology view.
   */
  /** Execute a service path trace — detects Color steering, highlights path, shows detail. */
  async function executeServiceTrace(sourceNode, prefix, vrf, algoOverride) {
    const algoLabel = algoOverride != null ? ` (What if Algo ${algoOverride}?)` : '';
    setStatus('collecting', `Tracing ${prefix} from ${sourceNode}${algoLabel}...`);

    try {
      const result = await API.traceServicePath(sourceNode, prefix, vrf, algoOverride);

      if (result.error) {
        setStatus('error', result.error);
        return;
      }

      // Switch to topology tab
      switchTab('topology');

      // Set path bar dropdowns to match the trace
      const srcNode = topologyData?.nodes?.find(n => n.data.hostname === result.sourceNode);
      const dstNode = topologyData?.nodes?.find(n => n.data.hostname === result.destinationPE);

      if (srcNode) pathSource.value = srcNode.data.id;
      if (dstNode) pathDest.value = dstNode.data.id;
      pathFailNode.value = '';
      pathFailLink.value = '';

      // Determine effective algo (override or from trace)
      const effectiveAlgo = algoOverride ?? result.transportAlgorithm;

      // Set algo overlay
      if (effectiveAlgo >= 128) {
        pathAlgo.value = String(effectiveAlgo);
        topo.setAlgorithmOverlay(effectiveAlgo);
      } else {
        pathAlgo.value = '0';
        topo.setAlgorithmOverlay(0);
      }

      // Use existing path computation for highlighting
      if (effectiveAlgo >= 128 && srcNode && dstNode) {
        try {
          const faResult = await API.traceFlexAlgoPath(srcNode.data.id, dstNode.data.id, effectiveAlgo);
          if (faResult.reachable && faResult.hops?.length > 1) {
            const pathHops = [];
            for (let i = 0; i < faResult.hops.length - 1; i++) {
              pathHops.push({
                from: faResult.hops[i].systemId,
                to: faResult.hops[i + 1].systemId,
                fromHostname: faResult.hops[i].hostname,
                toHostname: faResult.hops[i + 1].hostname,
                edgeId: faResult.hops[i].edgeId || null,
              });
            }
            topo.highlightPath({
              source: faResult.hops[0].systemId,
              destination: faResult.hops[faResult.hops.length - 1].systemId,
              hops: pathHops,
            }, [], []);
          }
        } catch {
          // FlexAlgo highlight failed
        }
      } else if (srcNode && dstNode) {
        try {
          const analysis = await API.analyzePath(srcNode.data.id, dstNode.data.id);
          if (analysis?.primary) {
            topo.highlightPath(analysis.primary, [], []);
          }
        } catch {
          // SPF highlight failed
        }
      }

      // Show the service path detail panel with "What if" buttons
      showServicePathDetail(result, algoOverride);
      btnClearPath.style.display = 'inline-flex';

      const displayAlgo = algoOverride ?? result.colorCommunity;
      const algoStatus = displayAlgo != null ? `Algo ${displayAlgo} → ${effectiveAlgo >= 128 ? result.transportAlgorithmName || `Algo ${effectiveAlgo}` : 'IGP'}` : 'IGP';
      setStatus('live', `Service path: ${result.sourceNode} → ${result.prefix} via ${result.destinationPE} (${algoStatus})`);
    } catch (err) {
      setStatus('error', `Trace failed: ${err.message}`);
    }
  }

  /**
   * Render the service path detail panel.
   */
  /** Render the service path detail panel with label stack and What-If buttons. */
  function showServicePathDetail(result, algoOverride) {
    detailTitle.textContent = `${result.sourceNode} → ${result.prefix}`;

    let html = '';

    // Back button
    if (lastViewedNode) {
      html += `<button class="btn btn-ghost btn-sm btn-back-to-node" style="margin-bottom:10px;display:inline-flex;align-items:center;gap:4px;">← Back to ${esc(lastViewedNode.hostname || lastViewedNode.label)}</button>`;
    }

    // What-If banner
    if (result.isWhatIf) {
      html += `
        <div style="background:var(--accent-glow);border:1px solid var(--accent-dim);border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:10px;font-size:0.78rem;">
          <strong style="color:var(--accent);">⚡ What-If Simulation</strong><br>
          <span style="color:var(--text-secondary);">Showing path as if prefix had <strong>Color:${result.transportAlgorithm}</strong> (actual: ${result.actualAlgorithm ? `Color:${result.actualAlgorithm}` : 'no color'})</span>
        </div>`;
    }

    // Service path banner
    const hasColor = result.colorCommunity != null && !result.isWhatIf;
    const bannerColor = result.isWhatIf ? 'var(--accent)' : hasColor ? 'var(--amber)' : 'var(--accent)';
    html += `
      <div class="path-result-banner" style="border-left:3px solid ${bannerColor};">
        <span class="path-result-text">
          <strong>Service Path</strong> — ${esc(result.sourceNode)} → ${esc(result.prefix)}<br>
          Destination PE: <strong>${esc(result.destinationPE)}</strong>
          ${hasColor ? `<br>Color: <span class="detail-badge pink" style="font-size:0.65rem;">Color:${result.colorCommunity}</span> → <strong>${esc(result.transportAlgorithmName)}</strong>` : '<br>Transport: <strong>Standard IGP (Algo 0)</strong>'}
        </span>
      </div>`;

    // Label Stack — the crown jewel
    if (result.labelStack && result.labelStack.length > 0) {
      html += `<div class="detail-section">
        <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
          <h4 style="margin:0;">Label Stack (outer → inner)</h4>
          <div class="label-legend" style="margin:0;display:flex;align-items:center;gap:12px;padding:6px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-elevated);font-size:0.75rem;color:var(--text-muted);">
            <span style="font-weight:600;letter-spacing:0.03em;text-transform:uppercase;opacity:0.7;">Legend</span>
            <span style="display:inline-flex;align-items:center;gap:5px;"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:var(--green);"></span> Algo 0</span>
            <span style="display:inline-flex;align-items:center;gap:5px;"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:#ec84c4;"></span> FlexAlgo</span>
            <span style="display:inline-flex;align-items:center;gap:5px;"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:var(--blue);"></span> Service</span>
            <span style="display:inline-flex;align-items:center;gap:5px;"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:#e89a72;"></span> Adj-SID</span>
          </div>
        </div>`;
      html += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">`;
      for (const lbl of result.labelStack) {
        const color = labelTypeColor(lbl.type);
        html += `<span class="detail-badge ${color}" title="${esc(lbl.description)}" style="cursor:help;font-size:0.85rem;padding:4px 10px;">${lbl.label}</span>`;
      }
      html += `</div>`;
      // Decoded breakdown
      for (const lbl of result.labelStack) {
        html += `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:2px;">
          <strong>${esc(lbl.type)}</strong>: ${esc(lbl.description)}
        </div>`;
      }
      html += `</div>`;
    }

    // Transport path info
    if (result.transportPath) {
      const tp = result.transportPath;
      html += `<div class="detail-section"><h4>Transport Path (${esc(result.transportAlgorithmName)})</h4>`;
      html += `<div class="detail-row"><span class="detail-label">Algorithm</span><span class="detail-badge cyan">${result.transportAlgorithm}</span></div>`;
      if (tp.metric != null) {
        html += `<div class="detail-row"><span class="detail-label">Metric</span><span class="detail-value">${tp.metric}</span></div>`;
      }
      html += `<div class="detail-row"><span class="detail-label">Reachable</span><span class="detail-badge ${tp.reachable ? 'green' : 'red'}">${tp.reachable ? 'Yes' : 'No'}</span></div>`;

      // Hop list for standard IGP path
      if (tp.hops && tp.hops.length > 0) {
        html += '<ul class="path-hops">';
        html += `<li class="path-hop"><div class="path-hop-dot source"><div class="path-hop-dot-inner"></div></div><div class="path-hop-info"><div class="path-hop-name">${esc(result.sourceNode)}</div><div class="path-hop-detail">source</div></div></li>`;
        for (let i = 0; i < tp.hops.length; i++) {
          const hop = tp.hops[i];
          const isLast = i === tp.hops.length - 1;
          html += `<li class="path-hop"><div class="path-hop-dot ${isLast ? 'dest' : ''}"></div><div class="path-hop-info"><div class="path-hop-name">${esc(hop.toHostname)}</div><div class="path-hop-detail">via ${esc(hop.localAddr || '?')} → ${esc(hop.neighborAddr || '?')}</div></div></li>`;
        }
        html += '</ul>';
      }

      // FlexAlgo vias
      if (tp.vias && tp.vias.length > 0) {
        html += `<div style="margin-top:8px;font-size:0.78rem;color:var(--text-secondary);">Next-hop: <strong>${tp.vias.map(v => `${esc(v.nexthop)} (${esc(v.interface)})`).join(', ')}</strong></div>`;
      }

      html += `</div>`;
    }

    // BGP Attributes
    if (result.bgpAttributes) {
      const bgp = result.bgpAttributes;
      html += `<div class="detail-section"><h4>BGP Attributes</h4>`;
      html += `<div class="detail-row"><span class="detail-label">AS Path</span><span class="detail-value">${esc(bgp.asPath || '—')}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Origin</span><span class="detail-value">${esc(bgp.origin || '—')}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Local Pref</span><span class="detail-value">${bgp.locPref}</span></div>`;
      if (bgp.extCommunities?.length > 0) {
        html += `<div class="detail-row"><span class="detail-label">Ext Communities</span><span class="detail-value" style="display:flex;flex-wrap:wrap;gap:3px;">`;
        html += bgp.extCommunities.map(c => {
          const badge = c.type === 'Color' ? 'pink' : 'cyan';
          return `<span class="detail-badge ${badge}" style="font-size:0.65rem;">${esc(c.type)}:${esc(String(c.value))}</span>`;
        }).join('');
        html += `</span></div>`;
      }
      if (bgp.originatorId) {
        html += `<div class="detail-row"><span class="detail-label">Originator</span><span class="detail-value">${esc(bgp.originatorId)}</span></div>`;
      }
      if (bgp.clusterList?.length > 0) {
        html += `<div class="detail-row"><span class="detail-label">Cluster List</span><span class="detail-value">${bgp.clusterList.join(' → ')}</span></div>`;
      }
      html += `</div>`;
    }

    // "What if" algo simulation buttons
    const algos = result.availableAlgos || [];
    if (algos.length > 0) {
      html += `<div class="detail-section"><h4>What If…</h4>`;
      html += `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:8px;">Preview the transport path this prefix would take with a different Color community:</div>`;
      html += `<div style="display:flex;gap:6px;flex-wrap:wrap;">`;

      // IGP (no color) button
      const isIgpActive = result.transportAlgorithm === 0;
      html += `<button class="btn ${isIgpActive ? 'btn-primary' : 'btn-ghost'} btn-sm btn-whatif" data-algo="0" ${isIgpActive ? 'disabled' : ''}>No Color (IGP)</button>`;

      // FlexAlgo buttons
      for (const a of algos) {
        const isActive = result.transportAlgorithm === a.number;
        html += `<button class="btn ${isActive ? 'btn-primary' : 'btn-ghost'} btn-sm btn-whatif" data-algo="${a.number}" ${isActive ? 'disabled' : ''}>Color:${a.number} (${esc(a.name)})</button>`;
      }

      html += `</div></div>`;
    }

    detailBody.innerHTML = html;
    detailPanel.classList.add('open');

    // Wire back button
    const btnBack = detailBody.querySelector('.btn-back-to-node');
    if (btnBack) btnBack.addEventListener('click', backToNode);

    // Wire "What if" buttons
    detailBody.querySelectorAll('.btn-whatif').forEach((btn) => {
      btn.addEventListener('click', () => {
        const algo = parseInt(btn.dataset.algo, 10);
        executeServiceTrace(result.sourceNode, result.prefix, result.vrf, algo === 0 ? 0 : algo);
      });
    });
  }

  function populateBgpForm(config) {
    document.getElementById('bgpLocalAs').value = config.localAs || '';
    document.getElementById('bgpRouterId').value = config.routerId || '';
    document.getElementById('bgpSourceAddr').value = config.sourceAddress || '';
    document.getElementById('bgpAfiVpnv4').checked = config.addressFamilies?.vpnv4?.enabled !== false;
    document.getElementById('bgpAfiBgpLs').checked = config.addressFamilies?.bgpLs?.enabled !== false;
    document.getElementById('bgpFrrConfPath').value = config.frr?.configPath || '/etc/frr/frr.conf';
    document.getElementById('bgpFrrGrpcPort').value = config.frr?.grpcPort || 50051;

    // Populate neighbors
    const list = document.getElementById('bgpNeighborList');
    list.innerHTML = '';
    for (const nbr of (config.neighbors || [])) {
      addBgpNeighborRow(nbr.address, nbr.description);
    }

    // If no neighbors, add one empty row
    if (!config.neighbors || config.neighbors.length === 0) {
      addBgpNeighborRow('', '');
    }
  }

  function addBgpNeighborRow(address, description) {
    const list = document.getElementById('bgpNeighborList');
    const row = document.createElement('div');
    row.className = 'bgp-neighbor-row';
    row.innerHTML = `
      <input type="text" class="bgp-nbr-addr" placeholder="Neighbor IP" value="${esc(address || '')}" />
      <input type="text" class="bgp-nbr-desc" placeholder="Description (optional)" value="${esc(description || '')}" />
      <button class="btn btn-ghost btn-sm bgp-nbr-remove" title="Remove">✕</button>
    `;
    row.querySelector('.bgp-nbr-remove').addEventListener('click', () => {
      row.remove();
    });
    list.appendChild(row);
  }

  function readBgpFormConfig() {
    const neighbors = [];
    document.querySelectorAll('.bgp-neighbor-row').forEach((row) => {
      const addr = row.querySelector('.bgp-nbr-addr').value.trim();
      if (addr) {
        neighbors.push({
          address: addr,
          description: row.querySelector('.bgp-nbr-desc').value.trim(),
        });
      }
    });

    return {
      enabled: true,
      localAs: parseInt(document.getElementById('bgpLocalAs').value, 10) || 0,
      routerId: document.getElementById('bgpRouterId').value.trim(),
      sourceAddress: document.getElementById('bgpSourceAddr').value.trim(),
      neighbors,
      addressFamilies: {
        vpnv4: { enabled: document.getElementById('bgpAfiVpnv4').checked },
        bgpLs: { enabled: document.getElementById('bgpAfiBgpLs').checked },
      },
      frr: {
        managed: true,
        configPath: document.getElementById('bgpFrrConfPath').value.trim() || '/etc/frr/frr.conf',
        daemonsPath: '/etc/frr/daemons',
        grpcPort: parseInt(document.getElementById('bgpFrrGrpcPort').value, 10) || 50051,
        restartCommand: 'rc-service frr restart',
        statusCommand: 'rc-service frr status',
      },
    };
  }

  async function handleBgpPreview() {
    const config = readBgpFormConfig();
    const previewPanel = document.getElementById('bgpPreviewPanel');
    const previewCode = document.getElementById('bgpPreviewCode');

    try {
      const result = await API.previewBgpConfig(config);
      previewCode.textContent = result.frrConf;
      previewPanel.style.display = '';
    } catch (err) {
      previewCode.textContent = `Error: ${err.message}`;
      previewPanel.style.display = '';
    }
  }

  async function handleBgpDeploy() {
    const config = readBgpFormConfig();
    const statusEl = document.getElementById('bgpDeployStatus');
    const btn = document.getElementById('btnBgpDeploy');

    btn.disabled = true;
    statusEl.textContent = 'Deploying...';
    statusEl.className = 'bgp-deploy-status';

    try {
      const result = await API.deployBgpConfig(config);
      if (result.success) {
        statusEl.textContent = 'Deployed successfully. FRR restarted.';
        statusEl.classList.add('success');
        bgpConfigLoaded = false; // Force reload on next tab visit
        // Refresh status after a short delay for FRR to start
        setTimeout(() => refreshBgpPage(), 4000);
      } else {
        statusEl.textContent = result.message || 'Deploy partially completed';
        statusEl.classList.add(result.configSaved ? 'warn' : 'error');
      }
    } catch (err) {
      statusEl.textContent = `Deploy error: ${err.message}`;
      statusEl.classList.add('error');
    } finally {
      btn.disabled = false;
    }
  }

  // Wire BGP page events
  function initBgpPage() {
    document.getElementById('btnBgpRefresh')?.addEventListener('click', refreshBgpPage);
    document.getElementById('btnAddBgpNeighbor')?.addEventListener('click', () => addBgpNeighborRow('', ''));
    document.getElementById('btnBgpPreview')?.addEventListener('click', handleBgpPreview);
    document.getElementById('btnBgpDeploy')?.addEventListener('click', handleBgpDeploy);
    document.getElementById('btnBgpCopyConf')?.addEventListener('click', () => {
      const code = document.getElementById('bgpPreviewCode')?.textContent || '';
      copyToClipboard(code, document.getElementById('btnBgpCopyConf'));
    });
  }

  // ── Context Menu ────────────────────────────────────────────────
  const ctxMenuNode = $('#ctxMenuNode');
  const ctxMenuEdge = $('#ctxMenuEdge');
  let ctxTargetData = null; // Data of the right-clicked element

  function showNodeContextMenu(nodeData, mouseEvent) {
    hideContextMenus();
    ctxTargetData = nodeData;

    // Update header
    document.getElementById('ctxMenuNodeTitle').textContent = nodeData.hostname || nodeData.id;

    // Position and show
    positionContextMenu(ctxMenuNode, mouseEvent);
  }

  function showEdgeContextMenu(edgeData, mouseEvent) {
    hideContextMenus();
    ctxTargetData = edgeData;

    // Update header
    document.getElementById('ctxMenuEdgeTitle').textContent =
      `${edgeData.sourceLabel} ↔ ${edgeData.targetLabel}`;

    positionContextMenu(ctxMenuEdge, mouseEvent);
  }

  function positionContextMenu(menu, mouseEvent) {
    menu.style.display = 'block';

    // Position at cursor, keep within viewport
    let x = mouseEvent.clientX;
    let y = mouseEvent.clientY;
    const rect = menu.getBoundingClientRect();

    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;

    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function hideContextMenus() {
    ctxMenuNode.style.display = 'none';
    ctxMenuEdge.style.display = 'none';
    ctxTargetData = null;
  }

  // Dismiss on click anywhere outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ctx-menu')) hideContextMenus();
  });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.ctx-menu') && !e.target.closest('.topology-canvas')) {
      hideContextMenus();
    }
  });

  // Wire context menu item clicks
  document.querySelectorAll('.ctx-menu-item').forEach((item) => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      if (!ctxTargetData) return;

      switch (action) {
        case 'set-source':
          pathSource.value = ctxTargetData.id;
          updateSelectionMarkers();
          autoComputeIfReady();
          break;

        case 'set-dest':
          pathDest.value = ctxTargetData.id;
          updateSelectionMarkers();
          autoComputeIfReady();
          break;

        case 'fail-node':
          pathFailNode.value = ctxTargetData.id;
          updateSelectionMarkers();
          autoComputeIfReady();
          break;

        case 'clear-node-fail':
          pathFailNode.value = '';
          updateSelectionMarkers();
          break;

        case 'fail-link':
          pathFailLink.value = ctxTargetData.id;
          updateSelectionMarkers();
          autoComputeIfReady();
          break;

        case 'clear-link-fail':
          pathFailLink.value = '';
          updateSelectionMarkers();
          break;

        case 'view-node':
          showNodeDetail(ctxTargetData);
          break;

        case 'view-link':
          showEdgeDetail(ctxTargetData);
          break;
      }

      hideContextMenus();
    });
  });

  // Wire bandwidth cap submenu clicks
  document.querySelectorAll('[data-bw-cap]').forEach((item) => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!ctxTargetData) return;
      const edgeId = ctxTargetData.id;
      const capValue = item.dataset.bwCap;

      if (capValue === 'remove') {
        await API.removeBandwidthOverride(edgeId);
      } else {
        await API.setBandwidthOverride(edgeId, parseInt(capValue, 10));
      }

      // Refresh bandwidth data and re-apply overlay
      const data = await API.getBandwidth();
      lastBandwidthData = data;
      if (bandwidthOverlayActive && data?.edgeRates) {
        topo.applyBandwidthHeatmap(data.edgeRates);
      }

      hideContextMenus();
    });
  });

  /**
   * Update selection markers on the topology to reflect current dropdown state.
   */
  /** Update topology node highlights to reflect current path bar selections. */
  function updateSelectionMarkers() {
    topo.updateSelectionMarkers({
      source: pathSource.value || null,
      dest: pathDest.value || null,
      failNode: pathFailNode.value || null,
      failEdge: pathFailLink.value || null,
    });
  }

  /**
   * Auto-compute path when both source and destination are set.
   */
  /** Auto-compute path if source and destination are both selected. */
  function autoComputeIfReady() {
    if (pathSource.value && pathDest.value && pathSource.value !== pathDest.value) {
      handleComputePath();
    }
  }

  function getHostname(systemId) {
    if (!topologyData) return systemId;
    const node = topologyData.nodes.find((n) => n.data.id === systemId);
    return node?.data?.hostname || systemId;
  }

  function getEdgeLabel(edgeId) {
    if (!topologyData) return edgeId;
    const edge = topologyData.edges.find((e) => e.data.id === edgeId);
    if (edge) return `${edge.data.sourceLabel}↔${edge.data.targetLabel}`;
    return edgeId;
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

    // Wire up "Back to node" button
    const btnBack = detailBody.querySelector('.btn-back-to-node');
    if (btnBack) btnBack.addEventListener('click', backToNode);
  }

  function buildECMPDetailHTML(ecmpResult) {
    const colors = ['#22d3ee', '#fbbf24', '#a78bfa', '#fb7185'];

    let html = '';

    // Back-to-node navigation
    if (lastViewedNode) {
      html += `<button class="btn btn-ghost btn-sm btn-back-to-node" style="margin-bottom:10px;display:inline-flex;align-items:center;gap:4px;">← Back to ${esc(lastViewedNode.hostname || lastViewedNode.label)}</button>`;
    }

    html += `
      <div class="path-result-banner">
        <svg class="path-result-icon" viewBox="0 0 20 20" fill="var(--accent)">
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
      const labels = wireLabels(labelEntry?.labels || []);

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
      const labels = wireLabels(labelEntry?.labels || []);

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
        pathFailNode.value = btn.dataset.failNode;
        handleComputePath();
      });
    });

    // Wire up "Show on Map" buttons for link failures
    detailBody.querySelectorAll('.btn-show-link-backup').forEach((btn) => {
      btn.addEventListener('click', () => {
        pathFailLink.value = btn.dataset.failEdge;
        handleComputePath();
      });
    });

    // Wire up "Back to node" button
    const btnBack = detailBody.querySelector('.btn-back-to-node');
    if (btnBack) btnBack.addEventListener('click', backToNode);
  }

  /** Build the HTML for the primary/backup path detail panel. */
  function buildPathDetailHTML(pathData, analysis, failedNodes, failedEdges, failureLabel) {
    let html = '';

    // Back-to-node navigation
    if (lastViewedNode) {
      html += `<button class="btn btn-ghost btn-sm btn-back-to-node" style="margin-bottom:10px;display:inline-flex;align-items:center;gap:4px;">← Back to ${esc(lastViewedNode.hostname || lastViewedNode.label)}</button>`;
    }

    // Unreachable state
    if (!pathData) {
      html += `
        <div class="path-result-banner failure">
          <svg class="path-result-icon" viewBox="0 0 20 20" fill="var(--red)">
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
        <svg class="path-result-icon" viewBox="0 0 20 20" fill="${isBackup ? 'var(--amber)' : 'var(--accent)'}">
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
          const labels = wireLabels(entry.labels || []);
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
          const srgbBase = SRGB_BASE;
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
          const srgbBase = SRGB_BASE;
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
  /** Open the node detail side panel with full SR/FlexAlgo/reachability data. */
  async function showNodeDetail(nodeData) {
    lastViewedNode = nodeData;
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

    // Wire FlexAlgo path buttons
    detailBody.querySelectorAll('.btn-fa-paths').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const systemId = btn.dataset.systemId;
        const algo = btn.dataset.algo;
        const container = detailBody.querySelector('#faPathsContainer');
        if (!container) return;

        btn.disabled = true;
        btn.textContent = 'Loading...';
        container.innerHTML = '<div class="reach-loading">Querying device...</div>';

        try {
          const result = await API.getFlexAlgoPaths(systemId, algo);
          if (!result || !result.paths || result.paths.length === 0) {
            container.innerHTML = `<p class="text-muted">No Algo ${algo} paths found.</p>`;
            return;
          }

          let html = `<div style="margin-top:10px;">
            <div style="font-size:0.75rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">Algo ${algo} — ${esc(result.paths[0]?.algoName || '')} Paths from ${esc(result.source)}</div>
            <table class="devices-table bgp-prefix-table">
              <thead><tr><th>Destination</th><th>Node</th><th>Next-Hop</th><th>Interface</th><th>Metric</th><th>Status</th></tr></thead>
              <tbody>`;

          for (const p of result.paths) {
            const statusBadge = p.reachable
              ? '<span class="detail-badge green" style="font-size:0.65rem;">Reachable</span>'
              : '<span class="detail-badge amber" style="font-size:0.65rem;">No Path</span>';
            const via = p.vias[0] || {};
            html += `<tr>
              <td class="mono-md">${esc(p.destination)}</td>
              <td>${esc(p.destinationHostname || '—')}</td>
              <td class="mono-md">${esc(via.nexthop || '—')}</td>
              <td>${esc(via.interface || '—')}</td>
              <td>${p.metric !== null ? p.metric : '—'}</td>
              <td>${statusBadge}</td>
            </tr>`;
          }

          html += `</tbody></table></div>`;
          container.innerHTML = html;
        } catch (err) {
          container.innerHTML = `<p class="text-muted">Error: ${esc(err.message)}</p>`;
        } finally {
          btn.disabled = false;
          btn.textContent = `Algo ${algo} Paths`;
        }
      });
    });
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
      cliCopyBtn.addEventListener('click', () => {
        if (!lastOutput) return;
        copyToClipboard(lastOutput, cliCopyBtn);
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

  /** Open the edge detail side panel with IS-IS metrics, TE, and health. */
  function showEdgeDetail(edgeData) {
    detailTitle.textContent = `${edgeData.sourceLabel} ↔ ${edgeData.targetLabel}`;
    let html = buildEdgeDetailHTML(edgeData);

    // Inject live bandwidth section when overlay is active or data exists
    if (lastBandwidthData?.edgeRates) {
      const er = lastBandwidthData.edgeRates.find(e => e.edgeId === edgeData.id);
      if (er) {
        const physSpeed = er.speedBps ? TopologyRenderer.formatSpeed(er.speedBps) : 'Unknown';
        const effSpeed = er.effectiveSpeedBps ? TopologyRenderer.formatSpeed(er.effectiveSpeedBps) : physSpeed;
        const hasOverride = er.overrideSpeedBps != null;
        const utilLabel = er.utilization != null ? `${er.utilization.toFixed(1)}%` : '—';
        const utilColor = !er.utilization ? 'cyan'
          : er.utilization < 25 ? 'green'
          : er.utilization < 50 ? 'cyan'
          : er.utilization < 75 ? 'amber'
          : 'red';

        html += `
          <div class="detail-section">
            <h4>Live Bandwidth</h4>
            <div class="detail-row">
              <span class="detail-label">Physical Speed</span>
              <span class="detail-badge cyan">${physSpeed}</span>
            </div>
            ${hasOverride ? `<div class="detail-row">
              <span class="detail-label">Effective Speed (override)</span>
              <span class="detail-badge amber">${TopologyRenderer.formatSpeed(er.overrideSpeedBps)}</span>
              <button class="btn btn-ghost btn-sm" style="margin-left:8px;font-size:0.65rem;color:var(--red);" id="btnRemoveOverride">Remove</button>
            </div>` : ''}
            <div class="detail-row">
              <span class="detail-label">Utilization</span>
              <span class="detail-badge ${utilColor}">${utilLabel}</span>
              <span class="detail-value" style="margin-left:4px;font-size:0.72rem;color:var(--text-muted);">of ${effSpeed}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">In</span>
              <span class="detail-value">${formatRate(er.inBps)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Out</span>
              <span class="detail-value">${formatRate(er.outBps)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Peak (max direction)</span>
              <span class="detail-value">${formatRate(er.maxBps)}</span>
            </div>
            ${er.sourceInterface ? `<div class="detail-row">
              <span class="detail-label">${esc(er.source)} intf</span>
              <span class="detail-value font-mono">${esc(er.sourceInterface)}</span>
            </div>` : ''}
            ${er.targetInterface ? `<div class="detail-row">
              <span class="detail-label">${esc(er.target)} intf</span>
              <span class="detail-value font-mono">${esc(er.targetInterface)}</span>
            </div>` : ''}
            ${er.errors > 0 ? `<div class="detail-row">
              <span class="detail-label">Errors</span>
              <span class="detail-badge red">${er.errors}</span>
            </div>` : ''}
            ${er.discards > 0 ? `<div class="detail-row">
              <span class="detail-label">Discards</span>
              <span class="detail-badge amber">${er.discards}</span>
            </div>` : ''}
          </div>
          <div class="detail-section">
            <h4>Set Bandwidth Cap</h4>
            <p class="text-muted" style="font-size:0.72rem;margin-bottom:8px;">Override the effective speed for shaped or policed links.</p>
            <div style="display:flex;gap:6px;align-items:center;">
              <select class="input-field" id="bwOverrideSpeed" style="width:120px;">
                <option value="100000000" ${er.overrideSpeedBps === 100000000 ? 'selected' : ''}>100 Mbps</option>
                <option value="250000000" ${er.overrideSpeedBps === 250000000 ? 'selected' : ''}>250 Mbps</option>
                <option value="500000000" ${er.overrideSpeedBps === 500000000 ? 'selected' : ''}>500 Mbps</option>
                <option value="1000000000" ${er.overrideSpeedBps === 1000000000 ? 'selected' : ''}>1 Gbps</option>
                <option value="2500000000" ${er.overrideSpeedBps === 2500000000 ? 'selected' : ''}>2.5 Gbps</option>
                <option value="5000000000" ${er.overrideSpeedBps === 5000000000 ? 'selected' : ''}>5 Gbps</option>
                <option value="10000000000" ${er.overrideSpeedBps === 10000000000 ? 'selected' : ''}>10 Gbps</option>
                <option value="25000000000" ${er.overrideSpeedBps === 25000000000 ? 'selected' : ''}>25 Gbps</option>
                <option value="40000000000" ${er.overrideSpeedBps === 40000000000 ? 'selected' : ''}>40 Gbps</option>
                <option value="100000000000" ${er.overrideSpeedBps === 100000000000 ? 'selected' : ''}>100 Gbps</option>
              </select>
              <button class="btn btn-primary btn-sm" id="btnSetOverride">Apply</button>
            </div>
            <div id="overrideMsg" style="margin-top:6px;font-size:0.72rem;"></div>
          </div>`;
      }
    }

    detailBody.innerHTML = html;

    // Wire override buttons
    const setBtn = document.getElementById('btnSetOverride');
    if (setBtn) {
      setBtn.addEventListener('click', async () => {
        const speed = parseInt(document.getElementById('bwOverrideSpeed').value, 10);
        await API.setBandwidthOverride(edgeData.id, speed);
        document.getElementById('overrideMsg').innerHTML = '<span style="color:var(--green);">Override saved. Heatmap will update on next cycle.</span>';
        // Refresh bandwidth data
        const data = await API.getBandwidth();
        lastBandwidthData = data;
        if (bandwidthOverlayActive && data?.edgeRates) {
          topo.applyBandwidthHeatmap(data.edgeRates);
        }
        // Re-open detail with fresh data
        setTimeout(() => showEdgeDetail(edgeData), 500);
      });
    }
    const removeBtn = document.getElementById('btnRemoveOverride');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        await API.removeBandwidthOverride(edgeData.id);
        const data = await API.getBandwidth();
        lastBandwidthData = data;
        if (bandwidthOverlayActive && data?.edgeRates) {
          topo.applyBandwidthHeatmap(data.edgeRates);
        }
        setTimeout(() => showEdgeDetail(edgeData), 500);
      });
    }

    detailPanel.classList.add('open');
  }

  function closeDetail() {
    detailPanel.classList.remove('open');
  }

  /**
   * Navigate back to the last-viewed node detail, clearing path state.
   */
  function backToNode() {
    if (!lastViewedNode) return;
    topo.clearPath();
    currentPathResult = null;
    btnClearPath.style.display = 'none';
    pathSource.value = '';
    pathDest.value = '';
    pathFailNode.value = '';
    pathFailLink.value = '';
    topo.updateSelectionMarkers({ source: null, dest: null, failNode: null, failEdge: null });
    if (topologyData) {
      setStatus('live', `${topologyData.metadata.nodeCount} nodes, ${topologyData.metadata.edgeCount} links`);
    }
    showNodeDetail(lastViewedNode);
  }

  /** Build the complete HTML for the node detail panel. */
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

      // FlexAlgo — show participation and definitions
      const faAlgos = (caps.srAlgorithms || []).filter(a => a.number >= 128);
      const faDefs = caps.flexAlgoDefinitions || [];

      if (faAlgos.length > 0) {
        html += `<div class="detail-section"><h4>FlexAlgo</h4>`;

        // Algorithms this node participates in
        html += `<div class="detail-row"><span class="detail-label">Algorithms</span><span class="detail-value" style="display:flex;flex-wrap:wrap;gap:4px;">`;
        html += faAlgos.map(a => `<span class="detail-badge pink" style="font-size:0.65rem;">Algo ${a.number} — ${esc(a.name)}</span>`).join('');
        html += `</span></div>`;

        // FlexAlgo Definitions (if this node is the advertiser)
        if (faDefs.length > 0) {
          html += `<div style="margin-top:8px;font-size:0.68rem;color:var(--accent);font-weight:600;">⚑ FAD Advertiser</div>`;
          for (const fad of faDefs) {
            html += `<div style="margin-top:6px;padding:8px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm);">`;
            html += `<div style="font-weight:600;font-size:0.78rem;margin-bottom:4px;">Algo ${fad.algorithm}</div>`;
            html += `<div class="detail-row"><span class="detail-label">Metric Type</span><span class="detail-value">${esc(fad.metricType)}</span></div>`;
            html += `<div class="detail-row"><span class="detail-label">Calc Type</span><span class="detail-value">${esc(fad.calcType)}</span></div>`;
            html += `<div class="detail-row"><span class="detail-label">Priority</span><span class="detail-value">${fad.priority}</span></div>`;
            if (fad.excludeGroups?.length > 0) {
              html += `<div class="detail-row"><span class="detail-label">Exclude</span><span class="detail-value">${fad.excludeGroups.join(', ')}</span></div>`;
            }
            if (fad.includeAnyGroups?.length > 0) {
              html += `<div class="detail-row"><span class="detail-label">Include-Any</span><span class="detail-value">${fad.includeAnyGroups.join(', ')}</span></div>`;
            }
            if (fad.includeAllGroups?.length > 0) {
              html += `<div class="detail-row"><span class="detail-label">Include-All</span><span class="detail-value">${fad.includeAllGroups.join(', ')}</span></div>`;
            }
            html += `</div>`;
          }
        }

        // FA Prefix SIDs
        const faSids = (d.srPrefixSids || []).filter(s => s.algorithm >= 128);
        if (faSids.length > 0) {
          const srgbBase = d.routerCaps?.srgb?.[0]?.base || SRGB_BASE;
          html += `<div style="margin-top:8px;">`;
          for (const s of faSids) {
            const globalLabel = srgbBase + s.sid;
            html += `<div class="detail-row">
              <span class="detail-label">Algo ${s.algorithm} SID</span>
              <span class="detail-value">${esc(s.prefix)} <span class="detail-badge pink" style="margin-left:4px;">SID ${globalLabel}</span></span>
            </div>`;
          }
          html += `</div>`;
        }

        // FlexAlgo Paths button (loads on demand from the device via eAPI)
        html += `<div style="margin-top:10px;">`;
        for (const a of faAlgos) {
          html += `<button class="btn btn-ghost btn-sm btn-fa-paths" data-system-id="${esc(d.systemId)}" data-algo="${a.number}" style="margin-right:6px;">Algo ${a.number} Paths</button>`;
        }
        html += `</div>`;
        html += `<div id="faPathsContainer"></div>`;
        html += `</div>`;
      }
    }

    // SID color legend — show if node has any SIDs
    if ((d.srPrefixSids && d.srPrefixSids.length > 0) || (d.srAdjSids && d.srAdjSids.length > 0)) {
      html += buildSidLegendHTML();
    }

    // SR Prefix SIDs
    if (d.srPrefixSids && d.srPrefixSids.length > 0) {
      html += `
        <div class="detail-section">
          <h4>SR Prefix SIDs (${d.srPrefixSids.length})</h4>
          <ul class="prefix-list">
            ${d.srPrefixSids
              .map(
                (s) => {
                  let flags = '';
                  if (s.isNodeSid) flags += '<span class="detail-badge cyan" style="margin-left:4px;font-size:0.65rem;">N</span>';
                  if (s.noPHP) flags += '<span class="detail-badge amber" style="margin-left:4px;font-size:0.65rem;">noPHP</span>';
                  if (s.explicitNull) flags += '<span class="detail-badge green" style="margin-left:4px;font-size:0.65rem;">E</span>';
                  const sidColor = (s.algorithm || 0) >= 128 ? 'pink' : 'green';
                  const srgbBase = d.routerCaps?.srgb?.[0]?.base || SRGB_BASE;
                  const globalLabel = srgbBase + s.sid;
                  return `<li>${esc(s.prefix)}<span class="detail-badge ${sidColor}" style="margin-left:8px;">SID ${globalLabel}</span><span class="prefix-metric">algo ${s.algorithm}</span>${flags}</li>`;
                }
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
                  `<li>→ ${esc(s.neighbor)}<span class="detail-badge brown" style="margin-left:8px;">${s.sid}</span></li>`
              )
              .join('')}
          </ul>
        </div>`;
    }

    // IS Neighbors (derived from topology edges)
    if (topologyData) {
      const nodeId = d.id;
      const neighbors = [];

      for (const edge of topologyData.edges) {
        const ed = edge.data;
        if (ed.source === nodeId) {
          neighbors.push({
            hostname: ed.targetLabel,
            systemId: ed.target,
            localAddr: ed.localAddr,
            neighborAddr: ed.neighborAddr,
            metric: ed.metric,
            adjSids: ed.adjSids || [],
            localIntf: ed.forwardHealth?.localInterface || '',
          });
        } else if (ed.target === nodeId) {
          neighbors.push({
            hostname: ed.sourceLabel,
            systemId: ed.source,
            localAddr: ed.reverseLocalAddr || ed.neighborAddr,
            neighborAddr: ed.reverseNeighborAddr || ed.localAddr,
            metric: ed.reverseMetric ?? ed.metric,
            adjSids: ed.reverseAdjSids || [],
            localIntf: ed.reverseHealth?.localInterface || '',
          });
        }
      }

      if (neighbors.length > 0) {
        html += `
          <div class="detail-section">
            <h4>IS Neighbors (${neighbors.length})</h4>`;

        for (const nbr of neighbors) {
          const adjStr = nbr.adjSids.length > 0
            ? nbr.adjSids.map((s) => `<span class="detail-badge brown" style="font-size:0.65rem;">Adj ${s.sid}</span>`).join(' ')
            : '';
          html += `
            <div style="padding:6px 0;border-bottom:1px solid var(--border);">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
                <strong style="font-size:0.82rem;">${esc(nbr.hostname)}</strong>
                <span class="detail-badge cyan" style="font-size:0.62rem;">metric ${nbr.metric}</span>
                ${adjStr}
              </div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--text-muted);">
                ${nbr.localIntf ? esc(nbr.localIntf) + ' — ' : ''}${esc(nbr.localAddr || '?')} → ${esc(nbr.neighborAddr || '?')}
              </div>
            </div>`;
        }

        html += `</div>`;
      }
    }

    // Advertised IPv4 Reachability
    if (d.prefixes && d.prefixes.length > 0) {
      html += `
        <div class="detail-section">
          <h4>Advertised IPv4 Reachability (${d.prefixes.length})</h4>
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
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;font-size:0.68rem;color:var(--text-muted);">
          <span style="display:inline-flex;align-items:center;gap:3px;">
            <svg viewBox="0 0 20 20" fill="var(--green)" style="width:14px;height:14px;"><path fill-rule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM13.707 8.707a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
            Protected
          </span>
          <span style="display:inline-flex;align-items:center;gap:3px;">
            <svg viewBox="0 0 20 20" fill="var(--accent)" style="width:14px;height:14px;"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>
            ECMP
          </span>
          <span style="display:inline-flex;align-items:center;gap:3px;">
            <svg viewBox="0 0 20 20" fill="var(--amber)" style="width:14px;height:14px;"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
            Unprotected
          </span>
        </div>
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
          ${SR_QUICK_PICKS.map(
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
            <span class="reach-sid detail-badge cyan">SID ${SRGB_BASE + entry.sid}</span>
          </div>
          <span class="reach-meta">${entry.hopCount}h / m${entry.metric}</span>
        </div>
        <div class="reach-expand" id="${rowId}">
          <div class="reach-expand-section">
            <div class="reach-expand-label">Primary Path</div>
            <div class="reach-path-chain">${entry.primaryChain.join(' → ')}</div>
            ${wireLabels(entry.primaryLabelStack).length > 0 ? `
              <div class="reach-label-stack">
                ${wireLabels(entry.primaryLabelStack).map(l => {
                  const decoded = decodeSrLabel(l);
                  return '<span class="detail-badge ' + decoded.color + '" title="' + esc(decoded.description) + '" style="cursor:help;font-size:0.7rem;">' + esc(l) + '</span>';
                }).join('')}
              </div>` : ''}
          </div>
          ${wireLabels(entry.backupLabelStack).length > 0 ? `
            <div class="reach-expand-section">
              <div class="reach-expand-label">TI-LFA Backup Stack</div>
              <div class="reach-label-stack">
                ${wireLabels(entry.backupLabelStack).map(l => {
                  const decoded = decodeSrLabel(l);
                  return '<span class="detail-badge ' + decoded.color + '" title="' + esc(decoded.description) + '" style="cursor:help;font-size:0.7rem;">' + esc(l) + '</span>';
                }).join('')}
              </div>
              <div style="font-size:0.68rem;color:var(--text-muted);margin-top:3px;">
                ${wireLabels(entry.backupLabelStack).map(l => decodeSrLabel(l).description).join(' → ')}
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
          icon: '<svg viewBox="0 0 20 20" fill="var(--green)"><path fill-rule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM13.707 8.707a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>',
        };
      case 'ecmp':
        return {
          title: 'ECMP (Multiple Equal-Cost Paths)',
          icon: '<svg viewBox="0 0 20 20" fill="var(--accent)"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>',
        };
      default:
        return {
          title: 'Unprotected',
          icon: '<svg viewBox="0 0 20 20" fill="var(--amber)"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>',
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

        // Compute primary first to find a transit node or link to fail
        const analysis = await API.analyzePath(sourceId, destId);
        let foundBackup = false;

        // Try node protection first (transit node failure)
        if (analysis.nodeBackups && analysis.nodeBackups.length > 0) {
          const firstBackup = analysis.nodeBackups.find((b) => b.backupPath);
          if (firstBackup) {
            pathFailNode.value = firstBackup.failedNode;
            foundBackup = true;
          }
        }

        // Fall back to link protection (direct link failure)
        if (!foundBackup && analysis.linkBackups && analysis.linkBackups.length > 0) {
          const firstBackup = analysis.linkBackups.find((b) => b.backupPath);
          if (firstBackup) {
            pathFailLink.value = firstBackup.failedEdgeId;
            pathFailNode.value = '';
            foundBackup = true;
          }
        }

        handleComputePath();
      });
    });
  }

  /** Build the complete HTML for the edge detail panel. */
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
      html += buildSidLegendHTML();
      html += `
        <div class="detail-section">
          <h4>Adjacency SIDs</h4>
          ${d.adjSids.map(s =>
            `<div class="detail-row"><span class="detail-label">${esc(d.sourceLabel)} → ${esc(d.targetLabel)}</span><span class="detail-badge brown">${s.sid}</span></div>`
          ).join('')}`;

      // Reverse Adj-SIDs
      if (d.reverseAdjSids && d.reverseAdjSids.length > 0) {
        html += d.reverseAdjSids.map(s =>
          `<div class="detail-row"><span class="detail-label">${esc(d.targetLabel)} → ${esc(d.sourceLabel)}</span><span class="detail-badge brown">${s.sid}</span></div>`
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

    // Traffic Engineering metrics
    if (d.forwardDelay != null || d.reverseDelay != null || d.forwardTeMetric || d.reverseTeMetric) {
      html += `<div class="detail-section"><h4>Traffic Engineering</h4>`;

      // Delay
      if (d.forwardDelay != null || d.reverseDelay != null) {
        if (d.forwardDelay != null) {
          html += `<div class="detail-row">
            <span class="detail-label">${esc(d.sourceLabel)} → ${esc(d.targetLabel)} Delay</span>
            <span class="detail-badge amber">${d.forwardDelay} ms</span>
          </div>`;
        }
        if (d.reverseDelay != null) {
          html += `<div class="detail-row">
            <span class="detail-label">${esc(d.targetLabel)} → ${esc(d.sourceLabel)} Delay</span>
            <span class="detail-badge amber">${d.reverseDelay} ms</span>
          </div>`;
        }
      }

      // TE Metric
      if (d.forwardTeMetric) {
        html += `<div class="detail-row">
          <span class="detail-label">${esc(d.sourceLabel)} → ${esc(d.targetLabel)} TE Metric</span>
          <span class="detail-badge cyan">${d.forwardTeMetric}</span>
        </div>`;
      }
      if (d.reverseTeMetric) {
        html += `<div class="detail-row">
          <span class="detail-label">${esc(d.targetLabel)} → ${esc(d.sourceLabel)} TE Metric</span>
          <span class="detail-badge cyan">${d.reverseTeMetric}</span>
        </div>`;
      }

      // Admin Groups
      if (d.forwardAdminGroupNames?.length > 0) {
        html += `<div class="detail-row">
          <span class="detail-label">${esc(d.sourceLabel)} Admin Groups</span>
          <span class="detail-value">${d.forwardAdminGroupNames.map(g => `<span class="detail-badge cyan" style="font-size:0.65rem;">${esc(g)}</span>`).join(' ')}</span>
        </div>`;
      }
      if (d.reverseAdminGroupNames?.length > 0) {
        html += `<div class="detail-row">
          <span class="detail-label">${esc(d.targetLabel)} Admin Groups</span>
          <span class="detail-value">${d.reverseAdminGroupNames.map(g => `<span class="detail-badge cyan" style="font-size:0.65rem;">${esc(g)}</span>`).join(' ')}</span>
        </div>`;
      }

      html += `</div>`;
    }

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

  // ── Status Indicator ──────────────────────────────────────────────
  /** Update the top-right status indicator (live/collecting/error). */
  function setStatus(state, text) {
    statusDot.className = 'status-dot';
    if (state === 'live') statusDot.classList.add('live');
    if (state === 'collecting') statusDot.classList.add('collecting');
    if (state === 'error') statusDot.classList.add('error');
    statusText.textContent = text;
  }

  // ── Utility ───────────────────────────────────────────────────────

  /** Build the SID color legend HTML — reused across detail panels. */
  function buildSidLegendHTML() {
    return `<div style="display:flex;align-items:center;gap:12px;padding:6px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-elevated);font-size:0.75rem;color:var(--text-muted);margin-bottom:12px;">
      <span style="font-weight:600;letter-spacing:0.03em;text-transform:uppercase;opacity:0.7;">Legend</span>
      <span style="display:inline-flex;align-items:center;gap:5px;"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:var(--green);"></span> Algo 0</span>
      <span style="display:inline-flex;align-items:center;gap:5px;"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:#ec84c4;"></span> FlexAlgo</span>
      <span style="display:inline-flex;align-items:center;gap:5px;"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:#e89a72;"></span> Adj-SID</span>
    </div>`;
  }

  /**
   * Map a label type string to a badge color class.
   *   blue  = Service Label (VPN/MPLS label carried in BGP)
   *   green = Transport Label, Algo 0 (standard SPF Prefix-SID)
   *   pink  = Transport Label, FlexAlgo (algo 128-255 Prefix-SID)
   *   brown = Adjacency SID
   */
  function labelTypeColor(type) {
    if (type === 'VPN Label') return 'blue';
    if (/^FlexAlgo/.test(type)) return 'pink';
    if (/Adj.SID/.test(type)) return 'brown';
    return 'green';
  }

  /** Escape HTML entities to prevent XSS in dynamic content. */
  function esc(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  /**
   * Filter labels for display — removes Implicit Null (3) since it never
   * appears on the wire (PHP pops it before the packet arrives).
   */
  /** Filter Implicit Null (label 3) from label stack displays. */
  function wireLabels(labels) {
    return labels.filter(l => String(l) !== '3');
  }

  /**
   * Decode an SR MPLS label into a human-readable description.
   * Uses knowledge of the SRGB range and known prefix-SIDs.
   */
  /** Decode an SR label into its type (Prefix-SID, Adj-SID, etc.) with colors. */
  function decodeSrLabel(labelStr) {
    const label = parseInt(labelStr, 10);
    // Uses shared SRGB_BASE / SRGB_END / SRLB_BASE / SRLB_END constants

    // Implicit null (PHP) — popped before the packet arrives, never on the wire
    if (label === 3) {
      return { description: 'Implicit Null (PHP)', color: 'brown' };
    }

    // SRGB range — Prefix-SID (algo 0 = green/transport, algo 128+ = pink/FlexAlgo)
    if (label >= SRGB_BASE && label < SRGB_END) {
      const sid = label - SRGB_BASE;
      // Try to find the node with this prefix-SID and determine its algorithm
      let nodeName = '';
      let isFlexAlgo = false;
      if (topologyData) {
        for (const node of topologyData.nodes) {
          const match = (node.data.srPrefixSids || []).find((s) => s.sid === sid);
          if (match) {
            nodeName = ` (${node.data.hostname})`;
            isFlexAlgo = (match.algorithm || 0) >= 128;
            break;
          }
        }
      }
      const color = isFlexAlgo ? 'pink' : 'green';
      const algoLabel = isFlexAlgo ? ` Algo ${(topologyData?.nodes || []).flatMap(n => n.data.srPrefixSids || []).find(s => s.sid === sid)?.algorithm || '?'}` : '';
      return { description: `Prefix-SID ${sid}${algoLabel}${nodeName}`, color };
    }

    // SRLB range — likely Adj-SID (dynamic)
    if (label >= SRLB_BASE && label < SRLB_END) {
      return { description: `Adj-SID ${label} (SRLB)`, color: 'brown' };
    }

    // Below SRGB — likely a dynamic Adj-SID from the local label space
    if (label > 15 && label < SRGB_BASE) {
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
      return { description: `Adj-SID ${label}${adjInfo}`, color: 'brown' };
    }

    return { description: `Label ${label}`, color: 'cyan' };
  }

  // ── sFlow — Flows Tab + Topology Overlay ────────────────────────

  /**
   * Format bits per second into a human-readable rate string.
   */
  function formatRate(bps) {
    if (bps >= 1_000_000_000) return `${(bps / 1_000_000_000).toFixed(2)} Gbps`;
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
    if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} Kbps`;
    return `${bps} bps`;
  }

  /**
   * Refresh the Flows tab with current sFlow data.
   */
  async function refreshFlowsPage() {
    try {
      const [status, flows, tunnelData] = await Promise.all([
        API.getSflowStatus(),
        API.getSflowFlows(),
        API.getTunnelRates(),
      ]);

      // Update status cards
      const collectorEl = document.getElementById('sflowCollectorStatus');
      const datagramEl = document.getElementById('sflowDatagramCount');
      const flowEl = document.getElementById('sflowFlowCount');
      const mplsEl = document.getElementById('sflowMplsCount');
      const lspEl = document.getElementById('sflowLspCount');

      if (collectorEl) {
        const running = status.collector?.running;
        collectorEl.textContent = running ? `UDP :${status.config?.port || 6343}` : 'Stopped';
        collectorEl.style.color = running ? 'var(--status-healthy)' : 'var(--text-muted)';
      }
      if (datagramEl) datagramEl.textContent = (status.collector?.datagramsValid || 0).toLocaleString();
      if (flowEl) flowEl.textContent = (status.collector?.flowSamples || 0).toLocaleString();
      if (mplsEl) mplsEl.textContent = (status.collector?.mplsFlows || 0).toLocaleString();

      // Active LSPs = tunnel counter entries with non-zero rates + sFlow LSPs
      const tunnelRates = tunnelData?.rates || [];
      lastTunnelRates = tunnelRates;
      const activeTunnels = tunnelRates.filter((r) => r.bitsPerSec > 0 || r.counterInUse).length;
      const sflowLsps = flows?.lspFlows?.length || 0;
      if (lspEl) lspEl.textContent = Math.max(activeTunnels, sflowLsps).toLocaleString();

      // Update flow table — tunnel rates are the primary source
      lastFlowSnapshot = flows;
      renderFlowsTable(tunnelRates, flows);
    } catch (err) {
      console.error('Failed to refresh flows page:', err);
    }
  }

  /**
   * Render the per-LSP flow table.
   * Primary rate source: tunnel counters (deterministic from eAPI).
   * Enrichment: sFlow top talkers for drill-down detail.
   *
   * @param {Array} tunnelRates - Tunnel counter rate records from poller
   * @param {Object} sflowSnapshot - sFlow flow snapshot (for top talkers)
   */
  function renderFlowsTable(tunnelRates, sflowSnapshot) {
    const tbody = document.getElementById('sflowLspTableBody');
    const countEl = document.getElementById('sflowLspTableCount');
    if (!tbody) return;

    tunnelRates = tunnelRates || [];
    const sflowLsps = sflowSnapshot?.lspFlows || [];

    // Build a lookup from sFlow LSPs by "sourceNode→destNode:algoN"
    const sflowByKey = new Map();
    for (const lsp of sflowLsps) {
      sflowByKey.set(lsp.lspKey, lsp);
    }

    // Merge: tunnel counter rows enriched with sFlow top talkers
    const rows = [];

    for (const tc of tunnelRates) {
      // Build the sFlow-compatible LSP key for matching
      // tc.device = source PE, tc.destHostname = destination PE
      const sflowKey0 = `${tc.device}→${tc.destHostname}:${tc.algoTag}`;
      const sflowMatch = sflowByKey.get(sflowKey0);

      rows.push({
        lspKey: sflowKey0,
        source: tc.device,
        dest: tc.destHostname,
        endpoint: tc.endpoint,
        tunnelType: tc.tunnelType,
        algoTag: tc.algoTag,
        bitsPerSec: tc.bitsPerSec,
        bytesPerSec: tc.bytesPerSec,
        packetsPerSec: tc.packetsPerSec,
        txBytes: tc.txBytes,
        txPackets: tc.txPackets,
        counterInUse: tc.counterInUse,
        vias: tc.vias,
        // sFlow enrichment
        topTalkers: sflowMatch?.topTalkers || [],
        sflowBps: sflowMatch?.bitsPerSec || 0,
        rateSource: 'counter',
      });

      // Remove matched sFlow entry so we don't double-show it
      if (sflowMatch) sflowByKey.delete(sflowKey0);
    }

    // Include sFlow-only LSPs that don't have tunnel counter matches
    for (const [key, lsp] of sflowByKey) {
      rows.push({
        lspKey: key,
        source: lsp.sourceNode,
        dest: lsp.destNode,
        endpoint: '',
        tunnelType: '',
        algoTag: lsp.algorithm > 0 ? `algo${lsp.algorithm}` : 'algo0',
        bitsPerSec: lsp.bitsPerSec || 0,
        bytesPerSec: lsp.bytesPerSec || 0,
        packetsPerSec: lsp.packetsPerSec || 0,
        txBytes: 0,
        txPackets: 0,
        counterInUse: false,
        vias: [],
        topTalkers: lsp.topTalkers || [],
        sflowBps: lsp.bitsPerSec || 0,
        rateSource: 'sflow',
      });
    }

    // Sort by rate descending
    rows.sort((a, b) => b.bitsPerSec - a.bitsPerSec);

    if (countEl) countEl.textContent = `${rows.length} tunnel${rows.length !== 1 ? 's' : ''}`;

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No flow data yet — configure sFlow on your Arista devices</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((row) => {
      const isFA = row.algoTag.startsWith('flex') || (row.algoTag !== 'algo0' && row.algoTag.startsWith('algo'));
      const algoTag = isFA
        ? `<span class="badge badge-algo">FA</span>`
        : '<span class="badge">SPF</span>';

      const topTalker = row.topTalkers && row.topTalkers.length > 0
        ? `<span class="text-muted" style="font-size:10px;">${row.topTalkers[0].srcIP} → ${row.topTalkers[0].dstIP}</span>`
        : '—';

      const rateClass = row.bitsPerSec >= 100_000_000 ? 'text-warn'
        : row.bitsPerSec >= 10_000_000 ? 'text-amber' : '';

      // Rate source indicator
      const rateIcon = row.rateSource === 'counter' ? '' : '<span title="Sampled (sFlow)" style="opacity:0.5;">~</span>';

      return `<tr class="sflow-lsp-row" data-lsp-key="${encodeURIComponent(row.lspKey)}">
        <td class="font-mono" style="font-size:11px;">${row.source} → ${row.dest}</td>
        <td>${row.source}</td>
        <td>${row.dest}</td>
        <td>${algoTag}</td>
        <td class="${rateClass}" style="font-weight:600;">${rateIcon}${formatRate(row.bitsPerSec)}</td>
        <td class="text-muted">${(row.packetsPerSec || 0).toLocaleString()}</td>
        <td>${topTalker}</td>
        <td><button class="btn btn-ghost btn-sm btn-trace-lsp" data-lsp-key="${encodeURIComponent(row.lspKey)}">Trace</button></td>
      </tr>`;
    }).join('');

    // Bind trace buttons
    tbody.querySelectorAll('.btn-trace-lsp').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const lspKey = decodeURIComponent(btn.dataset.lspKey);
        const detail = await API.getSflowLspDetail(lspKey);
        if (detail) {
          topo.highlightLspFlow(detail, topologyData);
          topo.startFlowAnimation();
          switchTab('topology');
        }
      });
    });

    // Bind row click to show detail
    tbody.querySelectorAll('.sflow-lsp-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const lspKey = decodeURIComponent(row.dataset.lspKey);
        // Try sFlow detail first, then build from tunnel counter data
        const detail = await API.getSflowLspDetail(lspKey);
        if (detail) {
          showLspDetailPanel(detail);
        } else {
          // Build a basic detail panel from the tunnel counter row data
          const match = rows.find((r) => r.lspKey === lspKey);
          if (match) showLspDetailPanel({
            lspKey: match.lspKey,
            sourceNode: match.source,
            destNode: match.dest,
            algorithm: match.algoTag === 'algo0' ? 0 : 128,
            bitsPerSec: match.bitsPerSec,
            bytesPerSec: match.bytesPerSec,
            packetsPerSec: match.packetsPerSec,
            labels: [],
            topTalkers: match.topTalkers,
            edgePath: [],
          });
        }
      });
    });
  }

  /**
   * Show detailed info for a specific LSP in the detail panel.
   */
  function showLspDetailPanel(detail) {
    detailTitle.textContent = 'LSP Flow Detail';

    let html = `
      <div class="detail-section">
        <div class="detail-row"><span class="detail-label">LSP</span><span class="detail-value font-mono">${detail.lspKey}</span></div>
        <div class="detail-row"><span class="detail-label">Source</span><span class="detail-value">${detail.sourceNode}</span></div>
        <div class="detail-row"><span class="detail-label">Destination</span><span class="detail-value">${detail.destNode}</span></div>
        <div class="detail-row"><span class="detail-label">Algorithm</span><span class="detail-value">${detail.algorithm > 0 ? 'FlexAlgo ' + detail.algorithm : 'SPF (algo 0)'}</span></div>
        <div class="detail-row"><span class="detail-label">Rate</span><span class="detail-value" style="font-weight:600; color:var(--accent);">${formatRate(detail.bitsPerSec)}</span></div>
        <div class="detail-row"><span class="detail-label">Packets/sec</span><span class="detail-value">${(detail.packetsPerSec || 0).toLocaleString()}</span></div>
        <div class="detail-row"><span class="detail-label">Labels</span><span class="detail-value font-mono">${(detail.labels || []).join(' → ') || '—'}</span></div>
      </div>`;

    // Top talkers
    if (detail.topTalkers && detail.topTalkers.length > 0) {
      html += `<div class="detail-section">
        <h4 class="detail-section-title">Top Talkers</h4>
        <table class="detail-mini-table">
          <thead><tr><th>Source</th><th>Destination</th><th>Proto</th><th>Bytes</th></tr></thead>
          <tbody>`;

      for (const t of detail.topTalkers.slice(0, 10)) {
        const proto = t.ipProtocol === 6 ? 'TCP' : t.ipProtocol === 17 ? 'UDP' : (t.ipProtocol || '—');
        const port = t.dstPort ? `:${t.dstPort}` : '';
        html += `<tr>
          <td class="font-mono" style="font-size:10px;">${t.srcIP || '—'}${t.srcPort ? ':' + t.srcPort : ''}</td>
          <td class="font-mono" style="font-size:10px;">${t.dstIP || '—'}${port}</td>
          <td>${proto}</td>
          <td>${formatRate(t.bytes * 8 / 30)}</td>
        </tr>`;
      }

      html += '</tbody></table></div>';
    }

    detailBody.innerHTML = html;
    detailPanel.classList.add('open');
  }

  /**
   * Toggle the flow heatmap overlay on the topology.
   */
  function toggleFlowOverlay() {
    flowOverlayActive = !flowOverlayActive;
    // Turn off bandwidth overlay if turning on sFlow overlay
    if (flowOverlayActive && bandwidthOverlayActive) toggleBandwidthOverlay();

    const btnTopo = document.getElementById('btnTopoFlowOverlay');
    const btnFlows = document.getElementById('btnToggleFlowOverlay');

    if (flowOverlayActive) {
      if (btnTopo) btnTopo.classList.add('topo-btn-active');
      if (btnFlows) btnFlows.textContent = '🔥 Overlay On';
      if (lastFlowSnapshot) {
        topo.applyFlowHeatmap(lastFlowSnapshot);
        topo.startFlowAnimation();
      }
    } else {
      if (btnTopo) btnTopo.classList.remove('topo-btn-active');
      if (btnFlows) btnFlows.textContent = '🔥 Overlay Off';
      topo.clearFlowOverlay();
    }
  }

  /**
   * Toggle the live bandwidth heatmap overlay on the topology.
   * Colors links based on real-time interface rates from gNMI counter deltas.
   */
  function toggleBandwidthOverlay() {
    bandwidthOverlayActive = !bandwidthOverlayActive;
    // Turn off sFlow overlay if turning on bandwidth overlay
    if (bandwidthOverlayActive && flowOverlayActive) toggleFlowOverlay();

    const btn = document.getElementById('btnTopoBandwidthOverlay');

    if (bandwidthOverlayActive) {
      if (btn) btn.classList.add('topo-btn-active');
      // Apply immediately with cached data if available
      if (lastBandwidthData?.edgeRates) {
        topo.applyBandwidthHeatmap(lastBandwidthData.edgeRates);
      }
      // Also fetch fresh data
      API.getBandwidth().then((data) => {
        lastBandwidthData = data;
        if (bandwidthOverlayActive && data?.edgeRates) {
          topo.applyBandwidthHeatmap(data.edgeRates);
        }
      }).catch(() => {});
    } else {
      if (btn) btn.classList.remove('topo-btn-active');
      topo.clearFlowOverlay();
    }
  }

  /**
   * Initialize sFlow page event bindings.
   */
  function initFlowsPage() {
    // Refresh button
    document.getElementById('btnSflowRefresh')?.addEventListener('click', refreshFlowsPage);

    // Overlay toggle (both the flows tab button and topo toolbar button)
    document.getElementById('btnToggleFlowOverlay')?.addEventListener('click', toggleFlowOverlay);
    document.getElementById('btnTopoFlowOverlay')?.addEventListener('click', toggleFlowOverlay);

    // Bandwidth heatmap overlay toggle (topo toolbar)
    document.getElementById('btnTopoBandwidthOverlay')?.addEventListener('click', toggleBandwidthOverlay);

    // Bandwidth settings gear button
    document.getElementById('btnBwSettings')?.addEventListener('click', () => {
      const panel = document.getElementById('bwSettingsPanel');
      if (!panel) return;
      const visible = panel.style.display !== 'none';
      panel.style.display = visible ? 'none' : '';
      if (!visible) {
        // Load current settings into inputs
        const settings = topo.getBandwidthSettings();
        const speedEl = document.getElementById('bwLinkSpeed');
        if (speedEl) speedEl.value = String(settings.linkSpeedBps);
        for (let i = 0; i < 6; i++) {
          const el = document.getElementById(`bwT${i + 1}`);
          if (el) el.value = settings.thresholds[i] || 0;
        }
      }
    });

    // Bandwidth settings Apply button
    document.getElementById('btnBwSettingsSave')?.addEventListener('click', () => {
      const speedEl = document.getElementById('bwLinkSpeed');
      const linkSpeedBps = parseInt(speedEl?.value, 10) || 10_000_000_000;
      const thresholds = [];
      for (let i = 0; i < 6; i++) {
        const el = document.getElementById(`bwT${i + 1}`);
        thresholds.push(parseInt(el?.value, 10) || 0);
      }
      topo.saveBandwidthSettings({ linkSpeedBps, thresholds });
      // Re-apply heatmap with new settings
      if (bandwidthOverlayActive && lastBandwidthData?.edgeRates) {
        topo.applyBandwidthHeatmap(lastBandwidthData.edgeRates);
      }
      document.getElementById('bwSettingsPanel').style.display = 'none';
    });

    // EOS config panel
    document.getElementById('btnSflowEosConfig')?.addEventListener('click', () => {
      const panel = document.getElementById('sflowEosConfigPanel');
      if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
    });

    document.getElementById('btnCloseSflowEos')?.addEventListener('click', () => {
      const panel = document.getElementById('sflowEosConfigPanel');
      if (panel) panel.style.display = 'none';
    });

    document.getElementById('btnGenerateSflowEos')?.addEventListener('click', async () => {
      const ip = document.getElementById('sflowCollectorIP')?.value || '';
      const rate = document.getElementById('sflowSamplingRate')?.value || 1024;
      try {
        const result = await API.getSflowEosConfig(ip, rate);
        const output = document.getElementById('sflowEosConfigOutput');
        if (output) output.textContent = result.eosConfig || 'Error generating config';
      } catch (err) {
        console.error('EOS config generation failed:', err);
      }
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
