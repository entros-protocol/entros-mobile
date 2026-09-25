// Adapt native Groth16 output to the Solana proof format.
// The selected generation determines the artifact and public-input contract.
// Witness inputs cross the local FFI boundary as transient JSON.

import { CircomProof as MoproCircomProof, generateCircomProof, ProofLib } from "mopro-ffi";

import type { TBH } from "@/hashing";

import { getBoundZkeyPath, getZkeyPath } from "./assets";
import { prepareCircuitInput } from "./input";
import { serializeProof } from "./serializer";
import type { RawProof, SolanaProof } from "./types";
import {
  type PreparedNativeProofRequest,
  expectedNativePublicSignals,
  validatePreparedNativeProofRequest,
} from "./request";
import { DEFAULT_MIN_DISTANCE, DEFAULT_THRESHOLD } from "./constants";

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
export async function generateSolanaProof(
  current: TBH,
  previous: TBH,
  request?: PreparedNativeProofRequest,
): Promise<SolanaProof> {
  const prepared = request ? validatePreparedNativeProofRequest(request) : undefined;
  const input = prepareCircuitInput(
    current,
    previous,
    prepared?.action.threshold ?? DEFAULT_THRESHOLD,
    prepared?.action.minDistance ?? DEFAULT_MIN_DISTANCE,
    prepared,
  );
  const zkeyPath = prepared ? await getBoundZkeyPath(prepared.manifest) : await getZkeyPath();
  const result = generateCircomProof(zkeyPath, JSON.stringify(input), ProofLib.Arkworks);
  if (prepared) {
    const expected = expectedNativePublicSignals(prepared);
    if (
      expected.length !== result.inputs.length ||
      expected.some((value, index) => value !== result.inputs[index])
    ) {
      throw new Error("The native proof output does not match its prepared request.");
    }
  }
  const rawProof = moproToRawProof(result.proof);
  return {
    ...serializeProof(rawProof, result.inputs, prepared ? "request-bound-v1" : "legacy"),
    ...(prepared ? { preparedRequest: prepared } : {}),
  };
}
