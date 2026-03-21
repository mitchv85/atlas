// ---------------------------------------------------------------------------
// ATLAS — Main Application
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────
  let devices = [];
  let topologyData = null;
  const topo = new TopologyRenderer('cy');

  // ── DOM References ────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const btnCollect = $('#btnCollect');
  const btnManageDevices = $('#btnManageDevices');
  const btnEmptyAddDevice = $('#btnEmptyAddDevice');
  const deviceModal = $('#deviceModal');
  const btnCloseModal = $('#btnCloseModal');
  const addDeviceForm = $('#addDeviceForm');
  const deviceList = $('#deviceList');
  const emptyState = $('#emptyState');
  const topoToolbar = $('#topoToolbar');
  const detailPanel = $('#detailPanel');
  const detailTitle = $('#detailTitle');
  const detailBody = $('#detailBody');
  const btnCloseDetail = $('#btnCloseDetail');
  const statusDot = $('.status-dot');
  const statusText = $('.status-text');

  // ── Init ──────────────────────────────────────────────────────────
  async function init() {
    topo.init();
    topo.onNodeClick = showNodeDetail;
    topo.onEdgeClick = showEdgeDetail;

    bindEvents();
    await refreshDevices();

    // Try loading any cached topology
    const existing = await API.getTopology();
    if (existing) {
      loadTopologyIntoView(existing);
    }
  }

  // ── Event Binding ─────────────────────────────────────────────────
  function bindEvents() {
    btnManageDevices.addEventListener('click', openDeviceModal);
    btnEmptyAddDevice.addEventListener('click', openDeviceModal);
    btnCloseModal.addEventListener('click', closeDeviceModal);
    deviceModal.addEventListener('click', (e) => {
      if (e.target === deviceModal) closeDeviceModal();
    });

    addDeviceForm.addEventListener('submit', handleAddDevice);
    btnCollect.addEventListener('click', handleCollect);
    btnCloseDetail.addEventListener('click', closeDetail);

    // Topology toolbar
    $('#btnFit').addEventListener('click', () => topo.fit());
    $('#btnZoomIn').addEventListener('click', () => topo.zoomIn());
    $('#btnZoomOut').addEventListener('click', () => topo.zoomOut());
    $('#btnLayoutCose').addEventListener('click', () => topo.runLayout('cose'));
  }

  // ── Device Management ─────────────────────────────────────────────
  async function refreshDevices() {
    devices = await API.getDevices();
    renderDeviceList();
    btnCollect.disabled = devices.length === 0;
  }

  function renderDeviceList() {
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

  function loadTopologyIntoView(data) {
    topologyData = data;
    emptyState.classList.add('hidden');
    topoToolbar.style.display = 'flex';
    topo.loadTopology({ nodes: data.nodes, edges: data.edges });
  }

  // ── Detail Panel ──────────────────────────────────────────────────
  function showNodeDetail(nodeData) {
    detailTitle.textContent = nodeData.hostname || nodeData.label;
    detailBody.innerHTML = buildNodeDetailHTML(nodeData);
    detailPanel.classList.add('open');
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
      </div>

      <div class="detail-section">
        <h4>LSP State</h4>
        <div class="detail-row">
          <span class="detail-label">Sequence #</span>
          <span class="detail-value">${d.sequenceNumber}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Remaining Lifetime</span>
          <span class="detail-value">${d.remainingLifetime}s</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Neighbor Count</span>
          <span class="detail-value">${d.neighborCount}</span>
        </div>
      </div>`;

    // Prefixes
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

    // SR Prefix SIDs (Phase 2 placeholder)
    if (d.srPrefixSids && d.srPrefixSids.length > 0) {
      html += `
        <div class="detail-section">
          <h4>SR Prefix SIDs</h4>
          <ul class="prefix-list">
            ${d.srPrefixSids.map((s) => `<li>${esc(JSON.stringify(s))}</li>`).join('')}
          </ul>
        </div>`;
    }

    return html;
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

    // Interfaces
    if (d.localIntf || d.remoteIntf) {
      html += `
        <div class="detail-section">
          <h4>Interfaces</h4>
          ${d.localIntf ? `<div class="detail-row"><span class="detail-label">${esc(d.sourceLabel)}</span><span class="detail-value">${esc(d.localIntf)}</span></div>` : ''}
          ${d.remoteIntf ? `<div class="detail-row"><span class="detail-label">${esc(d.targetLabel)}</span><span class="detail-value">${esc(d.remoteIntf)}</span></div>` : ''}
        </div>`;
    }

    html += `
      <div class="detail-section">
        <h4>Metadata</h4>
        <div class="detail-row">
          <span class="detail-label">IS-IS Level</span>
          <span class="detail-badge cyan">L${d.level}</span>
        </div>
      </div>`;

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
    statusText.textContent = text;
  }

  // ── Utility ───────────────────────────────────────────────────────
  function esc(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // ── Boot ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
