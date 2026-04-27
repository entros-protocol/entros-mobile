// Shared sensor types for the capture layer.
//
// PRIVACY CONTRACT: every consumer of these structs MUST discard the raw
// `samples` / `pcm` arrays immediately after running feature extraction. They
// are never persisted (no AsyncStorage, no SecureStore, no app document
// directory), never logged with values (only lengths and statistics for
// diagnostics), and never transmitted off-device EXCEPT for the audio b64
// path to /validate-features for Whisper STT (paper §6.8 sanctioned exception).

export const TARGET_AUDIO_SAMPLE_RATE = 16_000;

export interface AudioCapture {
  /** PCM samples normalised to [-1, 1], resampled to {@link TARGET_AUDIO_SAMPLE_RATE}. */
  pcm: Float32Array;
  /** Sample rate in Hz. Always {@link TARGET_AUDIO_SAMPLE_RATE} after resample. */
  sampleRate: number;
  /** Capture duration in milliseconds. */
  durationMs: number;
}

export interface MotionSample {
  /** Timestamp in milliseconds since capture start. */
  t: number;
  /** Accelerometer X / Y / Z in m/s² (excluding gravity). */
  ax: number;
  ay: number;
  az: number;
  /** Gyroscope X / Y / Z in rad/s. */
  gx: number;
  gy: number;
  gz: number;
}

export interface MotionCapture {
  samples: MotionSample[];
  /** Effective sample rate (computed from samples.length / duration). */
  sampleRate: number;
  durationMs: number;
}

export interface TouchSample {
  /** Timestamp in milliseconds since capture start. */
  t: number;
  /** Normalised coordinates in [0, 1] relative to the trace canvas. */
  x: number;
  y: number;
  /** Pressure in [0, 1] if available, else 1. iOS / many Android: not exposed. */
  pressure: number;
}

export interface TouchCapture {
  samples: TouchSample[];
  durationMs: number;
}

export interface SensorData {
  audio: AudioCapture;
  motion: MotionCapture;
  touch: TouchCapture;
}
