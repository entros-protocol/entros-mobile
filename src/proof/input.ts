// Construct the circuit witness from the current and previous TBH values.

import type { TBH } from "@/hashing/types";

import { DEFAULT_MIN_DISTANCE, DEFAULT_THRESHOLD } from "./constants";
import type { CircuitInput } from "./types";
import { type PreparedNativeProofRequest, validatePreparedNativeProofRequest } from "./request";

/** Prepare circuit input from current verification + previously-stored
 *  baseline. Field names match the entros_hamming.circom signal names. */
export function prepareCircuitInput(
  current: TBH,
  previous: TBH,
  threshold: number = DEFAULT_THRESHOLD,
  minDistance: number = DEFAULT_MIN_DISTANCE,
  request?: PreparedNativeProofRequest,
): CircuitInput {
  if (request) {
    const checked = validatePreparedNativeProofRequest(request);
    if (
      BigInt(`0x${checked.action.commitmentNew}`) !== current.commitment ||
      BigInt(`0x${checked.action.commitmentPrevious}`) !== previous.commitment ||
      checked.action.threshold !== threshold ||
      checked.action.minDistance !== minDistance
    )
      throw new Error("Witness commitments do not match the prepared request.");
  }
  return {
    ft_new: current.fingerprint,
    ft_prev: previous.fingerprint,
    salt_new: current.salt.toString(),
    salt_prev: previous.salt.toString(),
    commitment_new: current.commitment.toString(),
    commitment_prev: previous.commitment.toString(),
    threshold: threshold.toString(),
    min_distance: minDistance.toString(),
    ...(request
      ? { request_digest_hi: request.digestHi, request_digest_lo: request.digestLo }
      : {}),
  };
}
