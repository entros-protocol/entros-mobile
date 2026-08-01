// Shared sensor types for the capture layer.
//
// PRIVACY CONTRACT: every consumer of these structs MUST discard the raw
// `samples` / `pcm` arrays immediately after running feature extraction. They
// are never persisted (no AsyncStorage, no SecureStore, no app document
// directory), never logged with values (only lengths and statistics for
// diagnostics), and never transmitted off-device EXCEPT for the audio b64
// path to /validate-features for Whisper STT (paper §6.8 sanctioned exception).

/**
 * The rate `audio.ts` asks `AudioRecord` for. A request, not a guarantee:
 * Android substitutes a supported rate when the hardware cannot deliver this
 * one.
 */
export const TARGET_AUDIO_SAMPLE_RATE = 16_000;

export interface AudioCapture {
  /**
   * PCM samples normalised to [-1, 1], at whatever rate the capture actually
   * ran at.
   *
   * These doc comments used to claim the samples were "resampled to"
   * {@link TARGET_AUDIO_SAMPLE_RATE} and that {@link sampleRate} was "always"
   * that value "after resample". No resampler has ever existed on this
   * platform. `audio.ts` returns the constant it requested without reading
   * back what `AudioRecord` negotiated, which is why the `sampleRate !== 16000`
   * guard in `speaker.ts` can never fire.
   *
   * The web SDK now band-limits and decimates every capture to a canonical
   * 16 kHz in `pulse-sdk/src/sensor/resample.ts`. Until that is ported here
   * and the negotiated rate is read back, mobile captures on hardware that
   * refuses 16 kHz produce a feature vector that is not comparable with the
   * web one.
   */
  pcm: Float32Array;
  /** Sample rate in Hz. Currently the requested rate, not a readback. */
  sampleRate: number;
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

export interface TouchCapture {
  samples: TouchSample[];
  durationMs: number;
}

export interface SensorData {
  audio: AudioCapture;
  motion: MotionCapture;
  touch: TouchCapture;
}
