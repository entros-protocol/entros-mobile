import { yieldToMainThread } from "@/lib/yield";

/** The sample rate and bandwidth used for extraction and transmission. */
export const CANONICAL_SAMPLE_RATE = 16_000;

const CUTOFF_FRACTION = 0.475;
const TAPS_AT_CANONICAL = 127;
const DELAY_AT_CANONICAL = (TAPS_AT_CANONICAL - 1) / 2;
const YIELD_EVERY_N_MACS = 1_000_000;

export interface CanonicalCapture {
  samples: Float32Array;
  sampleRate: number;
}

function tapsForRate(sampleRate: number): number {
  const delay = Math.round((DELAY_AT_CANONICAL * sampleRate) / CANONICAL_SAMPLE_RATE);
  return Math.max(3, 2 * delay + 1);
}

function designLowpassFir(sampleRate: number, cutoffHz: number, numTaps: number): Float64Array {
  const taps = new Float64Array(numTaps);
  const span = numTaps - 1;
  const normalizedCutoff = cutoffHz / sampleRate;
  const center = span / 2;

  for (let index = 0; index < numTaps; index++) {
    const distance = index - center;
    const sinc =
      Math.abs(distance) < 1e-9
        ? 2 * normalizedCutoff
        : Math.sin(2 * Math.PI * normalizedCutoff * distance) / (Math.PI * distance);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / span);
    taps[index] = sinc * window;
  }

  let sum = 0;
  for (let index = 0; index < numTaps; index++) sum += taps[index]!;
  if (Math.abs(sum) > 1e-9) {
    for (let index = 0; index < numTaps; index++) {
      taps[index] = taps[index]! / sum;
    }
  }
  return taps;
}

/**
 * Apply Pulse's fixed lowpass filter and convert the buffer to 16 kHz.
 * The filter also runs at 16 kHz so every runtime ends with the same DSP step.
 */
export async function toCanonicalCapture(
  input: Float32Array,
  fromRate: number,
): Promise<CanonicalCapture> {
  if (!(fromRate >= CANONICAL_SAMPLE_RATE) || !Number.isFinite(fromRate)) {
    return { samples: input, sampleRate: fromRate };
  }
  if (input.length === 0) {
    return { samples: input, sampleRate: CANONICAL_SAMPLE_RATE };
  }
  return {
    samples: await resampleTo(input, fromRate, CANONICAL_SAMPLE_RATE),
    sampleRate: CANONICAL_SAMPLE_RATE,
  };
}

/** Lowpass and decimate a PCM buffer with Pulse's deterministic FIR contract. */
export async function resampleTo(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Promise<Float32Array> {
  if (!(fromRate >= toRate) || !Number.isFinite(fromRate) || input.length === 0) {
    return input;
  }

  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.round(input.length / ratio));
  const numTaps = tapsForRate(fromRate);
  const taps = designLowpassFir(fromRate, toRate * CUTOFF_FRACTION, numTaps);
  const delay = (numTaps - 1) / 2;
  const macsPerSample = numTaps * (Number.isInteger(ratio) ? 1 : 2);
  const yieldEvery = Math.max(1, Math.ceil(YIELD_EVERY_N_MACS / macsPerSample));

  for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
    const sourcePosition = outputIndex * ratio;
    const sourceIndex = Math.floor(sourcePosition);
    const fraction = sourcePosition - sourceIndex;

    let sample = 0;
    for (let tapIndex = 0; tapIndex < numTaps; tapIndex++) {
      const inputIndex = sourceIndex + delay - tapIndex;
      if (inputIndex >= 0 && inputIndex < input.length) {
        sample += input[inputIndex]! * taps[tapIndex]!;
      }
    }

    if (fraction !== 0) {
      let nextSample = 0;
      for (let tapIndex = 0; tapIndex < numTaps; tapIndex++) {
        const inputIndex = sourceIndex + 1 + delay - tapIndex;
        if (inputIndex >= 0 && inputIndex < input.length) {
          nextSample += input[inputIndex]! * taps[tapIndex]!;
        }
      }
      sample += (nextSample - sample) * fraction;
    }

    output[outputIndex] = sample;
    if (outputIndex > 0 && outputIndex < output.length - 1 && outputIndex % yieldEvery === 0) {
      await yieldToMainThread();
    }
  }

  return output;
}
