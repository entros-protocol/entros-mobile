// PORTED VERBATIM from pulse-sdk/src/extraction/speaker.ts.
// Speaker-dependent audio features (44 dims): F0 stats, F0 delta, jitter,
// shimmer, HNR, formant ratios, LTAS, voicing ratio, amplitude stats.
//
// Cross-platform reproducibility (Stage 3) requires bit-identical output
// between web and mobile, so this stays in sync with the web SDK.
//
// Hermes notes:
// - `pitchfinder` is pure TypeScript and works without polyfills.
// - `meyda` is loaded dynamically; if its Web Audio paths break under
//   Hermes, the LTAS block returns zeros and the rest still computes.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AudioCapture } from "./types";
import { condense, entropy } from "./statistics";
import { extractFormantRatios } from "./lpc";
import { sdkWarn } from "./log";

function getFrameSize(sampleRate: number): number {
  const MIN_F0 = 50;
  const minSize = Math.ceil((4 * sampleRate) / MIN_F0);
  let size = 512;
  while (size < minSize) size *= 2;
  return size;
}

function getHopSize(sampleRate: number): number {
  return Math.max(1, Math.round(sampleRate * 0.01));
}

const SPEAKER_FEATURE_COUNT = 44;

let pitchDetector: ((buf: Float32Array) => number | null) | null = null;
let pitchDetectorRate = 0;
let meydaModule: any = null;

// Fallback used when `pitchfinder` fails to load under Hermes (rare, but
// `meyda` already has the same belt-and-braces in `getMeyda()`). Returning
// null per frame degrades the F0/jitter/shimmer block to zeros — `detectF0Contour`
// already treats null as unvoiced — rather than crashing the whole extraction.
const noPitch = (_: Float32Array): number | null => null;

async function getPitchDetector(sampleRate: number): Promise<(buf: Float32Array) => number | null> {
  if (!pitchDetector || pitchDetectorRate !== sampleRate) {
    try {
      const PitchFinder = await import("pitchfinder");
      pitchDetector = (PitchFinder as any).YIN({ sampleRate, threshold: 0.15 });
      pitchDetectorRate = sampleRate;
    } catch {
      pitchDetector = noPitch;
      pitchDetectorRate = sampleRate;
    }
  }
  return pitchDetector!;
}

async function getMeyda(): Promise<any> {
  if (!meydaModule) {
    try {
      meydaModule = await import("meyda");
    } catch {
      return null;
    }
  }
  return meydaModule.default ?? meydaModule;
}

async function detectF0Contour(
  samples: Float32Array,
  sampleRate: number,
): Promise<{ f0: number[]; amplitudes: number[]; periods: number[] }> {
  const detect = await getPitchDetector(sampleRate);
  const frameSize = getFrameSize(sampleRate);
  const hopSize = getHopSize(sampleRate);
  const f0: number[] = [];
  const amplitudes: number[] = [];
  const periods: number[] = [];
  const numFrames = Math.floor((samples.length - frameSize) / hopSize) + 1;

  if (sampleRate !== 16000) {
    sdkWarn(
      `[Entros] Audio captured at ${sampleRate}Hz (expected 16kHz). Frame size adjusted to ${frameSize}.`,
    );
  }

  for (let i = 0; i < numFrames; i++) {
    const start = i * hopSize;
    // `subarray` is a zero-copy view — `detect()` and the RMS loop below
    // are read-only, so we save ~1.2k Float32Array allocations per session
    // (and matching GC pressure on Hermes).
    const frame = samples.subarray(start, start + frameSize);

    const pitch = detect(frame);
    if (pitch && pitch > 50 && pitch < 600) {
      f0.push(pitch);
      periods.push(1 / pitch);
    } else {
      f0.push(0);
    }

    let sum = 0;
    for (let j = 0; j < frame.length; j++) {
      sum += (frame[j] ?? 0) * (frame[j] ?? 0);
    }
    amplitudes.push(Math.sqrt(sum / frame.length));
  }

  return { f0, amplitudes, periods };
}

