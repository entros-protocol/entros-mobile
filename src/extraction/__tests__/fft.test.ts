// Numerical correctness tests for the radix-2 Cooley-Tukey FFT.
//
// The mobile FFT is a hand-port of the pulse-sdk implementation, and a
// port of a butterfly loop is exactly the kind of code that stays
// plausible-looking while producing wrong numbers: it never throws, it
// returns arrays of the right length, and the error only shows up as
// shifted band energies and mislocated tremor peaks several layers
// downstream in kinematic.ts. A smoke test would not catch that.
//
// So the primary check here is a cross-check against a naive O(n²) DFT
// computed inline from the definition X[k] = Σ x[n]·e^(-2πikn/N). The
// naive transform shares no code with realFFT, it is the textbook sum,
// so agreement between the two pins every butterfly stage, not just the
// spectrum's shape. Inputs are a fixed LCG sequence and hardcoded arrays,
// never Math.random(), so a failure is reproducible.
//
// Runs in pure Node, no React Native runtime, no sensor access.

import { bandEnergy, nextPow2, peakInBand, realFFT } from "../fft";

/** Deterministic LCG (Numerical Recipes constants) mapped to [-1, 1). Used
 *  instead of Math.random() so a failing assertion reproduces exactly. */
function lcgSignal(length: number, seed: number): number[] {
  let state = seed >>> 0;
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state / 0x100000000) * 2 - 1;
  }
  return out;
}

/** Textbook O(n²) DFT of a real-valued input: X[k] = Σ x[n]·e^(-2πikn/N).
 *  Shares no code path with realFFT, this is the independent oracle. */
function naiveDFT(input: number[], size: number): { real: number[]; imag: number[] } {
  const real = new Array<number>(size).fill(0);
  const imag = new Array<number>(size).fill(0);
  for (let k = 0; k < size; k++) {
    let sumRe = 0;
    let sumIm = 0;
    for (let n = 0; n < size; n++) {
      const x = n < input.length ? (input[n] ?? 0) : 0;
      const angle = (-2 * Math.PI * k * n) / size;
      sumRe += x * Math.cos(angle);
      sumIm += x * Math.sin(angle);
    }
    real[k] = sumRe;
    imag[k] = sumIm;
  }
  return { real, imag };
}

