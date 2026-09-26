import { createStreamingCanonicalizer, resampleTo } from "../resample";

/** A tone with seeded noise, so every output sample depends on many taps. */
function signal(rate: number, seconds: number, seed: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  let state = seed;
  for (let index = 0; index < out.length; index++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    out[index] =
      0.4 * Math.sin((2 * Math.PI * 220 * index) / rate) + (state / 2_147_483_648 - 0.5) * 0.2;
  }
  return out;
}

function streamed(input: Float32Array, rate: number, chunkSizes: readonly number[]): Float32Array {
  const stream = createStreamingCanonicalizer(rate);
  const parts: Float32Array[] = [];
  let offset = 0;
  let turn = 0;
  while (offset < input.length) {
    const size = chunkSizes[turn % chunkSizes.length]!;
    parts.push(stream.push(input.subarray(offset, offset + size)));
    offset += size;
    turn++;
  }
  parts.push(stream.flush());
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const bytes = (samples: Float32Array): Buffer =>
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);

// The native recorder delivers 4,096-sample chunks. The irregular sizes cover
// chunks shorter than the filter, a single sample, and one larger than the
// compaction threshold.
const CHUNKINGS: readonly (readonly number[])[] = [
  [4_096],
  [1, 7, 4_096, 333],
  [127, 128, 129],
  [100_000, 3],
];

describe("streaming canonicaliser", () => {
  test.each([16_000, 44_100, 48_000])(
    "matches the batch resampler value for value at %i Hz",
    async (rate) => {
      const input = signal(rate, 6.3, rate);
      const batch = await resampleTo(input, rate, 16_000);
      for (const chunks of CHUNKINGS) {
        const stream = streamed(input, rate, chunks);
        expect(stream).toHaveLength(batch.length);
        expect(bytes(stream).equals(bytes(batch))).toBe(true);
      }
    },
    60_000,
  );

  test("emits nothing that changes later: every pushed sample is final", async () => {
    const input = signal(48_000, 1, 5);
    const batch = await resampleTo(input, 48_000, 16_000);
    const stream = createStreamingCanonicalizer(48_000);
    let emitted = 0;
    for (let offset = 0; offset < input.length; offset += 1_000) {
      const part = stream.push(input.subarray(offset, offset + 1_000));
      expect(bytes(part).equals(bytes(batch.subarray(emitted, emitted + part.length)))).toBe(true);
      emitted += part.length;
    }
    expect(emitted).toBeLessThan(batch.length);
    expect(emitted + stream.flush().length).toBe(batch.length);
  });

  test("refuses a rate below the canonical rate and input after the end", () => {
    expect(() => createStreamingCanonicalizer(8_000)).toThrow(RangeError);
    expect(() => createStreamingCanonicalizer(Number.NaN)).toThrow(RangeError);
    const stream = createStreamingCanonicalizer(16_000);
    stream.flush();
    expect(stream.flush()).toHaveLength(0);
    expect(() => stream.push(new Float32Array(1))).toThrow();
  });
});
