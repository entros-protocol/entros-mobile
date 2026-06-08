// Unit tests for classifyHammingDistance. Mirrors the accept band enforced by
// entros_hamming.circom (LessThan: d<threshold; GreaterEqThan: d>=minDistance)
// and the pulse-sdk web helper, so web and mobile reject identically. Runs in
// pure Node — no React Native runtime.

import { classifyHammingDistance } from "../bounds";
import { DEFAULT_MIN_DISTANCE, DEFAULT_THRESHOLD } from "../constants";

describe("classifyHammingDistance: accept band [minDistance, threshold)", () => {
  const T = 96; // δ_max
  const M = 3; // δ_min

  it("in_bounds just below the threshold", () => {
    expect(classifyHammingDistance(95, T, M)).toBe("in_bounds");
  });
  it("drift_too_high at the threshold (LessThan is strict)", () => {
    expect(classifyHammingDistance(96, T, M)).toBe("drift_too_high");
  });
  it("drift_too_high above the threshold (the dist=111 incident)", () => {
    expect(classifyHammingDistance(111, T, M)).toBe("drift_too_high");
  });
  it("in_bounds at exactly minDistance (GreaterEqThan is inclusive)", () => {
    expect(classifyHammingDistance(3, T, M)).toBe("in_bounds");
  });
  it("below_min_distance just under minDistance", () => {
    expect(classifyHammingDistance(2, T, M)).toBe("below_min_distance");
  });
  it("below_min_distance for an exact replay (distance 0)", () => {
    expect(classifyHammingDistance(0, T, M)).toBe("below_min_distance");
  });
  it("agrees with the shipped circuit constants at the boundaries", () => {
    expect(
      classifyHammingDistance(DEFAULT_MIN_DISTANCE, DEFAULT_THRESHOLD, DEFAULT_MIN_DISTANCE),
    ).toBe("in_bounds");
    expect(
      classifyHammingDistance(DEFAULT_THRESHOLD, DEFAULT_THRESHOLD, DEFAULT_MIN_DISTANCE),
    ).toBe("drift_too_high");
    expect(
      classifyHammingDistance(DEFAULT_MIN_DISTANCE - 1, DEFAULT_THRESHOLD, DEFAULT_MIN_DISTANCE),
    ).toBe("below_min_distance");
  });
});