function computeJitter(periods: number[]): number[] {
  const voiced = periods.filter((p) => p > 0);
  if (voiced.length < 3) return [0, 0, 0, 0];

  const meanPeriod = voiced.reduce((a, b) => a + b, 0) / voiced.length;
  if (meanPeriod === 0) return [0, 0, 0, 0];

  let localSum = 0;
  for (let i = 1; i < voiced.length; i++) {
    localSum += Math.abs(voiced[i]! - voiced[i - 1]!);
  }
  const jitterLocal = localSum / (voiced.length - 1) / meanPeriod;

  let rapSum = 0;
  for (let i = 1; i < voiced.length - 1; i++) {
    const avg3 = (voiced[i - 1]! + voiced[i]! + voiced[i + 1]!) / 3;
    rapSum += Math.abs(voiced[i]! - avg3);
  }
  const jitterRAP = voiced.length > 2 ? rapSum / (voiced.length - 2) / meanPeriod : 0;

  let ppq5Sum = 0;
  let ppq5Count = 0;
  for (let i = 2; i < voiced.length - 2; i++) {
    const avg5 =
      (voiced[i - 2]! + voiced[i - 1]! + voiced[i]! + voiced[i + 1]! + voiced[i + 2]!) / 5;
    ppq5Sum += Math.abs(voiced[i]! - avg5);
    ppq5Count++;
  }
  const jitterPPQ5 = ppq5Count > 0 ? ppq5Sum / ppq5Count / meanPeriod : 0;

  let ddpSum = 0;
  for (let i = 1; i < voiced.length - 1; i++) {
    const d1 = voiced[i]! - voiced[i - 1]!;
    const d2 = voiced[i + 1]! - voiced[i]!;
    ddpSum += Math.abs(d2 - d1);
  }
  const jitterDDP = voiced.length > 2 ? ddpSum / (voiced.length - 2) / meanPeriod : 0;

  return [jitterLocal, jitterRAP, jitterPPQ5, jitterDDP];
}

function computeShimmer(amplitudes: number[], f0: number[]): number[] {
  const voicedAmps = amplitudes.filter((_, i) => f0[i]! > 0);
  if (voicedAmps.length < 3) return [0, 0, 0, 0];

  const meanAmp = voicedAmps.reduce((a, b) => a + b, 0) / voicedAmps.length;
  if (meanAmp === 0) return [0, 0, 0, 0];

  let localSum = 0;
  for (let i = 1; i < voicedAmps.length; i++) {
    localSum += Math.abs(voicedAmps[i]! - voicedAmps[i - 1]!);
  }
  const shimmerLocal = localSum / (voicedAmps.length - 1) / meanAmp;

  let apq3Sum = 0;
  for (let i = 1; i < voicedAmps.length - 1; i++) {
    const avg3 = (voicedAmps[i - 1]! + voicedAmps[i]! + voicedAmps[i + 1]!) / 3;
    apq3Sum += Math.abs(voicedAmps[i]! - avg3);
  }
  const shimmerAPQ3 = voicedAmps.length > 2 ? apq3Sum / (voicedAmps.length - 2) / meanAmp : 0;

  let apq5Sum = 0;
  let apq5Count = 0;
  for (let i = 2; i < voicedAmps.length - 2; i++) {
    const avg5 =
      (voicedAmps[i - 2]! +
        voicedAmps[i - 1]! +
        voicedAmps[i]! +
        voicedAmps[i + 1]! +
        voicedAmps[i + 2]!) /
      5;
    apq5Sum += Math.abs(voicedAmps[i]! - avg5);
    apq5Count++;
  }
  const shimmerAPQ5 = apq5Count > 0 ? apq5Sum / apq5Count / meanAmp : 0;

  let ddaSum = 0;
  for (let i = 1; i < voicedAmps.length - 1; i++) {
    const d1 = voicedAmps[i]! - voicedAmps[i - 1]!;
    const d2 = voicedAmps[i + 1]! - voicedAmps[i]!;
    ddaSum += Math.abs(d2 - d1);
  }
  const shimmerDDA = voicedAmps.length > 2 ? ddaSum / (voicedAmps.length - 2) / meanAmp : 0;

  return [shimmerLocal, shimmerAPQ3, shimmerAPQ5, shimmerDDA];
}

