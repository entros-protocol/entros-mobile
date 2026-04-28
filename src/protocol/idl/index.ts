// Bundled Anchor IDLs for the three on-chain programs. Copied verbatim
// from protocol-core/target/idl/*.json so the on-chain instruction shape
// is locked at the entros-mobile compile-time boundary (no runtime IDL
// fetch, no RPC dependency for instruction encoding).
//
// IDL bundling is the right call for mobile because:
//   - Anchor 0.32 IDLs embed the `address` field, so consumers don't need
//     a separate program-ID arg to `new anchor.Program(idl, provider)`.
//   - Each IDL is ~10–25 KB, ~55 KB total — negligible bundle impact.
//   - Avoids a per-verify-cycle `Program.fetchIdl()` RPC round-trip.
//   - Deterministic across deployments (no IDL upgrade race).
//
// When the on-chain programs change, re-copy the JSON files from
// protocol-core/target/idl/ and bump the entros-mobile minor version.

// Stage 7 re-exports only the two IDLs the on-chain submission path
// actually consumes. The entros_registry IDL JSON is bundled in this
// directory but not exported — Stage 8's dashboard read will pick it up
// when it adds the BorshAccountsCoder for the IdentityState + ProtocolConfig
// PDAs. Re-export it here as part of that change.

import entrosAnchorIdl from "./entros_anchor.json";
import entrosVerifierIdl from "./entros_verifier.json";

export { entrosAnchorIdl, entrosVerifierIdl };
