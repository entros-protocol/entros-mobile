import { sha256 } from "@noble/hashes/sha2.js";

import { CANONICAL_SAMPLE_RATE, toCanonicalCapture } from "../resample";

const EXPECTED_PCM_SHA256: Record<number, string> = {
  16_000: "eefb4766bb16e70273c4dccd6c6c9440f631c1258b80d5f7160a99c124930bed",
  44_100: "3c4edfa444957e6a0f5d61a67d3aac1790daee164c3d18bbf3e823d048800eea",
  48_000: "28830d697468dc0f6853d25fbf892d0eb0eed199d9f75892515d5b0e172babac",
};

const fixture = (sampleRate: number, seconds: number): Float32Array =>
  Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, index) => {
    const time = index / sampleRate;
    return Math.sin(2 * Math.PI * 997 * time) + 0.125 * Math.sin(2 * Math.PI * 7_900 * time);
  });

const digestFloat32 = (values: Float32Array): string => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) {
    view.setFloat32(index * 4, values[index]!, true);
  }
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("canonical audio contract", () => {
  test.each([16_000, 44_100, 48_000])(
    "matches the Pulse PCM golden at %i Hz",
    async (sampleRate) => {
      const canonical = await toCanonicalCapture(fixture(sampleRate, 0.125), sampleRate);

      expect(canonical.sampleRate).toBe(CANONICAL_SAMPLE_RATE);
      expect(canonical.samples).toHaveLength(2_000);
      expect(digestFloat32(canonical.samples)).toBe(EXPECTED_PCM_SHA256[sampleRate]);
    },
  );

  test("reduces a 48 kHz capture to the canonical sample count", async () => {
    const canonical = await toCanonicalCapture(fixture(48_000, 1), 48_000);

    expect(canonical.sampleRate).toBe(CANONICAL_SAMPLE_RATE);
    expect(canonical.samples).toHaveLength(16_000);
  });

  test("does not relabel an unsupported lower-rate buffer", async () => {
    const input = fixture(8_000, 0.25);
    const output = await toCanonicalCapture(input, 8_000);

    expect(output.samples).toBe(input);
    expect(output.sampleRate).toBe(8_000);
  });
});
