// Minimal gNMI subscribe test — debug "aggregation not supported"
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const PROTO_PATH = path.join(__dirname, 'src', 'proto', 'gnmi.proto');
const TARGET = process.argv[2] || '172.31.0.41:6030';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin';

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const gnmiProto = grpc.loadPackageDefinition(packageDef).gnmi;

const client = new gnmiProto.gNMI(TARGET, grpc.credentials.createInsecure());

const metadata = new grpc.Metadata();
metadata.set('username', USER);
metadata.set('password', PASS);

const stream = client.Subscribe(metadata);

// Test 1: Simplest possible subscribe — matches what gnmic sends
const request = {
  subscribe: {
    subscription: [
      {
        path: {
          elem: [
            { name: 'interfaces' },
            { name: 'interface', key: { name: 'Ethernet1' } },
            { name: 'state' },
            { name: 'oper-status' },
          ],
        },
        mode: 1, // ON_CHANGE as numeric
      },
    ],
    mode: 0,       // STREAM as numeric
    encoding: 4,   // JSON_IETF as numeric
  },
};

console.log('Sending subscribe request:', JSON.stringify(request, null, 2));
stream.write(request);

stream.on('data', (response) => {
  if (response.sync_response) {
    console.log('\n✅ SYNC RESPONSE received — subscribe works!');
    console.log('Waiting 3s for ON_CHANGE events...');
    setTimeout(() => {
      console.log('Done. Closing.');
      stream.cancel();
      process.exit(0);
    }, 3000);
    return;
  }

  if (response.update) {
    const n = response.update;
    console.log('\n📡 Update received:');
    for (const u of (n.update || [])) {
      const pathStr = (u.path?.elem || []).map(e => {
        let s = e.name;
        if (e.key) for (const [k,v] of Object.entries(e.key)) s += `[${k}=${v}]`;
        return s;
      }).join('/');
      
      let val = null;
      if (u.val?.json_ietf_val) val = Buffer.from(u.val.json_ietf_val).toString();
      else if (u.val?.json_val) val = Buffer.from(u.val.json_val).toString();
      else if (u.val?.string_val) val = u.val.string_val;
      
      console.log(`  Path: ${pathStr}`);
      console.log(`  Value: ${val}`);
    }
  }
});

stream.on('error', (err) => {
  console.error('\n❌ Stream error:', err.code, err.details || err.message);
  process.exit(1);
});

stream.on('end', () => {
  console.log('\nStream ended.');
  process.exit(0);
});

console.log(`\nConnecting to ${TARGET}...`);
