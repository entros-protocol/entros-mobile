// Protocol-level constants for the Stage-3 hashing layer.
//
// Kept in their own module (separate from `src/config/index.ts`) because
// the env-var validation in that module throws at import time when the
// .env block isn't populated — and the unit tests don't need the runtime
// config block to evaluate. These constants are pure values, no env reads.

export const SIMHASH_PUBLIC_SEED_HEX =
  "9ee9c02f3fc6a2abce703010e64378d4531f8bcb110f0bc4c177c36a60c75bb5";

export const LEGACY_SIMHASH_SEED = "IAM-PROTOCOL-SIMHASH-V1";

export { HIGHEST_SUPPORTED_PROJECTION_VERSION as CLIENT_PROJECTION_VERSION } from "../projection";

export const FINGERPRINT_BITS = 256;

// BN254 scalar field prime — used to bound salt generation so the value
// fits inside the field a Poseidon hash operates on.
export const BN254_SCALAR_FIELD = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);
