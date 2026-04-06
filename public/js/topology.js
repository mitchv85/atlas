// ---------------------------------------------------------------------------
// ATLAS Topology Renderer — Cytoscape.js Wrapper
// ---------------------------------------------------------------------------
// Manages the interactive network topology visualization. Handles:
//   - Graph initialization, layout (CoSE force-directed), and styling
//   - Node/edge click callbacks for detail panels
//   - Path highlighting: primary, TI-LFA backup, ECMP (4-color)
//   - Selection markers: source (green), destination (amber), failures (red)
//   - Algorithm overlay: swap edge labels between IS-IS / delay / TE metric
//   - Persistent node positions (drag → save → restore on reload)
// ---------------------------------------------------------------------------

class TopologyRenderer {
  constructor(containerId) {
    this.cy = null;
    this.containerId = containerId;
    this.onNodeClick = null;
    this.onEdgeClick = null;
    this.onNodeDragEnd = null; // Callback when node positions change
    this._savedPositions = {};  // { nodeId: { x, y } }
    this._dragSaveTimer = null; // Debounce timer for position saves
  }

  /**
   * Set saved positions (loaded from server).
   */
  setSavedPositions(positions) {
    this._savedPositions = positions || {};
  }

  /**
   * Initialize the Cytoscape.js instance with ATLAS styling.
   */
  init() {
    this.cy = cytoscape({
      container: document.getElementById(this.containerId),
      style: this._getStyles(),
      layout: { name: 'grid' }, // placeholder; real layout applied on data load
      minZoom: 0.2,
      maxZoom: 4,
      wheelSensitivity: 0.3,
    });

    // Interaction handlers
    this.cy.on('tap', 'node', (evt) => {
      this._highlightElement(evt.target);
      if (this.onNodeClick) this.onNodeClick(evt.target.data());
    });

    this.cy.on('tap', 'edge', (evt) => {
      this._highlightElement(evt.target);
      if (this.onEdgeClick) this.onEdgeClick(evt.target.data());
    });

    // Click on background to deselect
    this.cy.on('tap', (evt) => {
      if (evt.target === this.cy) {
        this._clearHighlight();
      }
    });

    // Save positions on drag end (debounced)
    this.cy.on('dragfree', 'node', () => {
      this._debounceSavePositions();
    });

    // Right-click (context tap) handlers
    this.cy.on('cxttap', 'node', (evt) => {
      evt.originalEvent.preventDefault();
      if (this.onNodeContext) this.onNodeContext(evt.target.data(), evt.originalEvent);
    });

    this.cy.on('cxttap', 'edge', (evt) => {
      evt.originalEvent.preventDefault();
      if (this.onEdgeContext) this.onEdgeContext(evt.target.data(), evt.originalEvent);
    });

    // macOS Ctrl+Click fallback — Cytoscape's cxttap only fires for
    // button === 2 (real right-click). On macOS, Ctrl+Click sends button === 0
    // with ctrlKey === true, so cxttap never fires. Catch it via tap instead.
    this.cy.on('tap', 'node', (evt) => {
      if (evt.originalEvent.ctrlKey) {
        evt.originalEvent.preventDefault();
        if (this.onNodeContext) this.onNodeContext(evt.target.data(), evt.originalEvent);
      }
    });

    this.cy.on('tap', 'edge', (evt) => {
      if (evt.originalEvent.ctrlKey) {
        evt.originalEvent.preventDefault();
        if (this.onEdgeContext) this.onEdgeContext(evt.target.data(), evt.originalEvent);
      }
    });

    // Dismiss context menu on left-click anywhere
    // Skip dismissal on Ctrl+Click so the menu we just opened doesn't
    // get immediately closed by the blanket tap handler
    this.cy.on('tap', (evt) => {
      if (evt.originalEvent && evt.originalEvent.ctrlKey) return;
      if (this.onDismissContext) this.onDismissContext();
    });

    // Prevent browser context menu on the canvas
    document.getElementById(this.containerId).addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    return this;
  }

  /**
   * Update selection markers on the topology.
   * @param {Object} selections - { source, dest, failNode, failEdge }
   */
  updateSelectionMarkers(selections) {
    // Clear all selection markers
    this.cy.nodes().removeClass('selected-source selected-dest selected-fail');
    this.cy.edges().removeClass('selected-fail');

    if (selections.source) {
      const node = this.cy.getElementById(selections.source);
      if (node.length) node.addClass('selected-source');
    }
    if (selections.dest) {
      const node = this.cy.getElementById(selections.dest);
      if (node.length) node.addClass('selected-dest');
    }
    if (selections.failNode) {
      const node = this.cy.getElementById(selections.failNode);
      if (node.length) node.addClass('selected-fail');
    }
    if (selections.failEdge) {
      const edge = this.cy.getElementById(selections.failEdge);
      if (edge.length) edge.addClass('selected-fail');
    }
  }

