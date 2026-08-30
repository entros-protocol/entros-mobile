// Bridges the TypeScript proof types
// (matching pulse-sdk's contract) and the mopro UniFFI-generated native
// module that runs the actual arkworks Groth16 prover on-device.
//
// The mopro native binding emits proofs in a Circom-flavoured G1/G2 shape
// (CircomProof with `{a, b, c}` projective points). Our serialiser
// (verbatim from pulse-sdk) expects the snarkjs RawProof shape
// (`{pi_a, pi_b, pi_c}`). The adapter `moproToRawProof` does the
// translation; after that, the on-chain serialisation is byte-identical
// to what the web SDK produces with snarkjs — same 256-byte
// groth16-solana format, same 4×32-byte big-endian public inputs.
//
// PRIVACY:
// - Witness inputs (ft_new[256], ft_prev[256], salt_new, salt_prev) are
//   passed as JSON across the FFI boundary into native memory. The
//   strings live in the JS heap until the call returns; the native side
//   parses and discards them after proof generation.
// - The proof outputs (G1 + G2 points + protocol/curve labels) are
//   public artefacts by definition — Groth16 zero-knowledge guarantees
//   they reveal nothing about the witnesses.
// - generateCircomProof is SYNCHRONOUS from JS perspective (UniFFI bridge
//   blocks). On a Pixel 8 this is ~100-300 ms with arkworks. The verify
//   processing screen already shows the "Generating ZK proof" copy for
//   this stage so the user perceives steady progress.

import { CircomProof as MoproCircomProof, generateCircomProof, ProofLib } from "mopro-ffi";

import type { TBH } from "@/hashing";

import { getZkeyPath } from "./assets";
import { prepareCircuitInput } from "./input";
import { serializeProof } from "./serializer";
import type { RawProof, SolanaProof } from "./types";

const moproToRawProof = (p: MoproCircomProof): RawProof => ({
  pi_a: [p.a.x, p.a.y, p.a.z],
  pi_b: [
    [p.b.x[0]!, p.b.x[1]!],
    [p.b.y[0]!, p.b.y[1]!],
    [p.b.z[0]!, p.b.z[1]!],
  ],
  pi_c: [p.c.x, p.c.y, p.c.z],
  protocol: p.protocol,
  curve: p.curve,
});

/** Generate a Groth16 proof for the entros_hamming circuit and serialise
 *  it for the on-chain `entros_verifier` program. Throws on prover or
 *  asset-resolution failure. */
export async function generateSolanaProof(current: TBH, previous: TBH): Promise<SolanaProof> {
  const input = prepareCircuitInput(current, previous);
  const zkeyPath = await getZkeyPath();
  const result = generateCircomProof(zkeyPath, JSON.stringify(input), ProofLib.Arkworks);
  const rawProof = moproToRawProof(result.proof);
  return serializeProof(rawProof, result.inputs);
}
