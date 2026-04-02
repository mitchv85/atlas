// ---------------------------------------------------------------------------
// sFlow v5 Collector — UDP Listener + Binary Parser
// ---------------------------------------------------------------------------
// Listens on UDP 6343 (configurable) for sFlow v5 datagrams from Arista EOS
// agents. Parses flow samples and extracts MPLS label stacks for LSP-level
// traffic visibility.
//
// sFlow v5 datagram structure (RFC 3176 / sFlow.org spec):
//   Header  → agent IP, sub-agent, sequence, uptime, sample count
//   Samples → flow samples (with raw packet headers + extended records)
//           → counter samples (interface byte/packet counters)
//
// MPLS label extraction:
//   1. Extended MPLS flow record (enterprise=0, format=1006) — preferred
//      Gives clean in/out label stacks directly.
//   2. Raw packet header (EtherType 0x8847) — fallback
//      Parse MPLS shim headers from the sampled packet header bytes.
//
// Data flow:
//   UDP datagram → parse() → { agentIP, samples[] } → emit('flow')
// ---------------------------------------------------------------------------

const dgram = require('dgram');
const EventEmitter = require('events');

// ── sFlow v5 Constants ────────────────────────────────────────────────────
const SFLOW_VERSION_5 = 5;

// Address types
const ADDR_IPV4 = 1;
const ADDR_IPV6 = 2;

// Sample formats (enterprise=0)
const SAMPLE_FLOW = 1;          // Flow sample
const SAMPLE_COUNTER = 2;       // Counter sample
const SAMPLE_FLOW_EXPANDED = 3; // Expanded flow sample
const SAMPLE_COUNTER_EXPANDED = 4;

// Flow record formats (enterprise=0)
const FLOW_RAW_HEADER = 1;       // Raw packet header
const FLOW_EXT_SWITCH = 1001;    // Extended switch data
const FLOW_EXT_ROUTER = 1002;    // Extended router data
const FLOW_EXT_GATEWAY = 1003;   // Extended gateway data
const FLOW_EXT_MPLS = 1006;      // Extended MPLS data

// Counter record formats (enterprise=0)
const COUNTER_GENERIC = 1;       // Generic interface counters

// Ethernet types
const ETHERTYPE_MPLS = 0x8847;
const ETHERTYPE_MPLS_MC = 0x8848;
const ETHERTYPE_8021Q = 0x8100;
const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_IPV6 = 0x86DD;

// Header protocol values
const HEADER_ETHERNET = 1;
const HEADER_IPV4 = 11;
const HEADER_IPV6 = 12;

// ── Binary Reader Helper ──────────────────────────────────────────────────

class BufferReader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.offset = offset;
  }

  remaining() {
    return this.buf.length - this.offset;
  }

  readUInt32() {
    if (this.remaining() < 4) throw new Error('Buffer underflow reading uint32');
    const val = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return val;
  }

  readBytes(n) {
    if (this.remaining() < n) throw new Error(`Buffer underflow reading ${n} bytes`);
    const slice = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  readIPv4() {
    const bytes = this.readBytes(4);
    return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  }

  readIPv6() {
    const bytes = this.readBytes(16);
    const parts = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(bytes.readUInt16BE(i).toString(16));
    }
    return parts.join(':');
  }

  readAddress() {
    const addrType = this.readUInt32();
    if (addrType === ADDR_IPV4) return { type: 'ipv4', address: this.readIPv4() };
    if (addrType === ADDR_IPV6) return { type: 'ipv6', address: this.readIPv6() };
    // Unknown type — skip based on type (shouldn't happen)
    return { type: 'unknown', address: null };
  }

  skip(n) {
    if (this.remaining() < n) throw new Error(`Buffer underflow skipping ${n} bytes`);
    this.offset += n;
  }

  // Align to 4-byte boundary (XDR padding)
  align4() {
    const mod = this.offset % 4;
    if (mod !== 0) this.offset += (4 - mod);
  }
}

