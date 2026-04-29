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

// Stage 7 ships the two IDLs the on-chain submission path consumes
// (entros_anchor for mint / update_anchor / reset, entros_verifier for
// create_challenge / verify_proof). Stage 8 added entros_registry for
// the on-chain ProtocolConfig PDA read so /verify/intro can render the
// live verification_fee instead of the hardcoded approximation.

import entrosAnchorIdl from "./entros_anchor.json";
import entrosRegistryIdl from "./entros_registry.json";
import entrosVerifierIdl from "./entros_verifier.json";

export { entrosAnchorIdl, entrosRegistryIdl, entrosVerifierIdl };
