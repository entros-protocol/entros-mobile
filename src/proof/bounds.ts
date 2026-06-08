// Classify a Hamming distance against the entros_hamming circuit's accept
// band, mirroring entros_hamming.circom:54-66 exactly:
//   - LessThan      enforces  distance <  threshold    (maximum allowed drift)
//   - GreaterEqThan enforces  distance >= minDistance  (replay floor)
// so the accept band is [minDistance, threshold).
//
// Verbatim contract-match with pulse-sdk's `classifyHammingDistance` so web and
// mobile reject identically. Computing this before the native (arkworks) prover
// runs lets the verify flow surface a clean retry instead of the raw circom
// assert that an unsatisfiable witness throws. Parameters are required (no
// defaults) so a caller cannot classify against different bounds than the proof
// enforces — pass the same threshold/minDistance fed to `prepareCircuitInput`.

export type HammingVerdict = "in_bounds" | "drift_too_high" | "below_min_distance";

export function classifyHammingDistance(
  distance: number,
  threshold: number,
  minDistance: number,
): HammingVerdict {
  if (distance >= threshold) return "drift_too_high";
  if (distance < minDistance) return "below_min_distance";
  return "in_bounds";
}
