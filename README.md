# ATLAS

**Protocol-aware network topology visualization and path analysis engine.**

ATLAS reads the IS-IS link-state database from your network devices, builds an interactive topology map, and lets you explore nodes, links, prefixes, and (coming soon) Segment Routing and FlexAlgo state — all from your browser.

---

## Features

### Phase 1 — IS-IS Topology Visualization ✅
- Add and manage network devices (Arista EOS via eAPI)
- Collect the IS-IS LSDB from any device in the domain
- Interactive force-directed topology graph (Cytoscape.js)
- Click any node to inspect: hostname, system-id, LSP state, IP reachability
- Click any link to inspect: metrics (both directions), interfaces, IS-IS level
- Zoom, pan, fit-to-screen, and re-layout controls

### Phase 2 — Segment Routing Extensions 🔜
- SR Prefix-SID (TLV 135 sub-TLV 3)
- SR Adjacency-SID
- Node SID, Anycast SID visibility
- SRGB / SRLB range display

### Phase 3 — FlexAlgo Awareness 🔜
- FlexAlgo Definition (FAD) parsing
- FlexAlgo Participation display per node
- Color-coded links per algorithm selection
- Algorithm dropdown overlay on topology

### Phase 4 — BGP IPVPN + Algo Mapping 🔜
- Prefix-to-Algorithm mapping overlay
- BGP AFI/SAFI 1/128 (IPVPN / 4364) integration
- Visual path tracing across the topology

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