  /**
   * Load topology data and apply saved positions or layout.
   *
   * @param {Object} topology - { nodes: [], edges: [] } in Cytoscape format
   */
  loadTopology(topology) {
    if (!this.cy) this.init();

    this.cy.elements().remove();

    this.cy.add(topology.nodes);
    this.cy.add(topology.edges);

    // Apply saved positions where available
    const nodesWithoutPosition = [];
    this.cy.nodes().forEach((n) => {
      const saved = this._savedPositions[n.id()];
      if (saved) {
        n.position(saved);
      } else {
        nodesWithoutPosition.push(n);
      }
    });

    if (nodesWithoutPosition.length > 0 && nodesWithoutPosition.length === this.cy.nodes().length) {
      // No saved positions at all — run full layout
      this.runLayout('cose');
    } else if (nodesWithoutPosition.length > 0) {
      // Some new nodes without positions — run layout to place them
      this.runLayout('cose');
    }
    // If all nodes have saved positions, just render (no layout needed)
  }

  /**
   * Debounced save of all current positions.
   */
  _debounceSavePositions() {
    clearTimeout(this._dragSaveTimer);
    this._dragSaveTimer = setTimeout(() => {
      const positions = {};
      this.cy.nodes().forEach((n) => {
        const pos = n.position();
        positions[n.id()] = { x: pos.x, y: pos.y };
      });
      // Update local cache
      this._savedPositions = positions;
      // Notify callback
      if (this.onNodeDragEnd) this.onNodeDragEnd(positions);
    }, 300);
  }

  /**
   * Run a layout algorithm.
   */
  runLayout(name = 'cose') {
    const self = this;
    const onStop = function () {
      // Save positions after layout completes
      self._debounceSavePositions();
    };

    const layouts = {
      cose: {
        name: 'cose',
        animate: true,
        animationDuration: 800,
        nodeRepulsion: 8000,
        idealEdgeLength: 120,
        edgeElasticity: 100,
        gravity: 0.25,
        numIter: 1000,
        padding: 50,
        stop: onStop,
      },
      grid: {
        name: 'grid',
        animate: true,
        animationDuration: 500,
        padding: 50,
        stop: onStop,
      },
      circle: {
        name: 'circle',
        animate: true,
        animationDuration: 500,
        padding: 50,
        stop: onStop,
      },
    };

    this.cy.layout(layouts[name] || layouts.cose).run();
  }

  /**
   * Fit the view to all elements.
   */
  fit() {
    this.cy.fit(50);
  }

  zoomIn() {
    this.cy.zoom({ level: this.cy.zoom() * 1.3, renderedPosition: this._center() });
  }

  zoomOut() {
    this.cy.zoom({ level: this.cy.zoom() / 1.3, renderedPosition: this._center() });
  }

  // ── Private ───────────────────────────────────────────────────────
  _center() {
    const { w, h } = this.cy.extent();
    return { x: this.cy.width() / 2, y: this.cy.height() / 2 };
  }

  _highlightElement(ele) {
    this._clearHighlight();
    ele.addClass('highlighted');

    if (ele.isNode()) {
      ele.connectedEdges().addClass('highlighted-edge');
      ele.neighborhood('node').addClass('neighbor');
    }

    if (ele.isEdge()) {
      ele.addClass('highlighted-edge');
      ele.connectedNodes().addClass('neighbor');
    }
  }

  _clearHighlight() {
    this.cy.elements().removeClass(
      'highlighted highlighted-edge neighbor dimmed ' +
      'path-node path-edge path-edge-fwd path-edge-rev path-source path-dest ' +
      'path-failed path-edge-failed path-failed-neighbor path-dimmed ' +
      'ecmp-node ecmp-shared-edge ecmp-path-0 ecmp-path-1 ecmp-path-2 ecmp-path-3 ecmp-source ecmp-dest'
    );
  }

