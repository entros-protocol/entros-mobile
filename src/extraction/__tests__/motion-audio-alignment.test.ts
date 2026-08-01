import { extractAccelerationMagnitude } from "../kinematic";
import type { MotionSample } from "../types";

/**
 * Aligning the motion contour to the audio window.
 *
 * `accel_magnitude` is correlated against the F0 contour server-side, so the
 * two have to describe the same stretch of wall-clock time. This used to be
 * built by mapping motion's array index proportionally onto audio's frame
 * count, which holds only while both streams happen to cover the same window.
 *
 * On web that assumption broke on 2026-07-31: `pulse-sdk@4.0.0` trimmed the
 * pre-prompt lead-in out of the audio and left motion carrying it, coupling
 * fell from r=0.31 to r=0.03, and every mobile browser verification was
 * rejected for ten hours. Mobile never shipped that trim, so this file was
 * correct by luck rather than by construction, and both sensors stamped
 * `Date.now()` from their own start so neither could be placed against the
 * other. They now share an epoch and the contour is resampled onto the audio's
 * own window.
 *
 * Mirrors `pulse-sdk/test/motion-audio-alignment.test.ts`. The two are
 * hand-kept copies until mobile consumes the published SDK (master-list #219).
 */

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const mean = (v: number[]) => v.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** A waveform that is a function of absolute time, so misalignment shows up. */
function motionOver(startMs: number, endMs: number, rateHz = 60): MotionSample[] {
  const step = 1000 / rateHz;
  const out: MotionSample[] = [];
  for (let t = startMs; t <= endMs; t += step) {
    const v = Math.sin(t / 220) + 0.5 * Math.cos(t / 90);
    out.push({ timestamp: t, ax: v, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 });
  }
  return out;
}

function expectedContour(startMs: number, endMs: number, frames: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = startMs + (i / (frames - 1)) * (endMs - startMs);
    out.push(Math.abs(Math.sin(t / 220) + 0.5 * Math.cos(t / 90)));
  }
  return out;
}

/** The pre-fix implementation, kept verbatim so the regression stays pinned. */
function indexAligned(samples: MotionSample[], targetFrameCount: number): number[] {
  if (samples.length < 2 || targetFrameCount < 2) return [];
  const magnitudes = samples.map((s) => Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az));
  if (magnitudes.length === targetFrameCount) return magnitudes;
  const out = new Array<number>(targetFrameCount);
  const scale = (magnitudes.length - 1) / (targetFrameCount - 1);
  for (let i = 0; i < targetFrameCount; i++) {
    const pos = i * scale;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, magnitudes.length - 1);
    const frac = pos - lo;
    out[i] = magnitudes[lo]! * (1 - frac) + magnitudes[hi]! * frac;
  }
  return out;
}

const FRAMES = 1217;

describe("motion aligned to the audio window", () => {
  it("recovers the signal when motion outruns audio, where index mapping cannot", () => {
    const audioStart = 4_000;
    const audioEnd = 16_170;
    const motion = motionOver(0, audioEnd);
    const truth = expectedContour(audioStart, audioEnd, FRAMES);

    const aligned = extractAccelerationMagnitude(motion, FRAMES, {
      startMs: audioStart,
      endMs: audioEnd,
    });
    expect(aligned).toHaveLength(FRAMES);
    expect(correlation(aligned, truth)).toBeGreaterThan(0.9);

    // The same input through the old path, so this test proves something.
    expect(correlation(indexAligned(motion, FRAMES), truth)).toBeLessThan(0.2);
  });

  it("handles the offset mobile actually has, motion starting before audio", () => {
    // `capture.tsx` starts motion one `await` before audio, so motion leads by
    // however long the native recorder takes to come up. Small, and real.
    const audioStart = 400;
    const audioEnd = 12_570;
    const aligned = extractAccelerationMagnitude(motionOver(0, audioEnd + 200), FRAMES, {
      startMs: audioStart,
      endMs: audioEnd,
    });
    expect(correlation(aligned, expectedContour(audioStart, audioEnd, FRAMES))).toBeGreaterThan(
      0.9,
    );
  });

  it("places every frame correctly despite a gap in sensor delivery", () => {
    const start = 2_000;
    const end = 14_170;
    const stalled = motionOver(start, end).filter(
      (s) => s.timestamp < 6_000 || s.timestamp > 9_000,
    );
    const aligned = extractAccelerationMagnitude(stalled, FRAMES, {
      startMs: start,
      endMs: end,
    });
    expect(aligned).toHaveLength(FRAMES);
    expect(correlation(aligned, expectedContour(start, end, FRAMES))).toBeGreaterThan(0.75);
  });

  it("refuses rather than guessing when motion cannot cover the window", () => {
    const win = { startMs: 0, endMs: 12_170 };
    expect(extractAccelerationMagnitude(motionOver(0, 6_000), FRAMES, win)).toEqual([]);
    expect(extractAccelerationMagnitude(motionOver(20_000, 32_000), FRAMES, win)).toEqual([]);
    expect(
      extractAccelerationMagnitude(motionOver(0, 12_170), FRAMES, { startMs: 12_170, endMs: 0 }),
    ).toEqual([]);
    expect(extractAccelerationMagnitude([], FRAMES, win)).toEqual([]);
  });
});