// ── MPLS Label Parser ─────────────────────────────────────────────────────

/**
 * Parse an MPLS label from a 32-bit value.
 * Layout: label(20) | tc(3) | s(1) | ttl(8)
 */
function parseMplsLabel(value) {
  return {
    label: (value >>> 12) & 0xFFFFF,
    tc: (value >>> 9) & 0x7,
    bottomOfStack: (value >>> 8) & 0x1,
    ttl: value & 0xFF,
  };
}

/**
 * Extract MPLS label stack from raw Ethernet frame bytes.
 * Walks past Ethernet header (+ optional 802.1Q) to find MPLS shim headers.
 */
function extractMplsLabelsFromRawHeader(headerBytes) {
  if (headerBytes.length < 14) return null; // Too short for Ethernet

  let offset = 12; // Skip dst MAC (6) + src MAC (6)
  let etherType = headerBytes.readUInt16BE(offset);
  offset += 2;

  // Walk through 802.1Q tags
  while (etherType === ETHERTYPE_8021Q && offset + 4 <= headerBytes.length) {
    offset += 2; // Skip VLAN TCI
    etherType = headerBytes.readUInt16BE(offset);
    offset += 2;
  }

  // Check for MPLS
  if (etherType !== ETHERTYPE_MPLS && etherType !== ETHERTYPE_MPLS_MC) {
    return null; // Not an MPLS frame
  }

  // Parse MPLS label stack
  const labels = [];
  while (offset + 4 <= headerBytes.length) {
    const raw = headerBytes.readUInt32BE(offset);
    offset += 4;
    const label = parseMplsLabel(raw);
    labels.push(label);
    if (label.bottomOfStack) break; // Last label
  }

  return labels.length > 0 ? labels : null;
}

// ── sFlow v5 Datagram Parser ──────────────────────────────────────────────

/**
 * Parse a single sFlow v5 datagram.
 *
 * @param {Buffer} buf - Raw UDP payload
 * @returns {Object|null} Parsed datagram or null on error
 */
function parseDatagram(buf) {
  try {
    const reader = new BufferReader(buf);

    // ── Datagram Header ──
    const version = reader.readUInt32();
    if (version !== SFLOW_VERSION_5) return null;

    const agentAddr = reader.readAddress();
    const subAgentId = reader.readUInt32();
    const sequenceNumber = reader.readUInt32();
    const uptime = reader.readUInt32();
    const numSamples = reader.readUInt32();

    const datagram = {
      version,
      agentAddress: agentAddr.address,
      subAgentId,
      sequenceNumber,
      uptime,
      samples: [],
    };

    // ── Parse Samples ──
    for (let i = 0; i < numSamples && reader.remaining() > 8; i++) {
      try {
        const sample = parseSample(reader);
        if (sample) datagram.samples.push(sample);
      } catch {
        break; // Malformed sample — stop parsing
      }
    }

    return datagram;
  } catch {
    return null; // Malformed datagram
  }
}

/**
 * Parse a single sample record.
 */
function parseSample(reader) {
  const sampleTypeRaw = reader.readUInt32();
  const sampleLength = reader.readUInt32();

  const enterprise = (sampleTypeRaw >>> 12);
  const format = sampleTypeRaw & 0xFFF;
  const endOffset = reader.offset + sampleLength;

  // Only parse enterprise=0 samples
  if (enterprise !== 0) {
    reader.offset = endOffset;
    return null;
  }

  let sample = null;

  if (format === SAMPLE_FLOW || format === SAMPLE_FLOW_EXPANDED) {
    sample = parseFlowSample(reader, format, endOffset);
  } else if (format === SAMPLE_COUNTER || format === SAMPLE_COUNTER_EXPANDED) {
    sample = parseCounterSample(reader, format, endOffset);
  }

  // Ensure we advance past the sample regardless
  reader.offset = endOffset;
  return sample;
}

/**
 * Parse a flow sample.
 */
