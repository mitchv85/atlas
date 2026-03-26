// ---------------------------------------------------------------------------
// BGP gRPC Client — FRR Northbound Interface
// ---------------------------------------------------------------------------
// Connects to FRR's northbound gRPC API for real-time BGP data access.
//
// FRR exposes a generic YANG-based gRPC service defined in
// frr-northbound.proto. The key operations for ATLAS:
//
//   Get(GetRequest)           → stream GetResponse   (one-shot data pull)
//   Subscribe(SubscribeReq)   → stream SubscribeResp  (real-time updates)
//
// Data is accessed via YANG XPaths. Key paths for BGP:
//   /frr-bgp:bgp/global                        → BGP global config
//   /frr-bgp:bgp/neighbors/neighbor             → Neighbor state
//   /frr-bgp:bgp/neighbors/neighbor/afi-safis   → Per-AFI RIB data
//
// Proto files:
//   FRR's proto definitions live in the FRR source tree at:
//     frr/grpc/frr-northbound.proto
//   They must be copied to this project at:
//     src/proto/frr-northbound.proto
//
// Connection lifecycle:
//   connect() → get/subscribe → disconnect()
//   Auto-reconnect on connection loss with exponential backoff.
// ---------------------------------------------------------------------------

const EventEmitter = require('events');
const path = require('path');

// Lazy-load gRPC packages — server must not crash if they aren't installed yet
let grpc = null;
let protoLoader = null;
let grpcAvailable = false;

try {
  grpc = require('@grpc/grpc-js');
  protoLoader = require('@grpc/proto-loader');
  grpcAvailable = true;
} catch {
  console.warn('  [gRPC] @grpc/grpc-js or @grpc/proto-loader not installed.');
  console.warn('  [gRPC] Run: npm install @grpc/grpc-js @grpc/proto-loader');
  console.warn('  [gRPC] BGP gRPC client will be unavailable until packages are installed.');
}

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'frr-northbound.proto');

// Reconnect backoff settings
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MULTIPLIER = 2;