  /**
   * Highlight a computed path on the topology.
   *
   * @param {Object}   pathData    - Path result from the API
   * @param {string[]} failedNodes - Node IDs to mark as failed
   * @param {string[]} failedEdges - Edge IDs to mark as failed
   */
  highlightPath(pathData, failedNodes = [], failedEdges = []) {
    this._clearHighlight();

    if (!pathData || !pathData.hops || pathData.hops.length === 0) return;

    // Collect all nodes and edges on the path, tracking traversal direction
    const pathNodeIds = new Set();
    const pathEdgeDirection = new Map(); // edgeId -> 'forward' | 'reverse'

    pathNodeIds.add(pathData.source);
    pathNodeIds.add(pathData.destination);

    for (const hop of pathData.hops) {
      pathNodeIds.add(hop.from);
      pathNodeIds.add(hop.to);
      if (hop.edgeId) {
        // Determine if the path traverses this edge forward or reverse
        // relative to the Cytoscape edge's source→target direction
        const cyEdge = this.cy.getElementById(hop.edgeId);
        if (cyEdge.length) {
          const edgeSrc = cyEdge.data('source');
          // If the hop's "from" matches the edge's source, we're going forward
          const direction = (hop.from === edgeSrc) ? 'forward' : 'reverse';
          pathEdgeDirection.set(hop.edgeId, direction);
        }
      }
    }

    // Dim everything first
    this.cy.elements().addClass('path-dimmed');

    // Highlight path nodes
    for (const nodeId of pathNodeIds) {
      const node = this.cy.getElementById(nodeId);
      if (node.length) {
        node.removeClass('path-dimmed');
        node.addClass('path-node');
      }
    }

    // Highlight path edges with correct arrow direction
    for (const [edgeId, direction] of pathEdgeDirection) {
      const edge = this.cy.getElementById(edgeId);
      if (edge.length) {
        edge.removeClass('path-dimmed');
        edge.addClass('path-edge');
        // Apply direction class so the arrow points the right way
        edge.addClass(direction === 'forward' ? 'path-edge-fwd' : 'path-edge-rev');
      }
    }

    // Mark source and dest
    const srcNode = this.cy.getElementById(pathData.source);
    const dstNode = this.cy.getElementById(pathData.destination);
    if (srcNode.length) srcNode.addClass('path-source');
    if (dstNode.length) dstNode.addClass('path-dest');

    // Mark failed nodes
    for (const failedId of failedNodes) {
      const fNode = this.cy.getElementById(failedId);
      if (fNode.length) {
        fNode.removeClass('path-dimmed');
        fNode.addClass('path-failed');
      }
    }

    // Mark failed edges
    for (const failedId of failedEdges) {
      const fEdge = this.cy.getElementById(failedId);
      if (fEdge.length) {
        fEdge.removeClass('path-dimmed');
        fEdge.addClass('path-edge-failed');
        fEdge.connectedNodes().forEach((n) => {
          n.removeClass('path-dimmed');
          if (!n.hasClass('path-node')) n.addClass('path-failed-neighbor');
        });
      }
    }
  }

  /**
   * Clear path highlighting.
   */
  clearPath() {
    this.cy.elements().removeClass(
      'path-node path-edge path-edge-fwd path-edge-rev path-source path-dest ' +
      'path-failed path-edge-failed path-failed-neighbor path-dimmed ' +
      'ecmp-node ecmp-shared-edge ecmp-path-0 ecmp-path-1 ecmp-path-2 ecmp-path-3 ecmp-source ecmp-dest'
    );
  }

  /**
   * ECMP path color palette.
   */
  static ECMP_COLORS = ['#22d3ee', '#fbbf24', '#a78bfa', '#fb7185'];
  static ECMP_SHARED_COLOR = '#e8edf5';

  /**
   * Highlight multiple ECMP paths on the topology.
   *
   * @param {Object} ecmpResult - { paths, sharedEdges, sharedNodes }
   */
  highlightECMP(ecmpResult) {
    this._clearHighlight();

    if (!ecmpResult || !ecmpResult.paths || ecmpResult.paths.length === 0) return;

    const { paths, sharedEdges = [], sharedNodes = [] } = ecmpResult;
    const sharedEdgeSet = new Set(sharedEdges);
    const sharedNodeSet = new Set(sharedNodes);

    // Collect all elements involved in any path
    const allNodeIds = new Set();
    const allEdgeIds = new Set();

    for (const path of paths) {
      allNodeIds.add(path.source);
      allNodeIds.add(path.destination);
      for (const hop of path.hops) {
        allNodeIds.add(hop.from);
        allNodeIds.add(hop.to);
        if (hop.edgeId) allEdgeIds.add(hop.edgeId);
      }
    }

    // Dim everything
    this.cy.elements().addClass('path-dimmed');

    // Un-dim and class all participating nodes
    for (const nodeId of allNodeIds) {
      const node = this.cy.getElementById(nodeId);
      if (node.length) {
        node.removeClass('path-dimmed');
        node.addClass('ecmp-node');
      }
    }

    // Mark source and dest
    if (paths[0]) {
      const src = this.cy.getElementById(paths[0].source);
      const dst = this.cy.getElementById(paths[0].destination);
      if (src.length) src.addClass('ecmp-source');
      if (dst.length) dst.addClass('ecmp-dest');
    }

    // Color each path's unique edges
    for (let i = 0; i < paths.length && i < 4; i++) {
      const path = paths[i];
      for (const hop of path.hops) {
        if (!hop.edgeId) continue;
        const edge = this.cy.getElementById(hop.edgeId);
        if (!edge.length) continue;

        edge.removeClass('path-dimmed');

        if (sharedEdgeSet.has(hop.edgeId)) {
          edge.addClass('ecmp-shared-edge');
        } else {
          edge.addClass('ecmp-path-' + i);
        }
      }
    }
  }