function parseFlowSample(reader, format, endOffset) {
  const sequenceNumber = reader.readUInt32();

  let sourceIdType, sourceIdIndex;
  if (format === SAMPLE_FLOW_EXPANDED) {
    sourceIdType = reader.readUInt32();
    sourceIdIndex = reader.readUInt32();
  } else {
    const sourceId = reader.readUInt32();
    sourceIdType = (sourceId >>> 24) & 0xFF;
    sourceIdIndex = sourceId & 0x00FFFFFF;
  }

  const samplingRate = reader.readUInt32();
  const samplePool = reader.readUInt32();
  const drops = reader.readUInt32();

  let inputInterface, outputInterface;
  if (format === SAMPLE_FLOW_EXPANDED) {
    reader.readUInt32(); // input format
    inputInterface = reader.readUInt32();
    reader.readUInt32(); // output format
    outputInterface = reader.readUInt32();
  } else {
    inputInterface = reader.readUInt32();
    outputInterface = reader.readUInt32();
  }

  const numRecords = reader.readUInt32();

  const sample = {
    type: 'flow',
    sequenceNumber,
    sourceIdType,
    sourceIdIndex,
    samplingRate,
    samplePool,
    drops,
    inputInterface,
    outputInterface,
    records: [],
    // Extracted data (populated during record parsing)
    mplsLabelsIn: null,
    mplsLabelsOut: null,
    frameLength: 0,
    headerProtocol: 0,
    srcIP: null,
    dstIP: null,
    srcPort: null,
    dstPort: null,
    ipProtocol: null,
  };

  // Parse flow records
  for (let i = 0; i < numRecords && reader.offset < endOffset; i++) {
    try {
      parseFlowRecord(reader, sample);
    } catch {
      break; // Malformed record — stop
    }
  }

  return sample;
}

/**
 * Parse a single flow record and enrich the sample.
 */
function parseFlowRecord(reader, sample) {
  const recordTypeRaw = reader.readUInt32();
  const recordLength = reader.readUInt32();
  const recordEnd = reader.offset + recordLength;

  const enterprise = (recordTypeRaw >>> 12);
  const format = recordTypeRaw & 0xFFF;

  if (enterprise === 0) {
    if (format === FLOW_RAW_HEADER) {
      parseRawHeader(reader, sample, recordEnd);
    } else if (format === FLOW_EXT_MPLS) {
      parseExtendedMpls(reader, sample, recordEnd);
    } else if (format === FLOW_EXT_ROUTER) {
      parseExtendedRouter(reader, sample, recordEnd);
    }
  }

  // Advance past record regardless
  reader.offset = recordEnd;
}

/**
 * Parse raw packet header record (enterprise=0, format=1).
 * Extracts: frame length, MPLS labels (from Ethernet header), IP 5-tuple.
 */
function parseRawHeader(reader, sample, recordEnd) {
  const headerProtocol = reader.readUInt32();
  const frameLength = reader.readUInt32();
  const stripped = reader.readUInt32();
  const headerLength = reader.readUInt32();

  sample.headerProtocol = headerProtocol;
  sample.frameLength = frameLength;

  if (headerLength === 0 || reader.offset + headerLength > recordEnd) return;

  const headerBytes = reader.readBytes(headerLength);

  // Extract MPLS labels from raw header if present (only for Ethernet frames)
  if (headerProtocol === HEADER_ETHERNET) {
    const labels = extractMplsLabelsFromRawHeader(headerBytes);
    if (labels && !sample.mplsLabelsIn) {
      // Raw header gives us the "incoming" label stack as seen on the wire
      sample.mplsLabelsIn = labels;
    }

    // Also try to extract IP 5-tuple from within the frame
    extractIPFromEthernet(headerBytes, sample);
  } else if (headerProtocol === HEADER_IPV4) {
    extractIPv4(headerBytes, 0, sample);
  }
}

/**
 * Parse Extended MPLS flow record (enterprise=0, format=1006).
 * This is the preferred source — gives clean in/out label stacks.
 */
