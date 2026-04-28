// In-memory handoff slot for the post-Groth16 SolanaProof that flows from
// /verify/processing (Stage 6, where it's generated) to Stage 7's on-chain
// `verify_proof + update_anchor` batch.
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
//   submission's — by definition the bytes are public.
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
