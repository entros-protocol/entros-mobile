// Public API for the Stage-3 hashing layer. Re-exports only what callers
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
