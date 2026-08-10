import { extractMotionFeatures, extractTouchFeatures } from "../kinematic";
import type { MotionSample, TouchSample } from "../types";

describe("measured sample intervals", () => {
  const motionAtRate = (rate: number): MotionSample[] =>
    Array.from({ length: rate + 1 }, (_, index) => {
      const seconds = index / rate;
      return {
        timestamp: seconds * 1000,
        ax: 0.5 * seconds * seconds,
        ay: 0,
        az: 0,
        gx: 0,
        gy: 0,
        gz: 0,
      };
    });

  const touchAtRate = (rate: number): TouchSample[] =>
    Array.from({ length: rate + 1 }, (_, index) => {
      const seconds = index / rate;
      return {
        timestamp: seconds * 1000,
        x: seconds,
        y: 2 * seconds,
        pressure: 0.2 + 0.1 * seconds,
        width: 10,
        height: 10,
      };
    });

  test("keeps jerk and jounce in physical units across IMU rates", () => {
    const low = extractMotionFeatures(motionAtRate(50), 1);
    const high = extractMotionFeatures(motionAtRate(100), 1);
    expect(low[0]).toBeCloseTo(high[0]!, 10);
    expect(low[4]).toBeCloseTo(1, 10);
    expect(high[4]).toBeCloseTo(1, 10);
  });

  test("keeps pointer and pressure rates stable across event rates", () => {
    const low = extractTouchFeatures(touchAtRate(50), 1);
    const high = extractTouchFeatures(touchAtRate(100), 1);
    expect(low[0]).toBeCloseTo(1, 10);
    expect(high[0]).toBeCloseTo(1, 10);
    expect(low[8]).toBeCloseTo(2, 10);
    expect(high[8]).toBeCloseTo(2, 10);
    expect(low[36]).toBeCloseTo(0.1, 10);
    expect(high[36]).toBeCloseTo(0.1, 10);
  });
});
