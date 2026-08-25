import { canonicalizeTouchSamples, startTouchRecording } from "../touch";
import type { TouchSample } from "../types";
import { extractMouseDynamics, extractTouchFeatures } from "../../extraction/kinematic";

function periodicSamples(rateHz: number, durationMs: number): TouchSample[] {
  const count = Math.round((durationMs * rateHz) / 1_000);
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = (index * durationMs) / count;
    const progress = t / durationMs;
    return {
      t: 50_000 + t,
      x: 0.1 + progress * 0.7,
      y: 0.8 - progress * 0.4,
      pressure: 0.3 + progress * 0.2,
    };
  });
}

describe("projection 2 touch grid", () => {
  test("preserves projection 0 and 1 sample references", () => {
    const samples = periodicSamples(60, 4_000);
    expect(canonicalizeTouchSamples(samples, 0)).toBe(samples);
    expect(canonicalizeTouchSamples(samples, 1)).toBe(samples);
  });

  test.each([
    [4_000, 121],
    [12_000, 361],
    [60_000, 1_801],
  ])("maps %i ms onto %i endpoint-preserving points", (durationMs, count) => {
    const output = canonicalizeTouchSamples(periodicSamples(60, durationMs), 2);
    expect(output).toHaveLength(count);
    expect(output[0]!.t).toBe(50_000);
    expect(output.at(-1)!.t).toBe(50_000 + durationMs);
  });

  test("is invariant across supported source rates", () => {
    const reference = canonicalizeTouchSamples(periodicSamples(30, 4_000), 2);
    for (const rate of [60, 120, 240]) {
      const candidate = canonicalizeTouchSamples(periodicSamples(rate, 4_000), 2);
      expect(candidate).toHaveLength(reference.length);
      for (let index = 0; index < reference.length; index++) {
        expect(candidate[index]!.x).toBeCloseTo(reference[index]!.x, 12);
        expect(candidate[index]!.y).toBeCloseTo(reference[index]!.y, 12);
        expect(candidate[index]!.pressure).toBeCloseTo(reference[index]!.pressure, 12);
      }
    }
  });

  test("pins projection 2 touch and pointer-motion extraction", () => {
    const samples = canonicalizeTouchSamples(
      Array.from({ length: 61 }, (_, index) => ({
        t: index * 17,
        x: 0.5,
        y: 0.5,
        pressure: 0.5,
      })),
      2,
    ).map((sample) => ({
      timestamp: sample.t,
      x: sample.x,
      y: sample.y,
      pressure: sample.pressure,
      width: 1,
      height: 1,
    }));
    const expectedTouch = new Array<number>(57).fill(0);
    const expectedMotion = new Array<number>(81).fill(0);
    expectedTouch[16] = 0.5;
    expectedTouch[20] = 1;
    expectedTouch[40] = 1;
    expectedTouch[50] = 34;
    expectedMotion[15] = 1;
    expectedMotion[38] = 0.5;
    expectedMotion[72] = 4.136029411764706;

    expect(samples).toHaveLength(31);
    expect(samples.slice(0, 3).map((sample) => sample.timestamp)).toEqual([0, 34, 68]);
    expect(extractTouchFeatures(samples, 2)).toEqual(expectedTouch);
    expect(extractMouseDynamics(samples, 2)).toEqual(expectedMotion);
  });

  test("coalesces duplicates and rejects invalid or interrupted evidence", () => {
    const duplicate = periodicSamples(60, 4_000);
    duplicate.splice(2, 0, { ...duplicate[1]!, x: 0.75 });
    expect(canonicalizeTouchSamples(duplicate, 2)).toHaveLength(121);

    const interrupted = periodicSamples(60, 4_000);
    interrupted.splice(20, 20);
    expect(() => canonicalizeTouchSamples(interrupted, 2)).toThrow("clock was interrupted");

    const decreasing = periodicSamples(60, 4_000);
    decreasing[3] = { ...decreasing[3]!, t: decreasing[1]!.t };
    expect(() => canonicalizeTouchSamples(decreasing, 2)).toThrow("timestamps must be monotonic");

    const invalid = periodicSamples(60, 4_000);
    invalid[3] = { ...invalid[3]!, x: Number.NaN };
    expect(() => canonicalizeTouchSamples(invalid, 2)).toThrow("non-finite value");
  });

  test("bounds bridged samples while retaining projection 1 compatibility input", () => {
    jest.useFakeTimers();
    try {
      const recorder = startTouchRecording(undefined, 2);
      recorder.beginContact();
      for (let index = 0; index <= 12_000; index += 1) {
        recorder.push({ t: index, x: index / 12_000, y: 0.5, pressure: 1 });
        jest.advanceTimersByTime(1);
      }
      const capture = recorder.stop();
      expect(capture.samples).toHaveLength(361);
      expect(capture.compatibilitySamples!.length).toBeLessThanOrEqual(2_882);
      expect(capture.compatibilitySamples!.at(-1)!.t).toBe(12_000);
    } finally {
      jest.useRealTimers();
    }
  });

  test("rejects renewed contact", () => {
    const recorder = startTouchRecording(undefined, 2);
    recorder.beginContact();
    recorder.push({ t: 0, x: 0.5, y: 0.5, pressure: 1 });
    recorder.endContact();
    recorder.beginContact();
    expect(() => recorder.stop()).toThrow("one continuous contact");
  });

  test("cancels the fixed-rate sampler and rejects later stop", () => {
    jest.useFakeTimers();
    try {
      const recorder = startTouchRecording(undefined, 2);
      recorder.beginContact();
      recorder.push({ t: 0, x: 0.5, y: 0.5, pressure: 1 });
      recorder.cancel();
      expect(jest.getTimerCount()).toBe(0);
      expect(() => recorder.stop()).toThrow("already stopped");
    } finally {
      jest.useRealTimers();
    }
  });
});