  /**
   * Get all node IDs and labels (for populating dropdowns).
   */
  getNodeList() {
    if (!this.cy) return [];
    return this.cy.nodes().map((n) => ({
      id: n.data('id'),
      label: n.data('label') || n.data('id'),
    })).sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Switch edge labels to show metrics for a specific algorithm.
   * Algo 0  → IS-IS metric (default)
   * Algo 128 → min-delay (ms)
   * Algo 129 → TE metric
   *
   * @param {number} algoNum - Algorithm number (0 for default)
   */
  setAlgorithmOverlay(algoNum) {
    if (!this.cy) return;

    this.cy.edges().forEach((edge) => {
      const d = edge.data();
      if (algoNum === 0 || algoNum == null) {
        // Restore IS-IS metrics
        edge.data('sourceMetric', d._origSourceMetric ?? d.sourceMetric);
        edge.data('targetMetric', d._origTargetMetric ?? d.targetMetric);
      } else if (algoNum === 128) {
        // Min-delay overlay
        // Save originals on first switch
        if (d._origSourceMetric == null) {
          edge.data('_origSourceMetric', d.sourceMetric);
          edge.data('_origTargetMetric', d.targetMetric);
        }
        const fwd = d.forwardDelay != null ? `${d.forwardDelay}ms` : '—';
        const rev = d.reverseDelay != null ? `${d.reverseDelay}ms` : '—';
        edge.data('sourceMetric', fwd);
        edge.data('targetMetric', rev);
      } else if (algoNum === 129) {
        // TE metric overlay
        if (d._origSourceMetric == null) {
          edge.data('_origSourceMetric', d.sourceMetric);
          edge.data('_origTargetMetric', d.targetMetric);
        }
        const fwd = d.forwardTeMetric ? String(d.forwardTeMetric) : '—';
        const rev = d.reverseTeMetric ? String(d.reverseTeMetric) : '—';
        edge.data('sourceMetric', fwd);
        edge.data('targetMetric', rev);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // sFlow Overlay Methods
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Heat level thresholds for edge coloring (bits per second).
   * 5 tiers: light teal → teal → amber → orange → red.
   */
  static FLOW_HEAT_THRESHOLDS = [
    100_000,       // Level 1: > 100 Kbps
    1_000_000,     // Level 2: > 1 Mbps
    10_000_000,    // Level 3: > 10 Mbps
    100_000_000,   // Level 4: > 100 Mbps
    1_000_000_000, // Level 5: > 1 Gbps
  ];

  // Bandwidth overlay settings — thresholds loaded from server
  static BW_DEFAULTS = {
    thresholds: [1, 10, 25, 50, 75, 90],
  };

  /**
   * Get bandwidth overlay thresholds.
   * Uses cached thresholds from server (set via setBandwidthThresholds).
   */
  getBandwidthSettings() {
    return {
      thresholds: this._bwThresholds || TopologyRenderer.BW_DEFAULTS.thresholds,
    };
  }

  /**
   * Set bandwidth thresholds (called when fetched from server).
   */
  setBandwidthThresholds(thresholds) {
    this._bwThresholds = thresholds;
  }

  /**
   * Apply bandwidth heatmap overlay to the topology.
   * Colors edges based on utilization percentage.
   * Shows effective speed or live throughput on edge labels.
   *
   * @param {Array} edgeRates - [{ edgeId, maxBps, inBps, outBps, effectiveSpeedBps, ... }]
   */
  applyBandwidthHeatmap(edgeRates) {
    if (!this.cy) return;

    const settings = this.getBandwidthSettings();
    const thresholds = settings.thresholds;

    // Build a lookup of edge rates by ID
    const rateMap = new Map();
    for (const er of (edgeRates || [])) {
      rateMap.set(er.edgeId, er);
    }

    // Remove previous heat classes (but DON'T restore labels — we'll set them all)
    this.cy.elements().removeClass(
      'bw-heat-1 bw-heat-2 bw-heat-3 bw-heat-4 bw-heat-5 bw-heat-6 flow-active'
    );

    this.cy.edges().forEach(edge => {
      const d = edge.data();

      // Save original labels on first pass only
      if (d._bwOrigSource === undefined) {
        edge.data('_bwOrigSource', d.sourceMetric);
        edge.data('_bwOrigTarget', d.targetMetric);
      }

      const er = rateMap.get(d.id);

      if (er) {
        const bps = er.maxBps || 0;
        const linkSpeed = er.effectiveSpeedBps || er.speedBps || 10_000_000_000;
        const utilization = (bps / linkSpeed) * 100;
        const speedLabel = er.overrideLabel || TopologyRenderer.formatSpeed(linkSpeed);

        // Determine heat level
        let level = 0;
        for (let i = 0; i < thresholds.length; i++) {
          if (utilization >= thresholds[i]) level = i + 1;
        }

        if (level > 0) {
          edge.addClass(`bw-heat-${level}`);
          edge.connectedNodes().forEach(n => n.addClass('flow-active'));
        }

        // Labels: show per-side egress throughput when traffic is flowing
        const srcOut = er.srcOutBps || 0;
        const tgtOut = er.tgtOutBps || 0;
        const hasTraffic = level > 0 || srcOut >= 1000 || tgtOut >= 1000;

        if (hasTraffic) {
          // Show egress rate on each side (source label = source's outbound)
          edge.data('sourceMetric', srcOut >= 1000 ? TopologyRenderer.formatBps(srcOut) : speedLabel);
          edge.data('targetMetric', tgtOut >= 1000 ? TopologyRenderer.formatBps(tgtOut) : speedLabel);
        } else {
          // Idle — show effective speed on both sides
          edge.data('sourceMetric', speedLabel);
          edge.data('targetMetric', speedLabel);
        }
      } else {
        // No rate data — show original metrics (or speed if known)
        edge.data('sourceMetric', d._bwOrigSource);
        edge.data('targetMetric', d._bwOrigTarget);
      }
    });
  }

  /**
   * Format bits-per-second as human-readable throughput.
   */
  static formatBps(bps) {
    if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)}G`;
    if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)}M`;
    if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)}K`;
    return `${Math.round(bps)} bps`;
  }

  /**
   * Format link speed as human-readable string.
   */
  static formatSpeed(speedBps) {
    if (!speedBps) return '';
    if (speedBps >= 1e9) return `${speedBps / 1e9}G`;
    if (speedBps >= 1e6) return `${speedBps / 1e6}M`;
    return `${speedBps / 1e3}K`;
  }

  /**
   * Apply flow heatmap overlay to the topology.
   * Colors edges based on traffic volume from sFlow data.
   *
   * @param {Object} flowSnapshot - { edgeFlows: [{ edgeId, bitsPerSec }] }
   */
  applyFlowHeatmap(flowSnapshot) {
    if (!this.cy) return;

    // Clear previous flow classes
    this.clearFlowOverlay();

    if (!flowSnapshot || !flowSnapshot.edgeFlows || flowSnapshot.edgeFlows.length === 0) return;

    // Find the max rate for relative scaling
    const activeNodeIds = new Set();

    for (const ef of flowSnapshot.edgeFlows) {
      const edge = this.cy.getElementById(ef.edgeId);
      if (!edge.length) continue;

      // Determine heat level
      const bps = ef.bitsPerSec || 0;
      let level = 0;
      for (let i = 0; i < TopologyRenderer.FLOW_HEAT_THRESHOLDS.length; i++) {
        if (bps >= TopologyRenderer.FLOW_HEAT_THRESHOLDS[i]) level = i + 1;
      }

      if (level > 0) {
        edge.addClass(`flow-heat-${level}`);
        // Also mark connected nodes as active
        activeNodeIds.add(edge.data('source'));
        activeNodeIds.add(edge.data('target'));
      }
    }

    // Mark active nodes
    for (const nodeId of activeNodeIds) {
      const node = this.cy.getElementById(nodeId);
      if (node.length) node.addClass('flow-active');
    }
  }

  /**
   * Highlight a specific LSP path on the topology.
   *
   * @param {Object} lspDetail - { sourceNode, destNode, edgePath, lspKey }
   * @param {Object} topology  - Current topology data for node ID resolution
   */
  highlightLspFlow(lspDetail, topology) {
    if (!this.cy || !lspDetail) return;

    this._clearHighlight();
    this.clearFlowOverlay();

    // Dim everything
    this.cy.elements().addClass('flow-dimmed');

    // Find source and dest node IDs from hostnames
    const srcId = this._findNodeIdByHostname(lspDetail.sourceNode, topology);
    const dstId = this._findNodeIdByHostname(lspDetail.destNode, topology);

    // Highlight LSP edges
    for (const edgeId of (lspDetail.edgePath || [])) {
      const edge = this.cy.getElementById(edgeId);
      if (edge.length) {
        edge.removeClass('flow-dimmed');
        edge.addClass('flow-lsp-highlight flow-animated');
        // Mark connected nodes
        edge.connectedNodes().forEach((n) => {
          n.removeClass('flow-dimmed');
          n.addClass('flow-lsp-node');
        });
      }
    }

    // Mark source and dest explicitly
    if (srcId) {
      const src = this.cy.getElementById(srcId);
      if (src.length) {
        src.removeClass('flow-dimmed');
        src.addClass('flow-lsp-node');
      }
    }
    if (dstId) {
      const dst = this.cy.getElementById(dstId);
      if (dst.length) {
        dst.removeClass('flow-dimmed');
        dst.addClass('flow-lsp-node');
      }
    }
  }

  /**
   * Start animated flow on edges that have the flow-animated class.
   * Uses requestAnimationFrame to animate the dash offset.
   */
  startFlowAnimation() {
    if (this._flowAnimFrame) return; // Already running

    let offset = 0;
    const animate = () => {
      offset = (offset + 1) % 28; // 8+6 = 14, cycle through 2 full patterns
      this.cy.edges('.flow-animated').style('line-dash-offset', -offset);
      this._flowAnimFrame = requestAnimationFrame(animate);
    };
    this._flowAnimFrame = requestAnimationFrame(animate);
  }

  /**
   * Stop flow animation.
   */
  stopFlowAnimation() {
    if (this._flowAnimFrame) {
      cancelAnimationFrame(this._flowAnimFrame);
      this._flowAnimFrame = null;
    }
  }

  /**
   * Clear all flow overlay classes.
   */
  clearFlowOverlay() {
    if (!this.cy) return;
    this.cy.elements().removeClass(
      'flow-heat-1 flow-heat-2 flow-heat-3 flow-heat-4 flow-heat-5 ' +
      'bw-heat-1 bw-heat-2 bw-heat-3 bw-heat-4 bw-heat-5 bw-heat-6 ' +
      'flow-active flow-lsp-highlight flow-lsp-node flow-dimmed flow-animated'
    );
    // Restore original edge labels swapped during bandwidth overlay
    this.cy.edges().forEach(edge => {
      const origSrc = edge.data('_bwOrigSource');
      const origTgt = edge.data('_bwOrigTarget');
      if (origSrc !== undefined) {
        edge.data('sourceMetric', origSrc);
        edge.data('targetMetric', origTgt);
        edge.removeData('_bwOrigSource');
        edge.removeData('_bwOrigTarget');
      }
    });
    this.stopFlowAnimation();
  }

  /**
   * Find a Cytoscape node ID by hostname.
   * @private
   */
  _findNodeIdByHostname(hostname, topology) {
    if (!topology || !topology.nodes) return null;
    for (const node of topology.nodes) {
      if (node.data.hostname === hostname || node.data.label === hostname) {
        return node.data.id;
      }
    }
    return null;
  }

  /**
   * Read current theme colors from CSS custom properties.
   * Called once per style rebuild — cached until next refreshStyles().
   */
  _themeColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (name) => s.getPropertyValue(name).trim();
    return {
      bgDeep:      v('--bg-deep'),
      bgSurface:   v('--bg-surface'),
      bgElevated:  v('--bg-elevated'),
      textPrimary: v('--text-primary'),
      textSecondary: v('--text-secondary'),
      textMuted:   v('--text-muted'),
      accent:      v('--accent'),
      accentDim:   v('--accent-dim'),
      green:       v('--green'),
      red:         v('--red'),
      amber:       v('--amber'),
      nodeFill:    v('--node-fill'),
      nodeBorder:  v('--node-border'),
      edgeColor:   v('--edge-color'),
    };
  }

  /**
   * Re-read CSS variables and apply updated Cytoscape stylesheet.
   * Call this after changing the [data-theme] attribute.
   */
  refreshStyles() {
    if (!this.cy) return;
    this.cy.style(this._getStyles());
  }

  /**
   * Cytoscape.js stylesheet — the visual identity of the topology.
   */
  _getStyles() {
    const c = this._themeColors();
    return [
      // ── Default Node ──
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 8,
          'font-family': 'Outfit, sans-serif',
          'font-size': 11,
          'font-weight': 500,
          color: c.textSecondary,
          'text-outline-color': c.bgDeep,
          'text-outline-width': 2,
          width: 40,
          height: 40,
          'background-color': c.nodeFill,
          'border-width': 2,
          'border-color': c.nodeBorder,
          'border-opacity': 0.7,
          shape: 'round-rectangle',
          'corner-radius': 6,
          'overlay-padding': 6,
          'transition-property': 'border-color, border-width, background-color, width, height',
          'transition-duration': '0.2s',
        },
      },
      // ── Highlighted Node ──
      {
        selector: 'node.highlighted',
        style: {
          'border-color': c.accent,
          'border-width': 3,
          'border-opacity': 1,
          'background-color': c.accentDim,
          width: 48,
          height: 48,
          color: c.textPrimary,
          'font-weight': 600,
          'z-index': 20,
        },
      },
      // ── Neighbor of highlighted ──
      {
        selector: 'node.neighbor',
        style: {
          'border-color': c.accent,
          'border-opacity': 0.5,
          'background-color': c.nodeFill,
          color: c.textPrimary,
        },
      },
      // ── Default Edge ──
      {
        selector: 'edge',
        style: {
          width: 2,
          'line-color': c.edgeColor,
          'curve-style': 'bezier',
          'source-label': 'data(sourceMetric)',
          'target-label': 'data(targetMetric)',
          'source-text-offset': 22,
          'target-text-offset': 22,
          'font-family': 'JetBrains Mono, monospace',
          'font-size': 9,
          color: c.textMuted,
          'text-outline-color': c.bgDeep,
          'text-outline-width': 2,
          'text-rotation': 'autorotate',
          'overlay-padding': 4,
          'transition-property': 'line-color, width',
          'transition-duration': '0.2s',
        },
      },
      // ── Highlighted Edge ──
      {
        selector: 'edge.highlighted-edge',
        style: {
          'line-color': c.accent,
          width: 3,
          color: c.accent,
          'z-index': 15,
        },
      },
      // ── Selected ──
      {
        selector: ':selected',
        style: {
          'overlay-color': c.accent,
          'overlay-opacity': 0.1,
        },
      },
      // ── Path: Dimmed (everything not on the path) ──
      {
        selector: '.path-dimmed',
        style: {
          opacity: 0.15,
        },
      },
      // ── Path: Node on path ──
      {
        selector: 'node.path-node',
        style: {
          'background-color': c.accentDim,
          'border-color': c.accent,
          'border-width': 3,
          'border-opacity': 1,
          color: c.textPrimary,
          'font-weight': 600,
          opacity: 1,
          'z-index': 20,
        },
      },
      // ── Selection Markers (pre-compute) ──
      {
        selector: 'node.selected-source',
        style: {
          'border-color': c.accent,
          'border-width': 3,
          'border-style': 'double',
          'z-index': 20,
        },
      },
      {
        selector: 'node.selected-dest',
        style: {
          'border-color': c.green,
          'border-width': 3,
          'border-style': 'double',
          'z-index': 20,
        },
      },
      {
        selector: 'node.selected-fail',
        style: {
          'border-color': c.red,
          'border-width': 3,
          'border-style': 'dashed',
          'z-index': 20,
        },
      },
      {
        selector: 'edge.selected-fail',
        style: {
          'line-color': c.red,
          'line-style': 'dashed',
          'opacity': 0.7,
          'z-index': 20,
        },
      },
      // ── Path: Source node ──
      {
        selector: 'node.path-source',
        style: {
          'background-color': c.accentDim,
          'border-color': c.accent,
          'border-width': 4,
          width: 50,
          height: 50,
          'z-index': 25,
        },
      },
      // ── Path: Destination node ──
      {
        selector: 'node.path-dest',
        style: {
          'background-color': '#065f46',
          'border-color': c.green,
          'border-width': 4,
          width: 50,
          height: 50,
          'z-index': 25,
        },
      },
      // ── Path: Failed node ──
      {
        selector: 'node.path-failed',
        style: {
          'background-color': '#7f1d1d',
          'border-color': c.red,
          'border-width': 3,
          'border-style': 'dashed',
          opacity: 0.7,
          color: c.red,
          'z-index': 15,
        },
      },
      // ── Path: Neighbor of failed element (visible but neutral) ──
      {
        selector: 'node.path-failed-neighbor',
        style: {
          opacity: 0.6,
          'border-color': c.textMuted,
          color: c.textSecondary,
        },
      },
      // ── Path: Edge on path (base style, no arrows) ──
      {
        selector: 'edge.path-edge',
        style: {
          'line-color': c.accent,
          width: 4,
          color: c.accent,
          'font-size': 10,
          'font-weight': 700,
          opacity: 1,
          'z-index': 20,
        },
      },
      // ── Path: Edge traversed forward (source→target) — arrow at target ──
      {
        selector: 'edge.path-edge-fwd',
        style: {
          'target-arrow-color': c.accent,
          'target-arrow-shape': 'triangle',
          'arrow-scale': 1.2,
          'source-arrow-shape': 'none',
        },
      },
      // ── Path: Edge traversed reverse (target→source) — arrow at source ──
      {
        selector: 'edge.path-edge-rev',
        style: {
          'source-arrow-color': c.accent,
          'source-arrow-shape': 'triangle',
          'arrow-scale': 1.2,
          'target-arrow-shape': 'none',
        },
      },
      // ── Path: Failed edge ──
      {
        selector: 'edge.path-edge-failed',
        style: {
          'line-color': c.red,
          'line-style': 'dashed',
          'line-dash-pattern': [8, 4],
          width: 3,
          color: c.red,
          opacity: 0.7,
          'z-index': 15,
        },
      },
      // ── ECMP: Node on any ECMP path ──
      {
        selector: 'node.ecmp-node',
        style: {
          'background-color': c.nodeFill,
          'border-color': c.textPrimary,
          'border-width': 2.5,
          'border-opacity': 0.8,
          color: c.textPrimary,
          'font-weight': 600,
          opacity: 1,
          'z-index': 20,
        },
      },
      // ── ECMP: Source node ──
      {
        selector: 'node.ecmp-source',
        style: {
          'border-color': c.accent,
          'border-width': 4,
          'background-color': c.accentDim,
          width: 50,
          height: 50,
          'z-index': 25,
        },
      },
      // ── ECMP: Destination node ──
      {
        selector: 'node.ecmp-dest',
        style: {
          'border-color': c.green,
          'border-width': 4,
          'background-color': '#065f46',
          width: 50,
          height: 50,
          'z-index': 25,
        },
      },
      // ── ECMP: Shared edge (on ALL paths) ──
      {
        selector: 'edge.ecmp-shared-edge',
        style: {
          'line-color': c.textPrimary,
          width: 4,
          color: c.textPrimary,
          opacity: 1,
          'z-index': 18,
        },
      },
      // ── ECMP: Path 0 (Cyan) ──
      {
        selector: 'edge.ecmp-path-0',
        style: {
          'line-color': '#22d3ee',
          width: 3.5,
          color: '#22d3ee',
          opacity: 1,
          'z-index': 20,
        },
      },
      // ── ECMP: Path 1 (Amber) ──
      {
        selector: 'edge.ecmp-path-1',
        style: {
          'line-color': '#fbbf24',
          width: 3.5,
          color: '#fbbf24',
          opacity: 1,
          'z-index': 20,
        },
      },
      // ── ECMP: Path 2 (Violet) ──
      {
        selector: 'edge.ecmp-path-2',
        style: {
          'line-color': '#a78bfa',
          width: 3.5,
          color: '#a78bfa',
          opacity: 1,
          'z-index': 20,
        },
      },
      // ── ECMP: Path 3 (Rose) ──
      {
        selector: 'edge.ecmp-path-3',
        style: {
          'line-color': '#fb7185',
          width: 3.5,
          color: '#fb7185',
          opacity: 1,
          'z-index': 20,
        },
      },
      // ── sFlow: Edge with traffic (heat levels) ──
      {
        selector: 'edge.flow-heat-1',
        style: {
          'line-color': '#0d9488',
          width: 3,
          'z-index': 12,
        },
      },
      {
        selector: 'edge.flow-heat-2',
        style: {
          'line-color': '#14b8a6',
          width: 4,
          'z-index': 13,
        },
      },
      {
        selector: 'edge.flow-heat-3',
        style: {
          'line-color': '#f59e0b',
          width: 5,
          'z-index': 14,
        },
      },
      {
        selector: 'edge.flow-heat-4',
        style: {
          'line-color': '#f97316',
          width: 6,
          'z-index': 15,
        },
      },
      {
        selector: 'edge.flow-heat-5',
        style: {
          'line-color': '#ef4444',
          width: 7,
          'z-index': 16,
        },
      },
      // ── Bandwidth: Utilization-based heat levels ──
      // Light Blue → Green → Yellow → Orange → Red → Deep Red
      {
        selector: 'edge.bw-heat-1',
        style: { 'line-color': '#38bdf8', width: 2.5, 'z-index': 12 },
      },
      {
        selector: 'edge.bw-heat-2',
        style: { 'line-color': '#22c55e', width: 3.5, 'z-index': 13 },
      },
      {
        selector: 'edge.bw-heat-3',
        style: { 'line-color': '#eab308', width: 4.5, 'z-index': 14 },
      },
      {
        selector: 'edge.bw-heat-4',
        style: { 'line-color': '#f97316', width: 5.5, 'z-index': 15 },
      },
      {
        selector: 'edge.bw-heat-5',
        style: { 'line-color': '#ef4444', width: 6.5, 'z-index': 16 },
      },
      {
        selector: 'edge.bw-heat-6',
        style: { 'line-color': '#991b1b', width: 8, 'z-index': 17 },
      },
      // ── sFlow: Node generating/receiving flow ──
      {
        selector: 'node.flow-active',
        style: {
          'border-color': '#14b8a6',
          'border-width': 3,
          'border-opacity': 1,
        },
      },
      // ── sFlow: LSP highlight (specific LSP selected) ──
      {
        selector: 'edge.flow-lsp-highlight',
        style: {
          'line-color': c.accent,
          width: 5,
          'target-arrow-color': c.accent,
          'target-arrow-shape': 'triangle',
          'arrow-scale': 1.2,
          opacity: 1,
          'z-index': 25,
        },
      },
      {
        selector: 'node.flow-lsp-node',
        style: {
          'background-color': c.accentDim,
          'border-color': c.accent,
          'border-width': 3,
          color: c.textPrimary,
          'font-weight': 600,
          opacity: 1,
          'z-index': 25,
        },
      },
      {
        selector: '.flow-dimmed',
        style: {
          opacity: 0.15,
        },
      },
      // ── sFlow: Animated directional flow indicator ──
      {
        selector: 'edge.flow-animated',
        style: {
          'line-style': 'dashed',
          'line-dash-pattern': [8, 6],
          'line-dash-offset': 0,
        },
      },
    ];
  }
}
