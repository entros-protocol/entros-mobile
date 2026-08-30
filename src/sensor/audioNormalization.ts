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
