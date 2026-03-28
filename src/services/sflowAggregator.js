// ---------------------------------------------------------------------------
// sFlow Aggregator — Flow Aggregation + LSP Correlation Engine
// ---------------------------------------------------------------------------
// Takes raw flow samples from the sFlow collector and:
//   1. Maps MPLS labels to known SR SIDs using ATLAS's topology data
//   2. Aggregates traffic into per-LSP and per-edge flow records
//   3. Maintains sliding time windows for rate calculation
//   4. Emits events when flow data changes for real-time UI updates
//
// The correlation engine is the key differentiator — it uses the SRGB,
// prefix SIDs, adjacency SIDs, and FlexAlgo SIDs already collected by
// the topology poller to map sampled label stacks to actual LSPs.
//
// Data flow:
//   sflowCollector 'flow' event → correlateFlow() → aggregate() → emit
// ---------------------------------------------------------------------------

const EventEmitter = require('events');

// ── Flow Window Configuration ─────────────────────────────────────────────
const DEFAULT_WINDOW_MS = 30_000;       // 30-second sliding window
const DEFAULT_BUCKET_MS = 5_000;        // 5-second buckets within the window
const DEFAULT_EMIT_INTERVAL_MS = 5_000; // Push updates to UI every 5s
const MAX_TOP_TALKERS = 20;             // Top N flows per LSP

