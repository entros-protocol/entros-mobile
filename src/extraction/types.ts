// Pulse-SDK-shaped types used inside the extraction module. Mirror the
// browser SDK's `sensor/types.ts` field names (samples / timestamp /
// width / height) so the ported extraction code stays bit-identical to
// the web flow. The thin adapter in `index.ts` converts mobile sensor
// captures (pcm / t) into these shapes before extraction.

export interface AudioCapture {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}

export interface MotionSample {
  timestamp: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
}

export interface TouchSample {
  timestamp: number;
  x: number;
  y: number;
  pressure: number;
  width: number;
  height: number;
}

export interface SensorDataIn {
  audio: AudioCapture | null;
  motion: MotionSample[];
  touch: TouchSample[];
}

export interface StatsSummary {
  mean: number;
  variance: number;
  skewness: number;
  kurtosis: number;
}

export interface FeatureVector {
  audio: number[];
  motion: number[];
  touch: number[];
}

export type FusedFeatureVector = number[];

export interface ExtractedFeatures {
  /** Raw features in physical units. For server-side validation. */
  raw: number[];
  /** Z-score normalised features. For SimHash fingerprint computation. */
  normalized: number[];
  /** F0 contour per audio frame (~10ms hop). For server-side cross-modal lag analysis. */
  f0Contour: number[];
  /** Acceleration magnitude resampled to F0 frame count. Empty if motion absent. */
  accelMagnitude: number[];
}

export const AUDIO_FEATURE_COUNT = 170;
export const MOTION_FEATURE_COUNT = 81;
export const TOUCH_FEATURE_COUNT = 57;
export const TOTAL_FEATURE_COUNT = AUDIO_FEATURE_COUNT + MOTION_FEATURE_COUNT + TOUCH_FEATURE_COUNT;
