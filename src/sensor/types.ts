// Shared sensor types for the capture layer.
//
// PRIVACY CONTRACT: every consumer of these structs MUST discard the raw
// `samples` / `pcm` arrays immediately after running feature extraction. They
// are never persisted (no AsyncStorage, no SecureStore, no app document
// directory), never logged with values (only lengths and statistics for
// diagnostics), and never transmitted off-device EXCEPT for the audio b64
// path to /validate-features for Whisper STT (paper §6.8 sanctioned exception).

/**
 * The rate `audio.ts` asks `AudioRecord` to configure.
 * Android reads the initialization state and configured rate before capture.
 */
export const TARGET_AUDIO_SAMPLE_RATE = 16_000;

export interface AudioCapture {
  /**
   * PCM samples normalised to [-1, 1].
   *
   * Mobile applies the same final FIR and 16 kHz conversion as Pulse before
   * extraction or transmission.
   */
  pcm: Float32Array;
  /** Sample rate of {@link pcm}. */
  sampleRate: number;
  /** Configured native AudioRecord sample rate before canonicalization. */
  nativeSampleRate: number;
  /** Capture duration in milliseconds. */
  durationMs: number;
  /**
   * `Date.now()` at the instant recording began. Together with
   * {@link durationMs} this places the buffer on the same timeline as motion,
   * which is what the cross-modal coupling check needs the two to share.
   */
  startedAt: number;
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
  /**
   * `Date.now()` at the instant recording began, which is what {@link
   * MotionSample.t} counts from. Audio carries its own, and the two are the
   * only way to place both streams on one timeline.
   */
  startedAt: number;
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

export interface CurveTracePoint {
  /** Capture-relative monotonic timestamp. Never transmitted. */
  t: number;
  /** Coordinates in the executor's 200 by 200 challenge frame. */
  x: number;
  y: number;
}

export interface CurveTraceOutline {
  /** Equal-time coarse outline. Raw coordinates and timestamps stay on-device. */
  points: [number, number][];
  duration_ms: number;
}

export interface TouchCapture {
  samples: TouchSample[];
  /** Bounded source samples retained only for on-device projection 1 extraction. */
  compatibilitySamples?: TouchSample[];
  /** Raw on-device source for a coarse 64-point challenge outline. */
  curveTrace?: CurveTracePoint[];
  durationMs: number;
}

export interface SensorData {
  audio: AudioCapture;
  motion: MotionCapture;
  touch: TouchCapture;
}
