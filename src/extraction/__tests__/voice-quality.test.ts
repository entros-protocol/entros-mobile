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

import { extractVoiceQualityFeatures } from "../voice-quality";

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
      expect(features[i]).toBe(EXPECTED[i]);
    }
  }, 60_000);
});
