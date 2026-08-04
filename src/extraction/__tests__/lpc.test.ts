// Cross-platform reproducibility gate for the LPC / formant pipeline.
//
// IF ONE OF THESE FAILS, DO NOT UPDATE THE EXPECTED VALUE.
//
// `src/extraction/lpc.ts` is a deliberate hand-port of
// `pulse-sdk/src/extraction/lpc.ts`. This repo does not depend on the SDK, so
// nothing mechanically keeps the two in step. The vectors below are byte-equal
// to the ones in `pulse-sdk/test/lpc.test.ts`, which is what turns two
// independent test suites into a parity gate: if either port drifts, exactly
// one of the two files goes red and names the side that moved.
//
// Why that matters more here than a normal regression. These series feed
// `speaker.ts`, which fills part of the 170-feature audio block, which is
// z-scored into the fused vector, which becomes the SimHash, which becomes the
// on-chain commitment. If mobile and web compute different numbers, a wallet
// enrolled in one client cannot re-verify in the other. The user meets that as
// `drift-too-high` with a reset as the only exit, which is the failure mode
// master-list #215 exists to prevent.
//
// This mirrors the intent of `src/hashing/__tests__/parity.test.ts`, which
// covers the hashing layer. Until this file existed, extraction had no
// equivalent gate and `lpc.ts` had no test at all.
//
// Values produced by pulse-sdk at commit `cf2bf5f`.

import { extractLpcAnalysis } from "../lpc";

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 2048;
const HOP_SIZE = 160;
const SESSION_LENGTH = SAMPLE_RATE * 12;

function multiToneSamples(length: number, freqs: number[], amplitude = 0.3): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const f of freqs) {
      sum += Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
    }
    out[i] = (amplitude / freqs.length) * sum;
  }
  return out;
}

describe("extractLpcAnalysis parity with pulse-sdk", () => {
  const samples = multiToneSamples(SESSION_LENGTH, [500, 1500, 2500]);
  const analysis = extractLpcAnalysis(samples, SAMPLE_RATE, FRAME_SIZE, HOP_SIZE);
  const MID = 594;
  const LAST = 1187;

  it("analyses the pinned number of frames", () => {
    expect(analysis.numFramesAnalyzed).toBe(1188);
  });

  const series: { name: string; at: [number, number, number] }[] = [
    { name: "f1", at: [500.01530584871745, 500.01530584879595, 500.01530584881914] },
    { name: "f2", at: [1500.09986324919, 1500.099863249147, 1500.0998632491408] },
    { name: "f3", at: [2500.072179315838, 2500.072179315844, 2500.072179315838] },
    { name: "b1", at: [0.2545482005833285, 0.25454820057654265, 0.25454820057710814] },
    { name: "b2", at: [0.14803473758696717, 0.1480347375844226, 0.14803473758413987] },
    { name: "b3", at: [0.038246138653724664, 0.03824613865400738, 0.038246138653724664] },
    { name: "f1f2", at: [0.3333213461973745, 0.3333213461974364, 0.33332134619745324] },
    { name: "f2f3", at: [0.6000226216107499, 0.6000226216107312, 0.6000226216107302] },
  ];

  for (const { name, at } of series) {
    it(`holds the pinned ${name} series`, () => {
      const track = (analysis as unknown as Record<string, number[]>)[name]!;
      expect(track).toHaveLength(1188);
      expect(track[0]).toBe(at[0]);
      expect(track[MID]).toBe(at[1]);
      expect(track[LAST]).toBe(at[2]);
    });
  }

  it("holds the pinned LPC coefficient tracks", () => {
    const first = analysis.lpcCoefficients[0]!;
    const twelfth = analysis.lpcCoefficients[11]!;
    expect(first[0]).toBe(-2.211867471627163);
    expect(first[first.length - 1]).toBe(-2.211867471722756);
    expect(twelfth[0]).toBe(0.3522504587991376);
    expect(twelfth[twelfth.length - 1]).toBe(0.35225045877833444);
  });

  it("recovers the input tones, so the vectors pin a correct analysis", () => {
    // Guards against pinning a broken port. 500/1500/2500 Hz in, the same
    // frequencies out to within 0.15 Hz. Without this the vectors above would
    // happily freeze a formant tracker that had stopped tracking formants.
    expect(Math.abs(analysis.f1[0]! - 500)).toBeLessThan(0.15);
    expect(Math.abs(analysis.f2[0]! - 1500)).toBeLessThan(0.15);
    expect(Math.abs(analysis.f3[0]! - 2500)).toBeLessThan(0.15);
  });
});
