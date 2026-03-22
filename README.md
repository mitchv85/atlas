# ATLAS

**Network topology visualization, path analysis, and operations platform.**

ATLAS reads the IS-IS link-state database from Arista EOS devices, builds an interactive topology map, and provides Segment Routing path analysis with TI-LFA backup visualization, ECMP path enumeration, real label stacks from the tunnel FIB, adjacency health monitoring, device management with SSH terminals, and right-click context menus for rapid path analysis — all from your browser.

---

## Features

### Topology Visualization
- Live IS-IS topology from LSDB with 15-second background polling
- Cytoscape.js force-directed layout with persistent node positions
- Directional per-node IS-IS metrics on edge labels
- Parallel link support between same node pairs

### Segment Routing Path Analysis
- SPF-computed shortest paths with real tunnel FIB label stacks
- TI-LFA backup paths with node and link failure simulation
- ECMP path enumeration with 4-color visualization and hover-to-isolate
- Label stack decoding: Prefix-SIDs, Adj-SIDs, Implicit Null (PHP)
- Right-click context menus: set source/dest, fail nodes/links — auto-computes
- Remote Node SID Reachability dashboard with protection status badges

### Operational Health
- Adjacency health overlay: state, uptime, hold timers, BFD, MTU, SR, GR
- Link health badges (healthy/degraded/down) on every edge
- Per-device connectivity testing (individual and bulk)

### Device Management
- Device inventory table with model, EOS version, serial, chipset, fwd agent
- Add devices individually or bulk import via CSV/JSON
- Export device inventory as CSV

### Device Detail View
- **Overview:** Info cards + syntax-highlighted running config with search/copy
- **Quick Commands:** CLI panel with SR/IS-IS quick picks and command history
- **Flash Navigator:** Browse flash: filesystem with breadcrumb navigation
- **SSH Terminal:** Live interactive terminal via WebSocket proxy + xterm.js

### Infrastructure
- PM2 production service management with structured logging
- WebSocket real-time topology updates with polling fallback
- Config-backed device store (atlas.config.json)
- Server-side persistent node positions (atlas.positions.json)

### Phase 1 — IS-IS Topology Visualization ✅
### Roadmap
- FlexAlgo awareness (FAD parsing, per-algo overlays)
- BGP IPVPN integration (prefix-to-algorithm mapping)

---

## Quick Start

### Prerequisites
- Node.js 18+
- PM2 (`npm install -g pm2`)
- An Arista EOS device with eAPI enabled and IS-IS running

### Install

```bash
git clone https://github.com/mitchv85/atlas.git
cd atlas
npm install
```

### Configure Devices

Edit `atlas.config.json` with your device inventory:

```json
{
  "polling": {
    "enabled": true,
    "intervalSeconds": 15
  },
  "devices": [
    {
      "name": "PE-1",
      "host": "10.0.0.1",
      "port": 443,
      "username": "admin",
      "password": "admin",
      "transport": "https"
    }
  ]
}
```

### Run (Production — PM2)

```bash
npm start          # Start ATLAS as a PM2 service
npm run status     # Check service status
npm run logs       # Tail the last 50 log lines
npm run restart    # Restart the service
npm run stop       # Stop the service
```

ATLAS will auto-restart on crash and survive terminal disconnects.

### Run (Development)

```bash
npm run dev        # Starts with --watch for auto-reload on file changes
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Enable eAPI on your Arista device

```
management api http-commands
   no shutdown
```

---

## Architecture

```
atlas/
├── server.js                    # Express entry point
├── public/                      # Frontend (static)
│   ├── index.html               # SPA shell
│   ├── css/atlas.css            # Dark NOC-inspired theme
│   └── js/
│       ├── api.js               # Frontend API client
│       ├── topology.js          # Cytoscape.js renderer
│       └── app.js               # Main application logic
└── src/                         # Backend
    ├── routes/
    │   ├── devices.js           # Device CRUD + connectivity test
    │   └── topology.js          # LSDB collection + graph serving
    ├── services/
    │   ├── eapi.js              # Arista eAPI client (JSON-RPC/HTTPS)
    │   ├── isisParser.js        # IS-IS LSDB TLV parser
    │   └── topologyBuilder.js   # LSDB → Cytoscape.js graph builder
    └── store/
        └── devices.js           # In-memory device store
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/devices` | List all configured devices |
| `POST` | `/api/devices` | Add a new device |
| `DELETE` | `/api/devices/:id` | Remove a device |
| `POST` | `/api/devices/:id/test` | Test eAPI connectivity |
| `GET` | `/api/topology` | Get current topology graph |
| `POST` | `/api/topology/collect` | Collect LSDB and build topology |
| `GET` | `/api/topology/node/:systemId` | Get detailed node info |

---

## License

MIT