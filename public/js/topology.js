// ---------------------------------------------------------------------------
// ATLAS Topology Renderer — Cytoscape.js wrapper
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

    // Dismiss context menu on left-click anywhere
    this.cy.on('tap', () => {
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
   * Cytoscape.js stylesheet — the visual identity of the topology.
   */
  _getStyles() {
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
          color: '#94a3b8',
          'text-outline-color': '#0a0e17',
          'text-outline-width': 2,
          width: 40,
          height: 40,
          'background-color': '#1e3a5f',
          'border-width': 2,
          'border-color': '#22d3ee',
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
          'border-color': '#22d3ee',
          'border-width': 3,
          'border-opacity': 1,
          'background-color': '#0e7490',
          width: 48,
          height: 48,
          color: '#e8edf5',
          'font-weight': 600,
          'z-index': 20,
        },
      },
      // ── Neighbor of highlighted ──
      {
        selector: 'node.neighbor',
        style: {
          'border-color': '#22d3ee',
          'border-opacity': 0.5,
          'background-color': '#1a3550',
          color: '#e8edf5',
        },
      },
      // ── Default Edge ──
      {
        selector: 'edge',
        style: {
          width: 2,
          'line-color': '#3b5578',
          'curve-style': 'bezier',
          // Directional metric labels — each end shows its own node's configured metric
          'source-label': 'data(sourceMetric)',
          'target-label': 'data(targetMetric)',
          'source-text-offset': 22,
          'target-text-offset': 22,
          'font-family': 'JetBrains Mono, monospace',
          'font-size': 9,
          color: '#536580',
          'text-outline-color': '#0a0e17',
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
          'line-color': '#22d3ee',
          width: 3,
          color: '#22d3ee',
          'z-index': 15,
        },
      },
      // ── Selected ──
      {
        selector: ':selected',
        style: {
          'overlay-color': '#22d3ee',
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
          'background-color': '#0e7490',
          'border-color': '#22d3ee',
          'border-width': 3,
          'border-opacity': 1,
          color: '#e8edf5',
          'font-weight': 600,
          opacity: 1,
          'z-index': 20,
        },
      },
      // ── Selection Markers (pre-compute) ──
      {
        selector: 'node.selected-source',
        style: {
          'border-color': '#22d3ee',
          'border-width': 3,
          'border-style': 'double',
          'z-index': 20,
        },
      },
      {
        selector: 'node.selected-dest',
        style: {
          'border-color': '#34d399',
          'border-width': 3,
          'border-style': 'double',
          'z-index': 20,
        },
      },
      {
        selector: 'node.selected-fail',
        style: {
          'border-color': '#f87171',
          'border-width': 3,
          'border-style': 'dashed',
          'z-index': 20,
        },
      },
      {
        selector: 'edge.selected-fail',
        style: {
          'line-color': '#f87171',
          'line-style': 'dashed',
          'opacity': 0.7,
          'z-index': 20,
        },
      },
      // ── Path: Source node ──
      {
        selector: 'node.path-source',
        style: {
          'background-color': '#0e7490',
          'border-color': '#22d3ee',
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
          'border-color': '#34d399',
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
          'border-color': '#f87171',
          'border-width': 3,
          'border-style': 'dashed',
          opacity: 0.7,
          color: '#f87171',
          'z-index': 15,
        },
      },
      // ── Path: Neighbor of failed element (visible but neutral) ──
      {
        selector: 'node.path-failed-neighbor',
        style: {
          opacity: 0.6,
          'border-color': '#536580',
          color: '#94a3b8',
        },
      },
      // ── Path: Edge on path (base style, no arrows) ──
      {
        selector: 'edge.path-edge',
        style: {
          'line-color': '#22d3ee',
          width: 4,
          color: '#22d3ee',
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
          'target-arrow-color': '#22d3ee',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 1.2,
          'source-arrow-shape': 'none',
        },
      },
      // ── Path: Edge traversed reverse (target→source) — arrow at source ──
      {
        selector: 'edge.path-edge-rev',
        style: {
          'source-arrow-color': '#22d3ee',
          'source-arrow-shape': 'triangle',
          'arrow-scale': 1.2,
          'target-arrow-shape': 'none',
        },
      },
      // ── Path: Failed edge ──
      {
        selector: 'edge.path-edge-failed',
        style: {
          'line-color': '#f87171',
          'line-style': 'dashed',
          'line-dash-pattern': [8, 4],
          width: 3,
          color: '#f87171',
          opacity: 0.7,
          'z-index': 15,
        },
      },
      // ── ECMP: Node on any ECMP path ──
      {
        selector: 'node.ecmp-node',
        style: {
          'background-color': '#1e3a5f',
          'border-color': '#e8edf5',
          'border-width': 2.5,
          'border-opacity': 0.8,
          color: '#e8edf5',
          'font-weight': 600,
          opacity: 1,
          'z-index': 20,
        },
      },
      // ── ECMP: Source node ──
      {
        selector: 'node.ecmp-source',
        style: {
          'border-color': '#22d3ee',
          'border-width': 4,
          'background-color': '#0e7490',
          width: 50,
          height: 50,
          'z-index': 25,
        },
      },
      // ── ECMP: Destination node ──
      {
        selector: 'node.ecmp-dest',
        style: {
          'border-color': '#34d399',
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
          'line-color': '#e8edf5',
          width: 4,
          color: '#e8edf5',
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
    ];
  }
}