class BgpGrpcClient extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.connected = false;
    this.connecting = false;
    this.address = '127.0.0.1:50051';
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.subscriptions = new Map(); // path → stream
  }

  /**
   * Initialize the gRPC client by loading the proto definition.
   * Must be called before connect().
   *
   * @returns {boolean} True if proto loaded successfully.
   */
  init() {
    if (!grpcAvailable) {
      console.error('  [gRPC] Cannot initialize — gRPC packages not installed');
      return false;
    }

    try {
      const packageDef = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const proto = grpc.loadPackageDefinition(packageDef);
      this.Northbound = proto.frr.Northbound;

      if (!this.Northbound) {
        console.error('  [gRPC] Failed to load Northbound service from proto');
        return false;
      }

      console.log('  [gRPC] Proto definition loaded');
      return true;
    } catch (err) {
      console.error(`  [gRPC] Proto load error: ${err.message}`);
      console.error('  [gRPC] Ensure frr-northbound.proto exists at src/proto/');
      return false;
    }
  }

  /**
   * Connect to the FRR northbound gRPC server.
   *
   * @param {string} [address] - gRPC server address (default: 127.0.0.1:50051)
   * @returns {Promise<boolean>} True if connected successfully.
   */
  async connect(address) {
    if (this.connected) return true;
    if (this.connecting) return false;

    this.connecting = true;
    this.address = address || this.address;

    try {
      if (!this.Northbound) {
        const loaded = this.init();
        if (!loaded) {
          this.connecting = false;
          return false;
        }
      }

      this.client = new this.Northbound(
        this.address,
        grpc.credentials.createInsecure(),
        {
          'grpc.keepalive_time_ms': 10000,
          'grpc.keepalive_timeout_ms': 5000,
          'grpc.keepalive_permit_without_calls': 1,
        }
      );

      // Wait for the channel to be ready
      await new Promise((resolve, reject) => {
        const deadline = new Date(Date.now() + 10000);
        this.client.waitForReady(deadline, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this.connected = true;
      this.connecting = false;
      this.reconnectAttempts = 0;

      console.log(`  [gRPC] Connected to FRR at ${this.address}`);
      this.emit('connected');

      // Monitor channel state for disconnection
      this._watchChannelState();

      return true;
    } catch (err) {
      this.connecting = false;
      console.error(`  [gRPC] Connection failed: ${err.message}`);
      this.emit('error', err);
      this._scheduleReconnect();
      return false;
    }
  }

  /**
   * Disconnect from the gRPC server and clean up.
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close all active subscriptions
    for (const [path, stream] of this.subscriptions) {
      try { stream.cancel(); } catch {}
    }
    this.subscriptions.clear();

    if (this.client) {
      try { this.client.close(); } catch {}
      this.client = null;
    }

    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = 0;
    this.emit('disconnected');
  }

  /**
   * One-shot YANG data retrieval via the Get RPC.
   *
   * @param {string} yangPath - YANG XPath to query.
   * @param {string} [dataType='all'] - Data type: 'all', 'config', 'state'.
   * @returns {Promise<Object[]>} Array of data responses.
   */
  async get(yangPath, dataType = 'all') {
    if (!this.connected || !this.client) {
      throw new Error('gRPC client not connected');
    }

    const dataTypeMap = { all: 0, config: 1, state: 2 };

    return new Promise((resolve, reject) => {
      const request = {
        type: dataTypeMap[dataType] || 0,
        path: [yangPath],
        encoding: 0, // JSON
      };

      const results = [];
      const stream = this.client.Get(request);

      stream.on('data', (response) => {
        if (response.data) {
          try {
            results.push(JSON.parse(response.data));
          } catch {
            results.push(response.data);
          }
        }
      });

      stream.on('end', () => resolve(results));
      stream.on('error', (err) => reject(err));
    });
  }

  /**
   * Subscribe to YANG path changes for real-time updates.
   * Returns a stream that emits 'data' events on changes.
   *
   * @param {string} yangPath - YANG XPath to subscribe to.
   * @returns {Object} gRPC stream with 'data', 'error', 'end' events.
   */
  subscribe(yangPath) {
    if (!this.connected || !this.client) {
      throw new Error('gRPC client not connected');
    }

    // Cancel existing subscription for this path
    if (this.subscriptions.has(yangPath)) {
      try { this.subscriptions.get(yangPath).cancel(); } catch {}
    }

    const request = {
      path: [yangPath],
      encoding: 0, // JSON
    };

    const stream = this.client.Subscribe(request);
    this.subscriptions.set(yangPath, stream);

    stream.on('error', (err) => {
      console.error(`  [gRPC] Subscription error for ${yangPath}: ${err.message}`);
      this.subscriptions.delete(yangPath);
    });

    stream.on('end', () => {
      this.subscriptions.delete(yangPath);
    });

    return stream;
  }

  // ── Connection Health ───────────────────────────────────────────────

  /**
   * Watch the gRPC channel state and trigger reconnect on failure.
   * @private
   */
  _watchChannelState() {
    if (!this.client) return;

    const channel = this.client.getChannel();
    const currentState = channel.getConnectivityState(false);

    // Watch for state changes
    channel.watchConnectivityState(currentState, Infinity, (err) => {
      if (err) return; // Deadline exceeded (expected on shutdown)

      const newState = channel.getConnectivityState(false);

      if (newState === grpc.connectivityState.TRANSIENT_FAILURE ||
          newState === grpc.connectivityState.SHUTDOWN) {
        console.error('  [gRPC] Connection lost — scheduling reconnect');
        this.connected = false;
        this.emit('disconnected');
        this._scheduleReconnect();
      } else {
        // Continue watching
        this._watchChannelState();
      }
    });
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * @private
   */
  _scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, this.reconnectAttempts),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempts++;

    console.log(`  [gRPC] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.client) {
        try { this.client.close(); } catch {}
        this.client = null;
      }
      await this.connect(this.address);
    }, delay);
  }

  /**
   * Get the current connection status.
   * @returns {Object} Status info.
   */
  getStatus() {
    return {
      available: grpcAvailable,
      connected: this.connected,
      connecting: this.connecting,
      address: this.address,
      reconnectAttempts: this.reconnectAttempts,
      activeSubscriptions: this.subscriptions.size,
    };
  }
}

// Singleton instance
const bgpGrpc = new BgpGrpcClient();

module.exports = bgpGrpc;
