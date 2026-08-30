// In-memory handoff slot for the Groth16 proof passed from processing to the
// on-chain `verify_proof + update_anchor` transaction.
//
// Mirrors captureBuffer / commitmentBuffer / challengeBuffer semantics:
// module-level, never persisted, never serialised. take-and-clear so the
// proof is consumed once by the on-chain submit and the slot is empty for
// the next verify cycle.
//
// PRIVACY:
// - The 256-byte proof bytes and the 4×32-byte public inputs are
//   zero-knowledge artefacts; they reveal nothing about either fingerprint
//   value. The proof's privacy guarantee is the SAME as the on-chain
//   submission's. The proof bytes are public by definition.
// - The slot is cleared on processing-screen unmount as defence in depth.

import type { SolanaProof } from "@/proof";

let pending: SolanaProof | null = null;

export const setProof = (proof: SolanaProof): void => {
  pending = proof;
};

export const peekProof = (): SolanaProof | null => pending;

export const takeProof = (): SolanaProof | null => {
  const proof = pending;
  pending = null;
  return proof;
};

export const clearProof = (): void => {
  pending = null;
};
