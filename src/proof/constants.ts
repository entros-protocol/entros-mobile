// The verifier program enforces these bounds. Mobile uses the same values as
// client defaults and verifies them against its bundled program IDL.

/** Default threshold. The verifier program enforces the maximum accepted value. */
export const DEFAULT_THRESHOLD = 96;

/** Default minimum distance. The verifier program enforces the minimum value. */
export const DEFAULT_MIN_DISTANCE = 3;

/** Number of public inputs to the Hamming circuit:
 *  [commitment_new, commitment_prev, threshold, min_distance]. */
export const NUM_PUBLIC_INPUTS = 4;

/** groth16-solana proof component sizes. Total proof = 256 bytes. */
export const PROOF_A_SIZE = 64;
export const PROOF_B_SIZE = 128;
export const PROOF_C_SIZE = 64;
export const TOTAL_PROOF_SIZE = PROOF_A_SIZE + PROOF_B_SIZE + PROOF_C_SIZE;

/** BN254 base field prime used to negate the G1 y-coordinate when
 *  converting snarkjs / arkworks proof_a to groth16-solana format. */
export const BN254_BASE_FIELD = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);
