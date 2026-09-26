import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { analysisSignal, decodePcm16, encodePcm16, roundWindow } from "../segment";
import { MAX_ROUND_SAMPLES } from "../transcript";

import { bytes, vectors } from "./vectors";

function float32LittleEndian(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 4);
  const view = new DataView(out.buffer);
  samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true));
  return out;
}

describe("round windows", () => {
  test.each(vectors.roundWindows.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      const window = roundWindow(
        vector.roundStart,
        vector.roundEnd,
        vector.voicedRuns.map(([start, end]) => [start, end] as const),
      );
      expect(window).toEqual({ start: vector.windowStart, end: vector.windowEnd });
      expect(window.end - window.start).toBeLessThanOrEqual(MAX_ROUND_SAMPLES);
    },
  );

  test("refuses a round that ends before it starts", () => {
    expect(() => roundWindow(10, 5, [])).toThrow(RangeError);
    expect(() => roundWindow(-1, 5, [])).toThrow(RangeError);
    expect(() => roundWindow(0.5, 5, [])).toThrow(RangeError);
  });
});

describe("PCM16", () => {
  test("encodes with the asymmetric scale and rounds ties toward positive infinity", () => {
    const encoded = encodePcm16(Float32Array.from(vectors.pcm16.samples));
    expect(bytesToHex(encoded)).toBe(vectors.pcm16.pcm16Hex);
  });

  test("decodes by dividing by 32768", () => {
    expect(Array.from(decodePcm16(bytes(vectors.pcm16.pcm16Hex)))).toEqual(vectors.pcm16.decoded);
  });

  test("decodes a view that starts inside a larger buffer", () => {
    const backing = new Uint8Array(6);
    backing.set([0x00, 0x40, 0x00, 0xc0], 2);
    expect(Array.from(decodePcm16(backing.subarray(2)))).toEqual([0.5, -0.5]);
  });

  test("refuses an odd byte length", () => {
    expect(() => decodePcm16(new Uint8Array(3))).toThrow(RangeError);
    expect(() => analysisSignal([new Uint8Array(2), new Uint8Array(1)])).toThrow(RangeError);
  });
});

describe("analysis signal", () => {
  test.each(vectors.analysisSignal.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      const segments = vector.segmentsPcm16Hex.map(bytes);
      const { signal } = analysisSignal(segments);
      expect(signal).toBeInstanceOf(Float32Array);
      expect(signal).toHaveLength(vector.sampleCount);
      expect(bytesToHex(sha256(float32LittleEndian(signal)))).toBe(vector.signalF32LeSha256Hex);

      let sumSquares = 0;
      for (const segment of segments) {
        for (const sample of decodePcm16(segment)) sumSquares += sample * sample;
      }
      expect(Math.sqrt(sumSquares / vector.sampleCount)).toBe(vector.rms);
    },
  );

  test("levels the joined signal once, not each segment", () => {
    const quiet = encodePcm16(new Float32Array(400).fill(0.01));
    const loud = encodePcm16(new Float32Array(400).fill(0.1));
    const { signal } = analysisSignal([quiet, loud]);
    expect(signal[399]! / signal[400]!).toBeCloseTo(0.1, 3);
  });

  test("returns the decoded join before levelling beside the signal", () => {
    const first = encodePcm16(Float32Array.from([0.25, -0.5]));
    const second = encodePcm16(Float32Array.from([0.125]));
    const { joined } = analysisSignal([first, second]);
    expect(Array.from(joined)).toEqual([
      ...Array.from(decodePcm16(first)),
      ...Array.from(decodePcm16(second)),
    ]);
  });
});
