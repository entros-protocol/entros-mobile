const TARGET_CAPTURE_RMS = 0.05;
const MIN_RMS_FOR_NORMALIZATION = 1e-4;
const MAX_NORMALIZATION_GAIN = 50;

/** Match Pulse's capture-level normalization before feature extraction. */
export function normalizeCaptureRMS(samples: Float32Array): Float32Array {
  if (samples.length === 0) return samples;
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index++) {
    sumSquares += samples[index]! * samples[index]!;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms < MIN_RMS_FOR_NORMALIZATION) return samples;

  const gain = Math.min(TARGET_CAPTURE_RMS / rms, MAX_NORMALIZATION_GAIN);
  const normalized = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    normalized[index] = Math.max(-1, Math.min(1, samples[index]! * gain));
  }
  return normalized;
}

export interface CaptureLevel {
  /** RMS before normalisation. */
  rms: number;
  /** Largest absolute sample before normalisation. */
  peak: number;
  /** The gain normalisation applies. 1 when the capture is too quiet to level. */
  gain: number;
  /** True when the capture sits below what the gain ceiling can recover. */
  gainClipped: boolean;
}

/** Describes a capture's level against the normalisation above. Diagnostic only. */
export function describeCaptureLevel(samples: Float32Array): CaptureLevel {
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;
  if (rms < MIN_RMS_FOR_NORMALIZATION) return { rms, peak, gain: 1, gainClipped: true };
  const wanted = TARGET_CAPTURE_RMS / rms;
  return {
    rms,
    peak,
    gain: Math.min(wanted, MAX_NORMALIZATION_GAIN),
    gainClipped: wanted > MAX_NORMALIZATION_GAIN,
  };
}