function computeHNR(samples: Float32Array, sampleRate: number, f0Contour: number[]): number[] {
  const frameSize = getFrameSize(sampleRate);
  const hopSize = getHopSize(sampleRate);
  const hnr: number[] = [];
  const numFrames = Math.floor((samples.length - frameSize) / hopSize) + 1;

  for (let i = 0; i < numFrames && i < f0Contour.length; i++) {
    const f0 = f0Contour[i]!;
    if (f0 <= 0) continue;

    const start = i * hopSize;
    // Read-only autocorrelation — view is safe.
    const frame = samples.subarray(start, start + frameSize);
    const period = Math.round(sampleRate / f0);

    if (period <= 0 || period >= frame.length) continue;

    let num = 0;
    let den = 0;
    for (let j = 0; j < frame.length - period; j++) {
      num += (frame[j] ?? 0) * (frame[j + period] ?? 0);
      den += (frame[j] ?? 0) * (frame[j] ?? 0);
    }

    if (den > 0) {
      const r = num / den;
      const clampedR = Math.max(0.001, Math.min(0.999, r));
      hnr.push(10 * Math.log10(clampedR / (1 - clampedR)));
    }
  }

  return hnr;
}

async function computeLTAS(samples: Float32Array, sampleRate: number): Promise<number[]> {
  const frameSize = getFrameSize(sampleRate);
  const hopSize = getHopSize(sampleRate);
  const Meyda = await getMeyda();
  if (!Meyda) return new Array(8).fill(0);

  const centroids: number[] = [];
  const rolloffs: number[] = [];
  const flatnesses: number[] = [];
  const spreads: number[] = [];
  const numFrames = Math.floor((samples.length - frameSize) / hopSize) + 1;
  // Pre-allocate the buffer Meyda receives — frames are exactly `frameSize`
  // (the loop bounds guarantee no overrun), so we can overwrite each
  // iteration via `.set()` instead of allocating ~1.2k Float32Arrays.
  const paddedFrame = new Float32Array(frameSize);

  for (let i = 0; i < numFrames; i++) {
    const start = i * hopSize;
    paddedFrame.set(samples.subarray(start, start + frameSize), 0);

    let features: any;
    try {
      features = Meyda.extract(
        ["spectralCentroid", "spectralRolloff", "spectralFlatness", "spectralSpread"],
        paddedFrame,
        { sampleRate, bufferSize: frameSize },
      );
    } catch {
      continue;
    }

    if (features) {
      if (Number.isFinite(features.spectralCentroid)) centroids.push(features.spectralCentroid);
      if (Number.isFinite(features.spectralRolloff)) rolloffs.push(features.spectralRolloff);
      if (Number.isFinite(features.spectralFlatness)) flatnesses.push(features.spectralFlatness);
      if (Number.isFinite(features.spectralSpread)) spreads.push(features.spectralSpread);
    }
  }

  const m = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const v = (arr: number[]) => {
    if (arr.length < 2) return 0;
    const mu = m(arr);
    return arr.reduce((sum, x) => sum + (x - mu) * (x - mu), 0) / (arr.length - 1);
  };

  return [
    m(centroids),
    v(centroids),
    m(rolloffs),
    v(rolloffs),
    m(flatnesses),
    v(flatnesses),
    m(spreads),
    v(spreads),
  ];
}

function derivative(values: number[]): number[] {
  const d: number[] = [];
  for (let i = 1; i < values.length; i++) {
    d.push(values[i]! - values[i - 1]!);
  }
  return d;
}

/**
 * Extract 44 speaker features AND the raw F0 contour.
 */
