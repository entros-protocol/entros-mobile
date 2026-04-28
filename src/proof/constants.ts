// Stage 6 Groth16 proof constants. Values verbatim from
// pulse-sdk/src/config.ts so the on-chain serialised format matches
// byte-for-byte (the on-chain verifier program is shared between web and
// mobile flows).
//
// The two-of-three thresholds (DEFAULT_THRESHOLD + DEFAULT_MIN_DISTANCE) are
// the protocol-frozen values for the Hamming-distance circuit; changing
// either invalidates every existing on-chain anchor, so they are NOT
// configurable per-deployment.

/** Maximum Hamming distance between consecutive verifications. Bits that
 *  drift further than this trigger a soft-reject (paper §3 + §6.1). */
export const DEFAULT_THRESHOLD = 96;

/** Minimum Hamming distance between consecutive verifications. Bits that
 *  drift LESS than this signal a synthetic-replay attack (paper §3 + §6.10
 *  + master-list #95). */
export const DEFAULT_MIN_DISTANCE = 3;

/** Number of public inputs to the Hamming circuit:
 *  [commitment_new, commitment_prev, threshold, min_distance]. */
export const NUM_PUBLIC_INPUTS = 4;

/** groth16-solana proof component sizes. Total proof = 256 bytes. */
export const PROOF_A_SIZE = 64;
export const PROOF_B_SIZE = 128;
export const PROOF_C_SIZE = 64;
export const TOTAL_PROOF_SIZE = PROOF_A_SIZE + PROOF_B_SIZE + PROOF_C_SIZE;

/** BN254 base field prime — used to negate the G1 y-coordinate when
 *  converting snarkjs / arkworks proof_a to groth16-solana format. */
export const BN254_BASE_FIELD = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);
