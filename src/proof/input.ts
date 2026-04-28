// Build the witness input for the entros_hamming circuit from two TBH
// objects (current verification + previous baseline). Extracted into its
// own module so it stays platform-agnostic and reusable across the prover
// (mopro on mobile, snarkjs on web). Verbatim logic from
// pulse-sdk/src/proof/prover.ts:19-35.

import type { TBH } from "@/hashing/types";

import { DEFAULT_MIN_DISTANCE, DEFAULT_THRESHOLD } from "./constants";
import type { CircuitInput } from "./types";

/** Prepare circuit input from current verification + previously-stored
 *  baseline. Field names match the entros_hamming.circom signal names. */
export function prepareCircuitInput(
  current: TBH,
  previous: TBH,
  threshold: number = DEFAULT_THRESHOLD,
  minDistance: number = DEFAULT_MIN_DISTANCE,
): CircuitInput {
  return {
    ft_new: current.fingerprint,
    ft_prev: previous.fingerprint,
    salt_new: current.salt.toString(),
    salt_prev: previous.salt.toString(),
    commitment_new: current.commitment.toString(),
    commitment_prev: previous.commitment.toString(),
    threshold: threshold.toString(),
    min_distance: minDistance.toString(),
  };
}
