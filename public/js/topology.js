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
    this.cy.elements().removeClass('highlighted highlighted-edge neighbor dimmed');
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
    ];
  }
}
