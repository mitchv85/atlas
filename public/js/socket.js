// ---------------------------------------------------------------------------
// ATLAS WebSocket Client — with polling fallback
// ---------------------------------------------------------------------------
// Connects to the ATLAS WebSocket server for real-time topology updates.
// Falls back to HTTP polling if WebSocket is unavailable.
// ---------------------------------------------------------------------------

class AtlasSocket {
  constructor() {
    this._ws = null;
    this._pollTimer = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 2000;
    this._maxReconnectDelay = 30000;
    this._pollInterval = 15000;
    this._connected = false;
    this._handlers = new Map();
    this._lastTopologyHash = null;
  }

  /**
   * Connect to the WebSocket server.
   * Falls back to polling if WS fails.
   */
  connect() {
    this._connectWS();
  }

  /**
   * Register a handler for a message type.
   * @param {string} type - Message type (e.g., 'topology:changed', 'status')
   * @param {Function} handler - Callback receiving the message data
   */
  on(type, handler) {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, []);
    }
    this._handlers.get(type).push(handler);
  }

  /**
   * Emit a message to registered handlers.
   */
  _emit(type, data) {
    const handlers = this._handlers.get(type) || [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`Handler error for ${type}:`, err);
      }
    }
  }

  // ── WebSocket ───────────────────────────────────────────────────

  _connectWS() {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws`;

      this._ws = new WebSocket(url);

      this._ws.onopen = () => {
        this._connected = true;
        this._reconnectDelay = 2000; // Reset backoff
        this._stopPolling(); // WS is live, no need for polling
        this._emit('connection', { status: 'websocket' });
      };

      this._ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._emit(msg.type, msg.data);
        } catch (err) {
          console.error('WS message parse error:', err);
        }
      };

      this._ws.onclose = () => {
        this._connected = false;
        this._emit('connection', { status: 'disconnected' });
        this._scheduleReconnect();
        this._startPolling(); // Fall back to polling
      };

      this._ws.onerror = () => {
        // onclose will fire after this
      };
    } catch (err) {
      console.error('WebSocket connect error:', err);
      this._startPolling();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectWS();
    }, this._reconnectDelay);

    // Exponential backoff
    this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, this._maxReconnectDelay);
  }

  // ── Polling Fallback ────────────────────────────────────────────

  _startPolling() {
    if (this._pollTimer) return; // Already polling

    this._emit('connection', { status: 'polling' });

    this._pollTimer = setInterval(async () => {
      try {
        const token = localStorage.getItem('atlas-token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch('/api/topology', { headers });
        if (res.ok) {
          const topology = await res.json();
          const hash = `${topology.metadata?.nodeCount}|${topology.metadata?.edgeCount}|${topology.metadata?.collectedAt}`;

          if (hash !== this._lastTopologyHash) {
            this._lastTopologyHash = hash;
            this._emit('topology:changed', topology);
          }

          this._emit('topology:updated', { metadata: topology.metadata });
        }

        // Also fetch status
        const statusRes = await fetch('/api/status', { headers });
        if (statusRes.ok) {
          const status = await statusRes.json();
          this._emit('status', status);
        }
      } catch (err) {
        // Silently retry on next interval
      }
    }, this._pollInterval);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }
}
