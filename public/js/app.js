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
  const pathFailLink = $('#pathFailLink');
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

    // Mutual exclusion: selecting a node failure clears link failure and vice versa
    pathFailNode.addEventListener('change', () => {
      if (pathFailNode.value) pathFailLink.value = '';
    });
    pathFailLink.addEventListener('change', () => {
      if (pathFailLink.value) pathFailNode.value = '';
    });
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
      // Always get the full analysis (primary + all backups)
      const analysis = await API.analyzePath(source, dest);
      currentPathResult = analysis;

      let displayPath;
      let failedNodes = [];
      let failedEdges = [];
      let failureLabel = '';

      if (failNode) {
        // Node failure
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
        // Link failure
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
        // Primary path, no failure
        displayPath = analysis.primary;
      }

      // Highlight on topology
      if (displayPath) {
        topo.highlightPath(displayPath, failedNodes, failedEdges);
      } else {
        topo.clearPath();
        if (failedNodes.length > 0 || failedEdges.length > 0) {
          // Show the primary path dimmed with the failed element marked
          topo.highlightPath(
            analysis.primary || { source, destination: dest, hops: [] },
            failedNodes,
            failedEdges
          );
        }
      }

      // Show detail panel
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

    return html;
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