export async function extractSpeakerFeaturesDetailed(
  audio: AudioCapture,
): Promise<{ features: number[]; f0Contour: number[] }> {
  const { samples, sampleRate } = audio;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length === 0) {
    sdkWarn("[Entros] Invalid audio data. Speaker features will be zeros.");
    return { features: new Array(SPEAKER_FEATURE_COUNT).fill(0), f0Contour: [] };
  }

  const frameSize = getFrameSize(sampleRate);
  const hopSize = getHopSize(sampleRate);

  const numFrames = Math.floor((samples.length - frameSize) / hopSize) + 1;
  if (numFrames < 5) {
    sdkWarn(`[Entros] Too few audio frames (${numFrames}). Speaker features will be zeros.`);
    return { features: new Array(SPEAKER_FEATURE_COUNT).fill(0), f0Contour: [] };
  }

  let peakAmp = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i] ?? 0);
    if (abs > peakAmp) peakAmp = abs;
  }

  // Single-allocation normalisation. Order of operations preserved exactly
  // (`(s / peakAmp) * 0.9`) so the output is bit-identical to the previous
  // `Float32Array(Array.from(samples, ...))` form.
  let normalizedSamples: Float32Array;
  if (peakAmp > 1e-6) {
    normalizedSamples = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      normalizedSamples[i] = (samples[i]! / peakAmp) * 0.9;
    }
  } else {
    normalizedSamples = samples;
  }

  const { f0, periods } = await detectF0Contour(normalizedSamples, sampleRate);

  const amplitudes: number[] = [];
  for (let i = 0; i < numFrames; i++) {
    const start = i * hopSize;
    let sum = 0;
    const end = Math.min(start + frameSize, samples.length);
    for (let j = start; j < end; j++) {
      sum += (samples[j] ?? 0) * (samples[j] ?? 0);
    }
    amplitudes.push(Math.sqrt(sum / (end - start)));
  }

  const voicedF0 = f0.filter((v) => v > 0);
  const voicedRatio = voicedF0.length / f0.length;

  const f0Stats = condense(voicedF0);
  const f0Entropy = entropy(voicedF0);
  const f0Features = [
    f0Stats.mean,
    f0Stats.variance,
    f0Stats.skewness,
    f0Stats.kurtosis,
    f0Entropy,
  ];

  const f0Delta = derivative(voicedF0);
  const f0DeltaStats = condense(f0Delta);
  const f0DeltaFeatures = [
    f0DeltaStats.mean,
    f0DeltaStats.variance,
    f0DeltaStats.skewness,
    f0DeltaStats.kurtosis,
  ];

  const jitterFeatures = computeJitter(periods);
  const shimmerFeatures = computeShimmer(amplitudes, f0);

  const hnrValues = computeHNR(normalizedSamples, sampleRate, f0);
  const hnrStats = condense(hnrValues);
  const hnrEntropy = entropy(hnrValues);
  const hnrFeatures = [
    hnrStats.mean,
    hnrStats.variance,
    hnrStats.skewness,
    hnrStats.kurtosis,
    hnrEntropy,
  ];

  const { f1f2, f2f3 } = extractFormantRatios(normalizedSamples, sampleRate, frameSize, hopSize);
  const f1f2Stats = condense(f1f2);
  const f2f3Stats = condense(f2f3);
  const formantFeatures = [
    f1f2Stats.mean,
    f1f2Stats.variance,
    f1f2Stats.skewness,
    f1f2Stats.kurtosis,
    f2f3Stats.mean,
    f2f3Stats.variance,
    f2f3Stats.skewness,
    f2f3Stats.kurtosis,
  ];

  const ltasFeatures = await computeLTAS(samples, sampleRate);

  const voicingFeatures = [voicedRatio];

  const ampStats = condense(amplitudes);
  const ampEntropy = entropy(amplitudes);
  const ampFeatures = [
    ampStats.mean,
    ampStats.variance,
    ampStats.skewness,
    ampStats.kurtosis,
    ampEntropy,
  ];

  const features = [
    ...f0Features,
    ...f0DeltaFeatures,
    ...jitterFeatures,
    ...shimmerFeatures,
    ...hnrFeatures,
    ...formantFeatures,
    ...ltasFeatures,
    ...voicingFeatures,
    ...ampFeatures,
  ];

  return { features, f0Contour: f0 };
}

export async function extractSpeakerFeatures(audio: AudioCapture): Promise<number[]> {
  const { features } = await extractSpeakerFeaturesDetailed(audio);
  return features;
}

export { SPEAKER_FEATURE_COUNT };