class SflowAggregator extends EventEmitter {
  constructor(options = {}) {
    super();

    this._windowMs = options.windowMs || DEFAULT_WINDOW_MS;
    this._bucketMs = options.bucketMs || DEFAULT_BUCKET_MS;
    this._emitIntervalMs = options.emitIntervalMs || DEFAULT_EMIT_INTERVAL_MS;

    // ── LSP Flow Table ──
    // Map<lspKey, LspFlow>
    // lspKey: "srcNode→dstNode:algo{N}" or "srcNode→dstNode:label{L}"
    this._lspFlows = new Map();

    // ── Edge Flow Table ──
    // Map<edgeId, EdgeFlow>
    // Aggregated traffic per topology edge (link between two nodes)
    this._edgeFlows = new Map();

    // ── Agent-to-Node Mapping ──
    // Map<agentIP, nodeHostname>
    // Built from topology data (interface addresses → node identity)
    this._agentMap = new Map();

    // ── SR Label Knowledge ──
    // Populated from topology data
    this._srgbBase = null;
    this._srgbRange = null;
    this._sidToNode = new Map();    // Map<sidIndex, { hostname, systemId, routerId }>
    this._adjSidMap = new Map();    // Map<label, { from, to, edgeId }>
    this._faSidToNode = new Map();  // Map<label, { hostname, algo }>

    // ── Topology Reference ──
    this._topology = null;
    this._nodeByHostname = new Map();  // hostname → node data
    this._nodeByRouterId = new Map();  // router ID → node data
    this._edgeIndex = new Map();       // "srcSysId|tgtSysId" → edge data[]

    // ── Timers ──
    this._emitTimer = null;
    this._cleanupTimer = null;

    // ── Stats ──
    this._stats = {
      flowsProcessed: 0,
      flowsCorrelated: 0,
      flowsUncorrelated: 0,
      activeLsps: 0,
      activeEdges: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Topology Integration
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Update the aggregator's view of the network topology.
   * Called whenever the topology poller produces a new topology.
   */
  updateTopology(topology) {
    if (!topology) return;
    this._topology = topology;

    // ── Build agent-to-node map ──
    // Map each node's interface addresses and router ID to its hostname
    this._agentMap.clear();
    this._nodeByHostname.clear();
    this._nodeByRouterId.clear();

    for (const node of topology.nodes) {
      const d = node.data;
      const hostname = d.hostname || d.label;

      this._nodeByHostname.set(hostname, d);

      // Map router ID → node
      const rid = d.routerCaps?.routerId;
      if (rid) {
        this._agentMap.set(rid, hostname);
        this._nodeByRouterId.set(rid, d);
      }

      // Map all interface addresses → node
      for (const addr of (d.interfaceAddresses || [])) {
        this._agentMap.set(addr, hostname);
      }
    }

    // ── Build SR label maps ──
    this._sidToNode.clear();
    this._adjSidMap.clear();
    this._faSidToNode.clear();

    for (const node of topology.nodes) {
      const d = node.data;
      const hostname = d.hostname || d.label;
      const caps = d.routerCaps;

      // SRGB (should be consistent across all nodes in the domain)
      const srgbEntry = caps?.srgb?.[0];
      if (srgbEntry?.base && !this._srgbBase) {
        this._srgbBase = srgbEntry.base;
        this._srgbRange = srgbEntry.range || 65536;
      }

      // Prefix SIDs → node mapping
      for (const sid of (d.srPrefixSids || [])) {
        const sidIndex = sid.sid;  // SID index from isisParser
        this._sidToNode.set(sidIndex, {
          hostname,
          systemId: d.systemId,
          routerId: caps?.routerId,
          algorithm: sid.algorithm || 0,
          prefix: sid.prefix,
        });

        // Also map the absolute label (SRGB base + SID index)
        if (this._srgbBase) {
          const absLabel = this._srgbBase + sidIndex;
          if (sid.algorithm && sid.algorithm >= 128) {
            // FlexAlgo SID
            this._faSidToNode.set(absLabel, {
              hostname,
              algo: sid.algorithm,
              sidIndex,
            });
          }
        }
      }

      // Adjacency SIDs
      for (const adjSid of (d.srAdjSids || [])) {
        if (adjSid.sid) {
          this._adjSidMap.set(adjSid.sid, {
            from: hostname,
            fromSystemId: d.systemId,
            neighborHostname: adjSid.neighbor,   // isisParser stores hostname
          });
        }
      }
    }

    // ── Build edge index ──
    this._edgeIndex.clear();
    for (const edge of topology.edges) {
      const d = edge.data;
      const key1 = `${d.source}|${d.target}`;
      const key2 = `${d.target}|${d.source}`;

      if (!this._edgeIndex.has(key1)) this._edgeIndex.set(key1, []);
      this._edgeIndex.get(key1).push(d);

      if (!this._edgeIndex.has(key2)) this._edgeIndex.set(key2, []);
      this._edgeIndex.get(key2).push(d);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Flow Processing
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Process an incoming flow sample from the sFlow collector.
   */
  processFlow(flowSample) {
    this._stats.flowsProcessed++;

    const now = Date.now();
    const agentNode = this._agentMap.get(flowSample.agentAddress);

    // ── Correlate MPLS labels ──
    const correlation = this._correlateLabels(flowSample, agentNode);

    if (correlation) {
      this._stats.flowsCorrelated++;

      // Calculate estimated bytes (frame length × sampling rate)
      const estimatedBytes = (flowSample.frameLength || 0) * (flowSample.samplingRate || 1);

      // ── Update LSP flow ──
      const lspKey = correlation.lspKey;
      let lspFlow = this._lspFlows.get(lspKey);
      if (!lspFlow) {
        lspFlow = {
          lspKey,
          sourceNode: correlation.sourceNode,
          destNode: correlation.destNode,
          algorithm: correlation.algorithm,
          labels: correlation.labels,
          edgePath: correlation.edgePath || [],
          buckets: [],
          topTalkers: new Map(), // "srcIP→dstIP" → { bytes, packets, ... }
        };
        this._lspFlows.set(lspKey, lspFlow);
      }

      // Add to current bucket
      this._addToBucket(lspFlow, now, estimatedBytes);

      // Track top talkers within this LSP
      if (flowSample.srcIP && flowSample.dstIP) {
        const talkerKey = `${flowSample.srcIP}→${flowSample.dstIP}`;
        const talker = lspFlow.topTalkers.get(talkerKey) || {
          srcIP: flowSample.srcIP,
          dstIP: flowSample.dstIP,
          srcPort: flowSample.srcPort,
          dstPort: flowSample.dstPort,
          ipProtocol: flowSample.ipProtocol,
          bytes: 0,
          packets: 0,
          lastSeen: 0,
        };
        talker.bytes += estimatedBytes;
        talker.packets += flowSample.samplingRate || 1;
        talker.lastSeen = now;
        lspFlow.topTalkers.set(talkerKey, talker);
      }

      // ── Update Edge flows ──
      for (const edgeId of (correlation.edgePath || [])) {
        let edgeFlow = this._edgeFlows.get(edgeId);
        if (!edgeFlow) {
          edgeFlow = {
            edgeId,
            buckets: [],
            lsps: new Set(),
          };
          this._edgeFlows.set(edgeId, edgeFlow);
        }
        this._addToBucket(edgeFlow, now, estimatedBytes);
        edgeFlow.lsps.add(lspKey);
      }
    } else {
      this._stats.flowsUncorrelated++;
    }
  }

  /**
   * Correlate MPLS label stack to known SR SIDs and LSPs.
   *
   * @returns {Object|null} Correlation result with LSP identity
   */
  _correlateLabels(flowSample, agentNode) {
    const labels = flowSample.mplsLabelsIn || flowSample.mplsLabelsOut;
    if (!labels || labels.length === 0) return null;
    if (!this._srgbBase) return null; // No SR knowledge yet

    const srgbBase = this._srgbBase;
    const srgbEnd = srgbBase + this._srgbRange;

    // ── Identify source node ──
    // The agent that reported this flow is the node that saw the packet
    const sourceNode = agentNode || flowSample.agentAddress;

    // ── Walk the label stack ──
    let destNode = null;
    let algorithm = 0;
    const labelValues = labels.map((l) => l.label);

    // The transport label (outermost) tells us the destination
    const transportLabel = labels[0].label;

    // Check if it's a prefix SID (within SRGB range)
    if (transportLabel >= srgbBase && transportLabel < srgbEnd) {
      const sidIndex = transportLabel - srgbBase;
      const sidInfo = this._sidToNode.get(sidIndex);
      if (sidInfo) {
        destNode = sidInfo.hostname;
        algorithm = sidInfo.algorithm || 0;
      }
    }

    // Check if it's a FlexAlgo SID
    if (!destNode) {
      const faInfo = this._faSidToNode.get(transportLabel);
      if (faInfo) {
        destNode = faInfo.hostname;
        algorithm = faInfo.algo;
      }
    }

    // Check if it's an Adjacency SID
    if (!destNode) {
      const adjInfo = this._adjSidMap.get(transportLabel);
      if (adjInfo) {
        // Adj-SID: the destination is the neighbor of the node that owns this SID
        destNode = adjInfo.neighborHostname || adjInfo.from;
      }
    }

    if (!destNode) return null; // Can't correlate

    // ── Build LSP key ──
    const lspKey = algorithm > 0
      ? `${sourceNode}→${destNode}:algo${algorithm}`
      : `${sourceNode}→${destNode}:algo0`;

    // ── Try to determine the edge path ──
    // If we know the agent node, we can identify which edge this sample
    // was observed on by matching the input/output interface index
    const edgePath = this._resolveEdgePath(sourceNode, destNode);

    return {
      lspKey,
      sourceNode,
      destNode,
      algorithm,
      labels: labelValues,
      edgePath,
    };
  }

  /**
   * Resolve the edge path for an LSP using topology knowledge.
   * Uses the SPF-computed shortest path between source and destination.
   */
  _resolveEdgePath(sourceNode, destNode) {
    if (!this._topology) return [];

    // Find system IDs for source and dest
    const srcData = this._nodeByHostname.get(sourceNode);
    const dstData = this._nodeByHostname.get(destNode);
    if (!srcData || !dstData) return [];

    const srcSysId = srcData.systemId;
    const dstSysId = dstData.systemId;

    // Look up edges between source and destination
    // For a full path we'd need SPF, but for direct neighbors we can resolve immediately
    const edgeKey = `${srcSysId}|${dstSysId}`;
    const edges = this._edgeIndex.get(edgeKey);
    if (edges && edges.length > 0) {
      return edges.map((e) => e.id);
    }

    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Bucketing + Rate Calculation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add bytes to the current time bucket.
   */
  _addToBucket(flowRecord, now, bytes) {
    const bucketTime = Math.floor(now / this._bucketMs) * this._bucketMs;

    // Find or create the current bucket
    let bucket = flowRecord.buckets.find((b) => b.time === bucketTime);
    if (!bucket) {
      bucket = { time: bucketTime, bytes: 0, packets: 0, samples: 0 };
      flowRecord.buckets.push(bucket);
      // Keep buckets sorted
      flowRecord.buckets.sort((a, b) => a.time - b.time);
    }

    bucket.bytes += bytes;
    bucket.packets++;
    bucket.samples++;
  }

  /**
   * Clean up expired buckets outside the sliding window.
   */
  _cleanupBuckets() {
    const cutoff = Date.now() - this._windowMs;

    for (const [key, lspFlow] of this._lspFlows) {
      lspFlow.buckets = lspFlow.buckets.filter((b) => b.time >= cutoff);

      // Prune top talkers that haven't been seen recently
      for (const [tKey, talker] of lspFlow.topTalkers) {
        if (talker.lastSeen < cutoff) {
          lspFlow.topTalkers.delete(tKey);
        }
      }

      // Remove dead LSPs
      if (lspFlow.buckets.length === 0) {
        this._lspFlows.delete(key);
      }
    }

    for (const [key, edgeFlow] of this._edgeFlows) {
      edgeFlow.buckets = edgeFlow.buckets.filter((b) => b.time >= cutoff);

      // Clean dead LSP references
      for (const lspKey of edgeFlow.lsps) {
        if (!this._lspFlows.has(lspKey)) {
          edgeFlow.lsps.delete(lspKey);
        }
      }

      if (edgeFlow.buckets.length === 0) {
        this._edgeFlows.delete(key);
      }
    }
  }

  /**
   * Calculate the rate (bytes/sec) for a flow record over the sliding window.
   */
  _calculateRate(flowRecord) {
    const cutoff = Date.now() - this._windowMs;
    const activeBuckets = flowRecord.buckets.filter((b) => b.time >= cutoff);

    if (activeBuckets.length === 0) return { bytesPerSec: 0, packetsPerSec: 0 };

    const totalBytes = activeBuckets.reduce((sum, b) => sum + b.bytes, 0);
    const totalPackets = activeBuckets.reduce((sum, b) => sum + b.packets, 0);
    const windowSec = this._windowMs / 1000;

    return {
      bytesPerSec: Math.round(totalBytes / windowSec),
      packetsPerSec: Math.round(totalPackets / windowSec),
      bitsPerSec: Math.round((totalBytes * 8) / windowSec),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Start the aggregation timers.
   */
  start() {
    // Periodic cleanup of expired buckets
    this._cleanupTimer = setInterval(() => this._cleanupBuckets(), this._bucketMs);

    // Periodic UI update emission
    this._emitTimer = setInterval(() => {
      this._cleanupBuckets();
      this._emitFlowUpdate();
    }, this._emitIntervalMs);
  }

  /**
   * Stop the aggregation timers.
   */
  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this._emitTimer) {
      clearInterval(this._emitTimer);
      this._emitTimer = null;
    }
  }

  /**
   * Emit the current flow state for UI consumption.
   */
  _emitFlowUpdate() {
    const snapshot = this.getSnapshot();
    this._stats.activeLsps = snapshot.lspFlows.length;
    this._stats.activeEdges = snapshot.edgeFlows.length;
    this.emit('flows:updated', snapshot);
  }

  /**
   * Get a snapshot of all current flow data.
   */
  getSnapshot() {
    const lspFlows = [];
    for (const [key, flow] of this._lspFlows) {
      const rate = this._calculateRate(flow);
      if (rate.bytesPerSec === 0 && flow.buckets.length === 0) continue;

      // Get top talkers sorted by bytes
      const talkers = Array.from(flow.topTalkers.values())
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, MAX_TOP_TALKERS);

      lspFlows.push({
        lspKey: key,
        sourceNode: flow.sourceNode,
        destNode: flow.destNode,
        algorithm: flow.algorithm,
        labels: flow.labels,
        ...rate,
        topTalkers: talkers,
      });
    }

    // Sort by bitsPerSec descending
    lspFlows.sort((a, b) => b.bitsPerSec - a.bitsPerSec);

    const edgeFlows = [];
    for (const [edgeId, flow] of this._edgeFlows) {
      const rate = this._calculateRate(flow);
      if (rate.bytesPerSec === 0 && flow.buckets.length === 0) continue;

      edgeFlows.push({
        edgeId,
        ...rate,
        lspCount: flow.lsps.size,
        lsps: Array.from(flow.lsps),
      });
    }

    return {
      timestamp: new Date().toISOString(),
      windowMs: this._windowMs,
      lspFlows,
      edgeFlows,
    };
  }

  /**
   * Get aggregator statistics.
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * Get detailed flow data for a specific LSP.
   */
  getLspDetail(lspKey) {
    const flow = this._lspFlows.get(lspKey);
    if (!flow) return null;

    const rate = this._calculateRate(flow);
    const talkers = Array.from(flow.topTalkers.values())
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, MAX_TOP_TALKERS);

    // Build time-series from buckets
    const timeSeries = flow.buckets.map((b) => ({
      time: b.time,
      bytesPerSec: Math.round(b.bytes / (this._bucketMs / 1000)),
      bitsPerSec: Math.round((b.bytes * 8) / (this._bucketMs / 1000)),
    }));

    return {
      lspKey: flow.lspKey,
      sourceNode: flow.sourceNode,
      destNode: flow.destNode,
      algorithm: flow.algorithm,
      labels: flow.labels,
      edgePath: flow.edgePath,
      ...rate,
      topTalkers: talkers,
      timeSeries,
    };
  }

  /**
   * Get flow data for a specific edge.
   */
  getEdgeDetail(edgeId) {
    const flow = this._edgeFlows.get(edgeId);
    if (!flow) return null;

    const rate = this._calculateRate(flow);

    // Get LSP details for each LSP on this edge
    const lspDetails = [];
    for (const lspKey of flow.lsps) {
      const lspFlow = this._lspFlows.get(lspKey);
      if (lspFlow) {
        const lspRate = this._calculateRate(lspFlow);
        lspDetails.push({
          lspKey,
          sourceNode: lspFlow.sourceNode,
          destNode: lspFlow.destNode,
          algorithm: lspFlow.algorithm,
          ...lspRate,
        });
      }
    }

    lspDetails.sort((a, b) => b.bitsPerSec - a.bitsPerSec);

    return {
      edgeId,
      ...rate,
      lsps: lspDetails,
    };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────
module.exports = SflowAggregator;