function sineSignal(length: number, freqHz: number, sampleRate: number, amplitude = 1): number[] {
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

describe("realFFT agrees with a naive O(n²) DFT", () => {
  // Tolerance is absolute, not relative: bin magnitudes here are O(N·A), so
  // 1e-9 is far tighter than any real butterfly error while staying clear of
  // float64 accumulation noise over N=256 terms.
  const TOLERANCE = 1e-9;

  test.each([16, 64, 256])("matches on a seeded pseudo-random signal of size %i", (size) => {
    const input = lcgSignal(size, 0x5eed1234);
    const fast = realFFT(input, size);
    const slow = naiveDFT(input, size);

    for (let k = 0; k < size; k++) {
      expect(Math.abs(fast.real[k]! - slow.real[k]!)).toBeLessThan(TOLERANCE);
      expect(Math.abs(fast.imag[k]! - slow.imag[k]!)).toBeLessThan(TOLERANCE);
    }
  });

  test("matches on a hardcoded 8-point input", () => {
    // Deliberately asymmetric and non-zero-mean so no accidental symmetry
    // masks a sign error in the lower-half butterfly output.
    const input = [1, -2, 3.5, 0.25, -4, 7, -0.5, 2];
    const fast = realFFT(input, 8);
    const slow = naiveDFT(input, 8);

    for (let k = 0; k < 8; k++) {
      expect(fast.real[k]!).toBeCloseTo(slow.real[k]!, 9);
      expect(fast.imag[k]!).toBeCloseTo(slow.imag[k]!, 9);
    }
  });

  test("matches on a multi-tone signal spanning several bins", () => {
    const size = 128;
    const input = new Array<number>(size);
    for (let i = 0; i < size; i++) {
      input[i] =
        Math.sin((2 * Math.PI * 3 * i) / size) +
        0.5 * Math.cos((2 * Math.PI * 11 * i) / size) +
        0.25 * Math.sin((2 * Math.PI * 29 * i) / size + 0.7);
    }
    const fast = realFFT(input, size);
    const slow = naiveDFT(input, size);

    for (let k = 0; k < size; k++) {
      expect(Math.abs(fast.real[k]! - slow.real[k]!)).toBeLessThan(TOLERANCE);
      expect(Math.abs(fast.imag[k]! - slow.imag[k]!)).toBeLessThan(TOLERANCE);
    }
  });
});

describe("realFFT known-answer properties", () => {
  test("a real input produces a Hermitian-symmetric spectrum", () => {
    // For real x, X[N-k] = conj(X[k]). This holds for every correct FFT
    // regardless of input, so it catches a corrupted butterfly stage even
    // where the magnitude spectrum still looks plausible.
    const size = 64;
    const input = lcgSignal(size, 0xabcdef01);
    const { real, imag } = realFFT(input, size);

    for (let k = 1; k < size / 2; k++) {
      expect(real[size - k]!).toBeCloseTo(real[k]!, 9);
      expect(imag[size - k]!).toBeCloseTo(-imag[k]!, 9);
    }
    // DC and Nyquist bins are their own conjugates, so both are purely real.
    expect(Math.abs(imag[0]!)).toBeLessThan(1e-9);
    expect(Math.abs(imag[size / 2]!)).toBeLessThan(1e-9);
  });

  test("a bin-aligned sinusoid peaks at its own bin with magnitude N·A/2", () => {
    // 8 Hz sampled at 64 Hz over 256 samples lands exactly on bin
    // 8 × 256 / 64 = 32, so there is no spectral leakage to allow for and
    // the expected magnitude is the exact analytic value N·A/2.
    const sampleRate = 64;
    const size = 256;
    const freq = 8;
    const amplitude = 0.75;
    const expectedBin = (freq * size) / sampleRate;
    const expectedMagnitude = (size * amplitude) / 2;

    const { real, imag } = realFFT(sineSignal(size, freq, sampleRate, amplitude), size);
    const magnitude = (k: number) => Math.hypot(real[k]!, imag[k]!);

    expect(magnitude(expectedBin)).toBeCloseTo(expectedMagnitude, 6);

    // Every other bin below Nyquist must be empty to float precision.
    for (let k = 0; k <= size / 2; k++) {
      if (k === expectedBin) continue;
      expect(magnitude(k)).toBeLessThan(1e-9);
    }
  });

  test("a real bin-aligned sine is purely imaginary at its peak bin", () => {
    // sin has odd symmetry, so X[k0] = -i·N·A/2: the real part must vanish.
    // The buggy port writes a real accumulator into an imaginary output
    // register, which breaks this separation.
    const sampleRate = 64;
    const size = 256;
    const bin = 32;
    const { real, imag } = realFFT(sineSignal(size, 8, sampleRate, 1), size);

    expect(Math.abs(real[bin]!)).toBeLessThan(1e-9);
    expect(imag[bin]!).toBeCloseTo(-size / 2, 6);
  });

  test("Parseval's theorem holds: Σ|X[k]|² = N·Σ|x[n]|²", () => {
    const size = 128;
    const input = lcgSignal(size, 0x13572468);
    const { real, imag } = realFFT(input, size);

    let timeEnergy = 0;
    for (let n = 0; n < size; n++) timeEnergy += input[n]! * input[n]!;

    let freqEnergy = 0;
    for (let k = 0; k < size; k++) freqEnergy += real[k]! * real[k]! + imag[k]! * imag[k]!;

    expect(freqEnergy / size).toBeCloseTo(timeEnergy, 6);
  });
});

describe("downstream helpers read the corrected spectrum", () => {
  // These two are what kinematic.ts actually calls. A wrong butterfly
  // surfaces here as a mislocated tremor peak and misattributed band energy.
  const sampleRate = 64;
  const size = 256;

  test("peakInBand locates the dominant in-band tone, not an aliased one", () => {
    const input = new Array<number>(size);
    for (let i = 0; i < size; i++) {
      input[i] =
        Math.sin((2 * Math.PI * 5 * i) / sampleRate) +
        0.5 * Math.sin((2 * Math.PI * 20 * i) / sampleRate);
    }
    const { real, imag } = realFFT(input, size);
    const { freq, amplitude } = peakInBand(real, imag, sampleRate, 4, 12, input.length);

    expect(freq).toBeCloseTo(5, 6);
    // Amplitude is |X|²/N². For a unit-amplitude sine that is (N/2)²/N² = 0.25.
    expect(amplitude).toBeCloseTo(0.25, 6);
  });

  test("bandEnergy attributes a tone's power to the band containing it", () => {
    const { real, imag } = realFFT(sineSignal(size, 8, sampleRate, 1), size);
    const inBand = bandEnergy(real, imag, sampleRate, 7, 9, size);
    const offBand = bandEnergy(real, imag, sampleRate, 20, 30, size);

    // Bin-aligned tone, single positive-frequency bin: |X|²/N² = 0.25.
    expect(inBand).toBeCloseTo(0.25, 6);
    expect(offBand).toBeLessThan(1e-12);
  });

  test("preserves sine energy across sample rates and padding ratios", () => {
    const low = sineSignal(180, 8, 60, 0.4);
    const high = sineSignal(360, 8, 120, 0.4);
    const lowSpectrum = realFFT(low, nextPow2(low.length));
    const highSpectrum = realFFT(high, nextPow2(high.length));
    const lowEnergy = bandEnergy(lowSpectrum.real, lowSpectrum.imag, 60, 7, 9, low.length);
    const highEnergy = bandEnergy(highSpectrum.real, highSpectrum.imag, 120, 7, 9, high.length);

    expect(Math.abs(lowEnergy - highEnergy) / highEnergy).toBeLessThan(5e-5);
  });
});

describe("nextPow2", () => {
  test("clamps inputs at or below 2 up to 2", () => {
    expect(nextPow2(0)).toBe(2);
    expect(nextPow2(1)).toBe(2);
    expect(nextPow2(2)).toBe(2);
  });

  test("leaves exact powers of two unchanged", () => {
    expect(nextPow2(16)).toBe(16);
    expect(nextPow2(1024)).toBe(1024);
  });

  test("rounds up to the next power of two", () => {
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(700)).toBe(1024);
    expect(nextPow2(1025)).toBe(2048);
  });
});

describe("realFFT input handling", () => {
  test("rejects sizes that are not a positive power of two", () => {
    expect(() => realFFT([1, 2, 3], 6)).toThrow();
    expect(() => realFFT([1, 2, 3], 0)).toThrow();
  });

  test("zero-pads input shorter than size", () => {
    const { real, imag } = realFFT([1, 2, 3], 4);
    expect(real[0]).toBeCloseTo(6, 9); // DC = 1 + 2 + 3 + 0
    expect(imag[0]).toBeCloseTo(0, 9);
  });

  test("truncates input longer than size", () => {
    const { real } = realFFT([1, 2, 3, 4, 5, 6], 4);
    expect(real[0]).toBeCloseTo(10, 9); // DC = sum of first 4
  });
});
