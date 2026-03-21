// ---------------------------------------------------------------------------
// ATLAS Topology Renderer — Cytoscape.js wrapper
// ---------------------------------------------------------------------------

class TopologyRenderer {
  constructor(containerId) {
    this.cy = null;
    this.containerId = containerId;
    this.onNodeClick = null;
    this.onEdgeClick = null;
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

    return this;
  }

  /**
   * Load topology data and apply layout.
   *
   * @param {Object} topology - { nodes: [], edges: [] } in Cytoscape format
   */
  loadTopology(topology) {
    if (!this.cy) this.init();

    this.cy.elements().remove();

    this.cy.add(topology.nodes);
    this.cy.add(topology.edges);

    // Apply force-directed layout
    this.runLayout('cose');
  }

  /**
   * Run a layout algorithm.
   */
  runLayout(name = 'cose') {
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
      },
      grid: {
        name: 'grid',
        animate: true,
        animationDuration: 500,
        padding: 50,
      },
      circle: {
        name: 'circle',
        animate: true,
        animationDuration: 500,
        padding: 50,
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
    this.cy.elements().removeClass('highlighted highlighted-edge neighbor dimmed path-node path-edge path-edge-fwd path-edge-rev path-source path-dest path-failed path-edge-failed path-failed-neighbor path-dimmed');
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
    this.cy.elements().removeClass('path-node path-edge path-edge-fwd path-edge-rev path-source path-dest path-failed path-edge-failed path-failed-neighbor path-dimmed');
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
          label: 'data(metric)',
          'font-family': 'JetBrains Mono, monospace',
          'font-size': 9,
          color: '#536580',
          'text-outline-color': '#0a0e17',
          'text-outline-width': 2,
          'text-rotation': 'autorotate',
          'text-margin-y': -10,
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
    ];
  }
}