function parseExtendedMpls(reader, sample, recordEnd) {
  // Next-hop address
  const nhAddr = reader.readAddress();

  // In label stack
  const inCount = reader.readUInt32();
  const inLabels = [];
  for (let i = 0; i < inCount && reader.offset + 4 <= recordEnd; i++) {
    const raw = reader.readUInt32();
    inLabels.push(parseMplsLabel(raw));
  }

  // Out label stack
  const outCount = reader.readUInt32();
  const outLabels = [];
  for (let i = 0; i < outCount && reader.offset + 4 <= recordEnd; i++) {
    const raw = reader.readUInt32();
    outLabels.push(parseMplsLabel(raw));
  }

  // Extended MPLS data overrides raw header MPLS data
  if (inLabels.length > 0) sample.mplsLabelsIn = inLabels;
  if (outLabels.length > 0) sample.mplsLabelsOut = outLabels;
}

/**
 * Parse Extended Router flow record (enterprise=0, format=1002).
 */
function parseExtendedRouter(reader, sample, _recordEnd) {
  const nhAddr = reader.readAddress();
  sample.nextHopRouter = nhAddr.address;
  sample.srcMaskLen = reader.readUInt32();
  sample.dstMaskLen = reader.readUInt32();
}

/**
 * Extract IP 5-tuple from an Ethernet frame.
 */
function extractIPFromEthernet(headerBytes, sample) {
  if (headerBytes.length < 14) return;

  let offset = 12;
  let etherType = headerBytes.readUInt16BE(offset);
  offset += 2;

  // Walk through VLAN tags
  while (etherType === ETHERTYPE_8021Q && offset + 4 <= headerBytes.length) {
    offset += 2;
    etherType = headerBytes.readUInt16BE(offset);
    offset += 2;
  }

  // Walk past MPLS labels to find the IP payload
  if (etherType === ETHERTYPE_MPLS || etherType === ETHERTYPE_MPLS_MC) {
    while (offset + 4 <= headerBytes.length) {
      const raw = headerBytes.readUInt32BE(offset);
      offset += 4;
      if ((raw >>> 8) & 0x1) break; // Bottom of stack
    }
    // After MPLS labels, try to detect IPv4 or IPv6 by version nibble
    if (offset < headerBytes.length) {
      const versionNibble = (headerBytes[offset] >>> 4) & 0xF;
      if (versionNibble === 4) {
        extractIPv4(headerBytes, offset, sample);
      }
      // IPv6 support could go here
    }
    return;
  }

  if (etherType === ETHERTYPE_IPV4) {
    extractIPv4(headerBytes, offset, sample);
  }
}

/**
 * Extract IPv4 header fields.
 */
function extractIPv4(buf, offset, sample) {
  if (offset + 20 > buf.length) return; // Need at least 20 bytes for IPv4 header

  const ihl = (buf[offset] & 0x0F) * 4;
  sample.ipProtocol = buf[offset + 9];
  sample.srcIP = `${buf[offset + 12]}.${buf[offset + 13]}.${buf[offset + 14]}.${buf[offset + 15]}`;
  sample.dstIP = `${buf[offset + 16]}.${buf[offset + 17]}.${buf[offset + 18]}.${buf[offset + 19]}`;

  // Extract ports for TCP (6) and UDP (17)
  if ((sample.ipProtocol === 6 || sample.ipProtocol === 17) && offset + ihl + 4 <= buf.length) {
    sample.srcPort = buf.readUInt16BE(offset + ihl);
    sample.dstPort = buf.readUInt16BE(offset + ihl + 2);
  }
}

/**
 * Parse a counter sample.
 */
