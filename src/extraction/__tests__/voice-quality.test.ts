// Cross-platform reproducibility gate for the voice-quality feature block.
//
// IF ONE OF THESE FAILS, DO NOT UPDATE THE EXPECTED VALUE.
//
// `src/extraction/voice-quality.ts` is a deliberate hand-port of
// `pulse-sdk/src/extraction/voice-quality.ts`. This repo does not depend on
// the SDK, so nothing mechanically keeps the two in step. The nine values
// below are byte-equal to the ones in `pulse-sdk/test/voice-quality-golden.
// test.ts`, which turns two independent suites into a parity gate: if either
// port drifts, exactly one file goes red and names the side that moved.
//
// These numbers land in the 170-feature audio block, which is z-scored into
// the fused vector, which becomes the SimHash, which becomes the on-chain
// commitment. If mobile and web compute different numbers, a wallet enrolled
// in one client cannot re-verify in the other.
//
// The cepstral path is the one to watch. Its band-limited DCT-II runs once per
// frame and evaluated Math.cos roughly 276 million times per capture, which
// invites rewrites. The two most natural ones both change the numbers:
// reassociating (piOverN * (n + 0.5)) * k, and swapping in an FFT-based DCT.
// Both would pass a tolerance test. Only exact vectors catch them.
//
// Values produced by pulse-sdk at commit `cf2bf5f`.

import { extractVoiceQualityFeatures, cppBasis } from "../voice-quality";

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 2048;
const HOP_SIZE = 160;
const SESSION_LENGTH = SAMPLE_RATE * 12;

function multiToneSamples(freqs: number[], amplitude = 0.3): Float32Array {
  const out = new Float32Array(SESSION_LENGTH);
  for (let i = 0; i < SESSION_LENGTH; i++) {
    let sum = 0;
    for (const f of freqs) {
      sum += Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
    }
    out[i] = (amplitude / freqs.length) * sum;
  }
  return out;
}

const EXPECTED = [
  310.5943437277091, 3.991878034646248e-11, -1.9382038914834339, 1.3247805904250496e-15,
  -10.018040663313284, 1.2445763520304567, 0.33333333332415477, 0.6666666666757534,
  9.273968098543825e-14,
];

describe("extractVoiceQualityFeatures parity with pulse-sdk", () => {
  it("holds the pinned feature values", async () => {
    const samples = multiToneSamples([500, 1500, 2500]);
    const numFrames = Math.floor((SESSION_LENGTH - FRAME_SIZE) / HOP_SIZE) + 1;
    const f0PerFrame = Array.from({ length: numFrames }, (_, i) => 110 + (i % 40));

    const features = await extractVoiceQualityFeatures(
      samples,
      SAMPLE_RATE,
      FRAME_SIZE,
      HOP_SIZE,
      f0PerFrame,
    );

    expect(features).toHaveLength(EXPECTED.length);
    for (let i = 0; i < EXPECTED.length; i++) {
      const want = EXPECTED[i]!;
      // Relative, not exact. The cepstral path runs through Math.log and
      // Math.cos, neither of which IEEE-754 requires to be correctly rounded,
      // so V8 differs by an ULP between architectures. Pinned exactly, these
      // passed on macOS arm64 and failed CI on Linux x64 by one digit. The
      // exact guard lives in the basis test below.
      // The absolute floor is 1e-18 because the near-zero entries are variances
      // of nearly-identical per-frame values. Catastrophic cancellation leaves
      // them with an absolute error far larger than their magnitude implies: an
      // ULP disagreement on inputs around 310 surfaces as roughly 1e-20 on an
      // output of 4e-11. A relative-only bound cannot express that.
      const tolerance = Math.max(Math.abs(want) * 1e-9, 1e-18);
      expect(Math.abs(features[i]! - want)).toBeLessThanOrEqual(tolerance);
    }
  }, 60_000);
});

describe("cepstral DCT basis matches the expression it replaced", () => {
  it("reproduces the inline computation exactly at 16 kHz", () => {
    // Portable and exact, because the reference is recomputed in-process
    // rather than hardcoded. Catches any reassociation of the grouping, which
    // no usable tolerance can separate from platform noise.
    const N = 1024;
    const qMin = 40;
    const bandLen = 227;
    const basis = cppBasis(N, qMin, bandLen);
    const piOverN = Math.PI / N;

    expect(basis).toHaveLength(bandLen * N);
    for (let bIdx = 0; bIdx < bandLen; bIdx++) {
      const k = qMin + bIdx;
      const row = bIdx * N;
      for (let n = 0; n < N; n++) {
        if (basis[row + n] !== Math.cos(piOverN * (n + 0.5) * k)) {
          throw new Error(`basis[${bIdx}][${n}] diverged from the inline form`);
        }
      }
    }
  });
});
