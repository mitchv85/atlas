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

  // Path analysis
  const pathBar = $('#pathBar');
  const pathSource = $('#pathSource');
  const pathDest = $('#pathDest');
  const pathFailNode = $('#pathFailNode');
  const pathAlgo = $('#pathAlgo');
  const btnComputePath = $('#btnComputePath');
  const btnClearPath = $('#btnClearPath');

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

    // Path analysis
    btnComputePath.addEventListener('click', handleComputePath);
    btnClearPath.addEventListener('click', handleClearPath);
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
    pathBar.style.display = 'flex';
    topo.loadTopology({ nodes: data.nodes, edges: data.edges });
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

    // Clear and rebuild
    pathSource.innerHTML = '<option value="">Select source...</option>';
    pathDest.innerHTML = '<option value="">Select destination...</option>';
    pathFailNode.innerHTML = '<option value="">None (primary path)</option>';

    for (const node of nodes) {
      const optSrc = new Option(node.label, node.id);
      const optDst = new Option(node.label, node.id);
      const optFail = new Option(node.label, node.id);
      pathSource.add(optSrc);
      pathDest.add(optDst);
      pathFailNode.add(optFail);
    }

    // Restore selections if still valid
    if (prevSrc && nodes.some(n => n.id === prevSrc)) pathSource.value = prevSrc;
    if (prevDst && nodes.some(n => n.id === prevDst)) pathDest.value = prevDst;
    if (prevFail && nodes.some(n => n.id === prevFail)) pathFailNode.value = prevFail;
  }

  // ── Path Computation ─────────────────────────────────────────────
  async function handleComputePath() {
    const source = pathSource.value;
    const dest = pathDest.value;
    const failNode = pathFailNode.value;

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
      // Always get the full analysis (primary + all backups)
      const analysis = await API.analyzePath(source, dest);
      currentPathResult = analysis;

      // Determine which path to display
      let displayPath;
      let failedNodes = [];

      if (failNode) {
        // User selected a specific failure — find the matching backup
        const backup = analysis.backups.find((b) => b.failedNode === failNode);
        if (backup && backup.backupPath) {
          displayPath = backup.backupPath;
          failedNodes = [failNode];
        } else if (backup && !backup.backupPath) {
          // Unreachable under this failure
          displayPath = null;
          failedNodes = [failNode];
        } else {
          // Fallback: compute directly with exclusion
          const result = await API.computePath(source, dest, [failNode]);
          displayPath = result.reachable ? result : null;
          failedNodes = [failNode];
        }
      } else {
        displayPath = analysis.primary;
      }

      // Highlight on topology
      if (displayPath) {
        topo.highlightPath(displayPath, failedNodes);
      } else {
        topo.clearPath();
        // Still mark the failed node visually
        if (failedNodes.length > 0) {
          topo.highlightPath(analysis.primary || { source, destination: dest, hops: [] }, failedNodes);
        }
      }

      // Show detail panel with path info
      showPathDetail(displayPath, analysis, failedNodes);
      btnClearPath.style.display = 'inline-flex';

      if (displayPath) {
        const failLabel = failedNodes.length > 0
          ? ` (${getHostname(failedNodes[0])} failed)`
          : '';
        setStatus('live', `Path: ${displayPath.hopCount} hops, metric ${displayPath.totalMetric}${failLabel}`);
      } else {
        setStatus('error', `Unreachable: ${getHostname(source)} → ${getHostname(dest)} with ${getHostname(failNode)} failed`);
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

  // ── Path Detail Panel ──────────────────────────────────────────────
  function showPathDetail(pathData, analysis, failedNodes) {
    const srcName = getHostname(pathSource.value);
    const dstName = getHostname(pathDest.value);

    if (failedNodes.length > 0) {
      const failName = getHostname(failedNodes[0]);
      detailTitle.textContent = `${srcName} → ${dstName} (${failName} ✕)`;
    } else {
      detailTitle.textContent = `${srcName} → ${dstName}`;
    }

    detailBody.innerHTML = buildPathDetailHTML(pathData, analysis, failedNodes);
    detailPanel.classList.add('open');

    // Wire up backup toggles
    const backupHeaders = detailBody.querySelectorAll('.backup-header');
    backupHeaders.forEach((header) => {
      header.addEventListener('click', () => {
        const body = header.nextElementSibling;
        body.classList.toggle('open');
        const toggle = header.querySelector('.backup-toggle');
        toggle.textContent = body.classList.contains('open') ? '▾' : '▸';
      });
    });

    // Wire up backup "Show" buttons
    const backupShowBtns = detailBody.querySelectorAll('.btn-show-backup');
    backupShowBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const failedNode = btn.dataset.failNode;
        pathFailNode.value = failedNode;
        handleComputePath();
      });
    });
  }

  function buildPathDetailHTML(pathData, analysis, failedNodes) {
    let html = '';

    // Unreachable state
    if (!pathData) {
      const failName = failedNodes.length > 0 ? getHostname(failedNodes[0]) : 'constraint';
      html += `
        <div class="path-result-banner failure">
          <svg class="path-result-icon" viewBox="0 0 20 20" fill="#f87171">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
          </svg>
          <span class="path-result-text"><strong>Unreachable</strong> — destination cannot be reached with <strong>${esc(failName)}</strong> failed</span>
        </div>`;

      // Still show primary path if available
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
    const isBackup = failedNodes.length > 0;
    html += `
      <div class="path-result-banner">
        <svg class="path-result-icon" viewBox="0 0 20 20" fill="${isBackup ? '#fbbf24' : '#22d3ee'}">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
        </svg>
        <span class="path-result-text">
          <strong>${isBackup ? 'TI-LFA Backup' : 'Primary Path'}</strong> — 
          ${pathData.hopCount} hops, total metric ${pathData.totalMetric}, Algo ${pathData.algorithm}
        </span>
      </div>`;

    // Label stack
    if (pathData.labelStack && pathData.labelStack.length > 0) {
      html += `
        <div class="detail-section">
          <h4>SR Label Stack</h4>`;

      for (const label of pathData.labelStack) {
        const srgbBase = 900000; // We know this from the topology
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
      html += `</div>`;
    }

    // Hop-by-hop path
    html += `
      <div class="detail-section">
        <h4>Hop-by-Hop Path</h4>
        ${buildHopListHTML(pathData)}
      </div>`;

    // TI-LFA backup paths section
    if (analysis?.backups && analysis.backups.length > 0 && failedNodes.length === 0) {
      html += `
        <div class="backup-section">
          <div class="backup-header">
            <h4>TI-LFA Backup Paths (Node Protection)</h4>
            <span class="backup-toggle">▸</span>
          </div>
          <div class="backup-body">`;

      for (const backup of analysis.backups) {
        html += `<div class="backup-item">`;
        html += `<div class="backup-item-header">If <strong>${esc(backup.failedHostname)}</strong> fails:</div>`;

        if (backup.backupPath) {
          const hopNames = [backup.backupPath.sourceHostname];
          for (const hop of backup.backupPath.hops) {
            hopNames.push(hop.toHostname);
          }
          html += `<div class="backup-item-path">${hopNames.join(' → ')}</div>`;
          html += `<div style="margin-top:4px;font-size:0.72rem;color:var(--text-muted);">
            ${backup.backupPath.hopCount} hops, metric ${backup.backupPath.totalMetric}
          </div>`;
          html += `<button class="btn btn-ghost btn-sm btn-show-backup" data-fail-node="${backup.failedNode}" style="margin-top:6px;">Show on Map</button>`;
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

      // Link info between hops
      const adjSidLabel = hop.adjSids?.length > 0
        ? hop.adjSids.map((s) => s.sid).join(', ')
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