function parseCounterSample(reader, format, endOffset) {
  const sequenceNumber = reader.readUInt32();

  let sourceIdType, sourceIdIndex;
  if (format === SAMPLE_COUNTER_EXPANDED) {
    sourceIdType = reader.readUInt32();
    sourceIdIndex = reader.readUInt32();
  } else {
    const sourceId = reader.readUInt32();
    sourceIdType = (sourceId >>> 24) & 0xFF;
    sourceIdIndex = sourceId & 0x00FFFFFF;
  }

  const numRecords = reader.readUInt32();

  const sample = {
    type: 'counter',
    sequenceNumber,
    sourceIdType,
    sourceIdIndex,
    records: [],
  };

  for (let i = 0; i < numRecords && reader.offset < endOffset; i++) {
    try {
      const record = parseCounterRecord(reader, endOffset);
      if (record) sample.records.push(record);
    } catch {
      break;
    }
  }

  return sample;
}

/**
 * Parse a counter record (generic interface counters).
 */
function parseCounterRecord(reader, endOffset) {
  const recordTypeRaw = reader.readUInt32();
  const recordLength = reader.readUInt32();
  const recordEnd = reader.offset + recordLength;

  const enterprise = (recordTypeRaw >>> 12);
  const format = recordTypeRaw & 0xFFF;

  let record = null;

  if (enterprise === 0 && format === COUNTER_GENERIC && recordLength >= 88) {
    record = {
      type: 'generic',
      ifIndex: reader.readUInt32(),
      ifType: reader.readUInt32(),
      ifSpeed: reader.readUInt32(),       // Note: might be capped at 4Gbps
      ifDirection: reader.readUInt32(),
      // Skip ifStatus (4 bytes)
    };
    // We only need a subset — skip the rest
  }

  reader.offset = recordEnd;
  return record;
}

// ── sFlow Collector ───────────────────────────────────────────────────────

class SflowCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    this._port = options.port || 6343;
    this._bindAddress = options.bindAddress || '0.0.0.0';
    this._socket = null;
    this._running = false;
    this._stats = {
      datagramsReceived: 0,
      datagramsValid: 0,
      datagramsInvalid: 0,
      flowSamples: 0,
      counterSamples: 0,
      mplsFlows: 0,
      lastReceivedAt: null,
    };
  }

  /**
   * Start the UDP listener.
   */
  start() {
    if (this._running) return;

    this._socket = dgram.createSocket('udp4');

    this._socket.on('message', (msg, rinfo) => {
      this._stats.datagramsReceived++;
      this._stats.lastReceivedAt = new Date().toISOString();

      const datagram = parseDatagram(msg);
      if (!datagram) {
        this._stats.datagramsInvalid++;
        return;
      }

      this._stats.datagramsValid++;

      // Process each sample
      for (const sample of datagram.samples) {
        if (sample.type === 'flow') {
          this._stats.flowSamples++;

          if (sample.mplsLabelsIn || sample.mplsLabelsOut) {
            this._stats.mplsFlows++;
          }

          // Emit the flow sample with agent context
          this.emit('flow', {
            agentAddress: datagram.agentAddress,
            uptime: datagram.uptime,
            ...sample,
          });
        } else if (sample.type === 'counter') {
          this._stats.counterSamples++;

          this.emit('counter', {
            agentAddress: datagram.agentAddress,
            uptime: datagram.uptime,
            ...sample,
          });
        }
      }
    });

    this._socket.on('error', (err) => {
      console.error(`  [sFlow] UDP error: ${err.message}`);
      this.emit('error', err);
    });

    this._socket.bind(this._port, this._bindAddress, () => {
      this._running = true;
      console.info(`  [sFlow] Listening on UDP ${this._bindAddress}:${this._port}`);
      this.emit('listening');
    });
  }

  /**
   * Stop the UDP listener.
   */
  stop() {
    if (this._socket) {
      this._socket.close();
      this._socket = null;
    }
    this._running = false;
  }

  /**
   * Get collector statistics.
   */
  getStats() {
    return {
      running: this._running,
      port: this._port,
      ...this._stats,
    };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────
module.exports = {
  SflowCollector,
  parseDatagram,
  parseMplsLabel,
  extractMplsLabelsFromRawHeader,
};
