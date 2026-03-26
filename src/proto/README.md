# FRR Northbound Proto Files

The ATLAS BGP gRPC client requires FRR's northbound proto definition.

## Setup

Copy the proto file from your FRR installation:

```bash
# From the FRR source tree
cp /path/to/frr/grpc/frr-northbound.proto src/proto/

# Or from a running FRR installation (common locations)
cp /usr/share/frr/grpc/frr-northbound.proto src/proto/
```

## Required File

- `frr-northbound.proto` — FRR northbound gRPC service definition

## Notes

- The proto file version should match your FRR installation version.
- ATLAS uses the `Get` and `Subscribe` RPCs from the `Northbound` service.
- The proto file is NOT included in this repo to avoid version mismatches.
