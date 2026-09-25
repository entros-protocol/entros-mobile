// Public API for hashing. Re-exports only what callers
// outside `src/hashing/` should use; internal helpers stay module-local.

export { simhash, hammingDistance } from "./simhash";
export {
  packBits,
  computeCommitment,
  generateSalt,
  bigintToBytes32,
  generateTBH,
} from "./poseidon";
export type { TemporalFingerprint, TBH, PackedFingerprint } from "./types";
