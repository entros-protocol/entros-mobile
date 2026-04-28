// Protocol-level constants for the Stage-3 hashing layer.
//
// Kept in their own module (separate from `src/config/index.ts`) because
// the env-var validation in that module throws at import time when the
// .env block isn't populated — and the unit tests don't need the runtime
// config block to evaluate. These constants are pure values, no env reads.

// Frozen at the original v1 string for backward compatibility — every
// existing user's web baseline projects features into bit positions
// derived from this seed, so changing it would invalidate every prior
// fingerprint and force a global baseline reset. Kerckhoffs-compliant
// either way (the seed is public). Mobile and web MUST keep this
// byte-identical.
export const SIMHASH_SEED = "IAM-PROTOCOL-SIMHASH-V1";

export const FINGERPRINT_BITS = 256;

// BN254 scalar field prime — used to bound salt generation so the value
// fits inside the field a Poseidon hash operates on.
export const BN254_SCALAR_FIELD = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);
