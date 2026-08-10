import type { MotionSample, TouchSample } from "./types";
import { condense, mean, variance, entropy, autocorrelation } from "./statistics";
import { realFFT, bandEnergy, peakInBand, nextPow2 } from "./fft";

// v2 motion block widens 54 → 81: 54 legacy (jerk + jounce stats × 6 axes,
// jitter variance × 6) followed by 27 new features. Order is fixed by
// `MOTION_FEATURE_COUNT` and asserted in tests/extraction.test.ts.
export const MOTION_LEGACY_COUNT = 54;
export const MOTION_V2_ADDITIONS = 27;
export const MOTION_FEATURE_COUNT = MOTION_LEGACY_COUNT + MOTION_V2_ADDITIONS;

// v2 touch block widens 36 → 57: 36 legacy followed by 21 new features.
export const TOUCH_LEGACY_COUNT = 36;
export const TOUCH_V2_ADDITIONS = 21;
export const TOUCH_FEATURE_COUNT = TOUCH_LEGACY_COUNT + TOUCH_V2_ADDITIONS;

// Mouse-dynamics keeps width parity with the motion block so that desktop
// captures fuse cleanly into the same fingerprint slot as mobile IMU
// captures. The first 54 entries are the legacy mouse-dynamics features;
// the remaining 27 are zero (no IMU on desktop).
export const MOUSE_DYNAMICS_FEATURE_COUNT = MOTION_FEATURE_COUNT;

/**
 * How much of the audio window motion must span before a contour is worth
 * building. Below this the frames outside the covered stretch would be filled
 * by edge-clamping, and a flat run reads to the validator's cross-correlation
 * as weak coupling rather than as missing data.
 */
const MIN_WINDOW_COVERAGE = 0.9;

/**
 * Compute per-sample acceleration magnitude |a| = √(ax² + ay² + az²) and
 * resample it onto `window`, the wall-clock stretch the transmitted audio
 * covers, at `targetFrameCount` equally spaced instants.
 *
 * Mirrors `extractAccelerationMagnitude` in `@entros/pulse-sdk`, including the
 * required `window` argument and the coverage floor.
 *
 * This used to map motion's array index proportionally onto audio's frame
 * count, which is correct only while both streams happen to cover the same
 * window. `pulse-sdk@4.0.0` diverged them on web by trimming the pre-prompt
 * lead-in out of the audio alone, and cross-modal coupling fell from r=0.31 to
 * r=0.03 until it was found by hand. Mobile never shipped that trim, so the
 * same code was correct here by luck rather than by construction. A required
 * parameter turns the next divergence into a compile error instead.
 *
 * `window` and {@link MotionSample.timestamp} are both in the `Date.now()`
 * domain, so they compare directly.
 *
 * Returns an empty array when the capture cannot support an honest contour:
 * too few samples, a degenerate window, or motion spanning less than
 * {@link MIN_WINDOW_COVERAGE} of it. The validator treats an absent contour as
 * "skip", which is the fail-safe direction. A misaligned one reads as weak
 * coupling and rejects a real person.
 */
export function extractAccelerationMagnitude(
  samples: MotionSample[],
  targetFrameCount: number,
  window: { startMs: number; endMs: number },
): number[] {
  if (samples.length < 2 || targetFrameCount < 2) return [];

  const { startMs, endMs } = window;
  const span = endMs - startMs;
  if (!Number.isFinite(span) || span <= 0) return [];

  const firstAt = samples[0]!.timestamp;
  const lastAt = samples[samples.length - 1]!.timestamp;
  // Clamped at zero so a stream sitting entirely outside the window reports no
  // coverage rather than a negative one.
  const overlap = Math.max(0, Math.min(endMs, lastAt) - Math.max(startMs, firstAt));
  if (overlap / span < MIN_WINDOW_COVERAGE) return [];

  const magnitudes = samples.map((s) => Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az));

  const out = new Array<number>(targetFrameCount);
  // `t` increases every iteration and sample timestamps are monotonic, so the
  // cursor only ever moves forward. One pass over both series, not a search
  // per frame.
  let cursor = 0;
  for (let i = 0; i < targetFrameCount; i++) {
    const t = startMs + (i / (targetFrameCount - 1)) * span;
    while (cursor + 1 < samples.length && samples[cursor + 1]!.timestamp <= t) cursor++;

    const at = samples[cursor]!.timestamp;
    if (t <= at || cursor + 1 >= samples.length) {
      // Before the first sample or past the last. Hold the edge value rather
      // than extrapolating a trend the sensor never reported.
      out[i] = magnitudes[cursor]!;
      continue;
    }
    const nextAt = samples[cursor + 1]!.timestamp;
    const step = nextAt - at;
    // Two readings sharing a timestamp carry no gradient to interpolate along.
    const frac = step > 0 ? (t - at) / step : 0;
    out[i] = magnitudes[cursor]! * (1 - frac) + magnitudes[cursor + 1]! * frac;
  }
  return out;
}

/**
 * Extract kinematic features from motion (IMU) data.
 *
 * Layout (`MOTION_FEATURE_COUNT = 81`):
 *   `[0..48)`  legacy: 6 axes × (jerk stats 4 + jounce stats 4)
 *   `[48..54)` legacy: jitter variance per axis (6)
 *   `[54..60)` v2:    cross-axis covariance (6 selected pairs)
 *   `[60..72)` v2:    FFT band energy in {0-2, 2-6, 6-12, 12-30} Hz × {ax, ay, az}
 *   `[72..74)` v2:    physiological tremor peak frequency + amplitude (4-12 Hz)
 *   `[74..76)` v2:    direction-reversal rate per axis: mean, variance across {ax, ay, az}
 *   `[76]`     v2:    mean angular velocity (|gyro| over the capture)
 *   `[77..81)` v2:    motion-magnitude autocorrelation at lags {1, 5, 10, 25}
 *
 * @privacyGuarantee Operates on already-on-device IMU samples and emits
 * statistical / spectral aggregates (variances, covariances, band sums,
 * autocorrelation scalars). The full sample stream is never transmitted.
 */
export function extractMotionFeatures(samples: MotionSample[], projectionVersion = 0): number[] {
  if (samples.length < 5) return new Array(MOTION_FEATURE_COUNT).fill(0);

  const corrected = usesCorrectedExtraction(projectionVersion);
  const timestamps = samples.map((sample) => sample.timestamp);

  // Extract acceleration and rotation time series
  const axes = {
    ax: samples.map((s) => s.ax),
    ay: samples.map((s) => s.ay),
    az: samples.map((s) => s.az),
    gx: samples.map((s) => s.gx),
    gy: samples.map((s) => s.gy),
    gz: samples.map((s) => s.gz),
  };

  const features: number[] = [];

  for (const values of Object.values(axes)) {
    // Jerk = 3rd derivative of position = 1st derivative of acceleration
    const jerk = derivativeForProjection(values, timestamps, corrected);
    // Jounce = 4th derivative of position = 2nd derivative of acceleration
    const jounce = derivativeForProjection(jerk.values, jerk.timestamps, corrected);

    const jerkStats = condense(jerk.values);
    const jounceStats = condense(jounce.values);

    features.push(
      jerkStats.mean,
      jerkStats.variance,
      jerkStats.skewness,
      jerkStats.kurtosis,
      jounceStats.mean,
      jounceStats.variance,
      jounceStats.skewness,
      jounceStats.kurtosis,
    );
  }

  // Jitter variance per axis: variance of windowed jerk variance.
  // Captures temporal fluctuation in the motion signal.
  for (const values of Object.values(axes)) {
    const jerk = derivativeForProjection(values, timestamps, corrected).values;
    const windowSize = Math.max(5, Math.floor(jerk.length / 4));
    const windowVariances: number[] = [];
    for (let i = 0; i <= jerk.length - windowSize; i += windowSize) {
      windowVariances.push(variance(jerk.slice(i, i + windowSize)));
    }
    features.push(windowVariances.length >= 2 ? variance(windowVariances) : 0);
  }

  // ---- v2 additions ----
  features.push(...computeMotionV2(axes, samples, corrected));

  return features;
}

/**
 * v2 motion additions (27 features). Pulled into a dedicated helper so the
 * legacy 54-feature block stays isolated and visually identifiable in the
 * git history of `extractMotionFeatures`.
 */
function computeMotionV2(
  axes: Record<"ax" | "ay" | "az" | "gx" | "gy" | "gz", number[]>,
  samples: MotionSample[],
  corrected: boolean,
): number[] {
  const out: number[] = [];

  // 1. Cross-axis covariance — 6 selected pairs (per blueprint §2.2).
  const covPairs: [number[], number[]][] = [
    [axes.ax, axes.gy],
    [axes.ay, axes.gx],
    [axes.az, axes.gz],
    [axes.ax, axes.az],
    [axes.ay, axes.az],
    [axes.gx, axes.gy],
  ];
  for (const [a, b] of covPairs) out.push(covariance(a, b));

  // 2. FFT band energy on the 3 accelerometer axes.
  const sampleRate = sampleRateFromTimestamps(samples.map((s) => s.timestamp));
  const fftSize = nextPow2(Math.max(64, axes.ax.length));
  const normalizationCount = corrected ? samples.length : fftSize;
  const bands: [number, number][] = [
    [0, 2],
    [2, 6],
    [6, 12],
    [12, 30],
  ];

  const accelSpectra = [axes.ax, axes.ay, axes.az].map((axis) =>
    realFFT(meanCenter(axis), fftSize),
  );
  for (const spectrum of accelSpectra) {
    for (const [lo, hi] of bands) {
      out.push(bandEnergy(spectrum.real, spectrum.imag, sampleRate, lo, hi, normalizationCount));
    }
  }

  // 3. Physiological-tremor peak (4-12 Hz) on motion magnitude.
  const magnitude = samples.map((s) => Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az));
  const magSpectrum = realFFT(meanCenter(magnitude), fftSize);
  const tremor = peakInBand(
    magSpectrum.real,
    magSpectrum.imag,
    sampleRate,
    4,
    12,
    normalizationCount,
  );
  out.push(tremor.freq, tremor.amplitude);

  // 4. Direction-reversal rate per second per accel axis (mean, variance).
  const duration = captureDurationSec(samples);
  const timestamps = samples.map((sample) => sample.timestamp);
  const reversalRates = [axes.ax, axes.ay, axes.az].map((axis) =>
    duration > 0
      ? signChangeCount(derivativeForProjection(axis, timestamps, corrected).values) / duration
      : 0,
  );
  out.push(mean(reversalRates), variance(reversalRates));

  // 5. Mean angular velocity (|gyro| over the capture).
  let gyroSum = 0;
  for (let i = 0; i < samples.length; i++) {
    const gx = samples[i]!.gx;
    const gy = samples[i]!.gy;
    const gz = samples[i]!.gz;
    gyroSum += Math.sqrt(gx * gx + gy * gy + gz * gz);
  }
  out.push(samples.length > 0 ? gyroSum / samples.length : 0);

  // 6. Motion-magnitude autocorrelation at lags 1, 5, 10, 25
  for (const lag of [1, 5, 10, 25]) {
    out.push(autocorrelation(magnitude, lag));
  }

  return out;
}

/**
 * Extract kinematic features from touch data.
 *
 * Layout (`TOUCH_FEATURE_COUNT = 57`):
 *   `[0..32)`  legacy: velocity / accel / pressure / area / jerk stats (32)
 *   `[32..36)` legacy: jitter variance for {vx, vy, pressure, area} (4)
 *   `[36..40)` v2:    pressure first-derivative stats (mean, var, skew, kurt)
 *   `[40..42)` v2:    contact aspect-ratio stats (mean, var)
 *   `[42..44)` v2:    contact-area first-derivative stats (mean, var)
 *   `[44..47)` v2:    trajectory curvature stats (mean, var, skew)
 *   `[47..50)` v2:    velocity autocorrelation at lags {1, 3, 5}
 *   `[50..54)` v2:    inter-touch gap duration stats (mean, var, skew, kurt)
 *   `[54]`     v2:    path efficiency (straight-line / total path length)
 *   `[55..57)` v2:    per-stroke total path length: mean, variance
 *
 * @privacyGuarantee Operates on already-on-device touch samples and emits
 * statistical aggregates only. The full coordinate stream is never
 * transmitted; downstream phase-content (e.g. typed text) is not
 * recoverable from the per-stroke summaries.
 */
export function extractTouchFeatures(samples: TouchSample[], projectionVersion = 0): number[] {
  if (samples.length < 5) return new Array(TOUCH_FEATURE_COUNT).fill(0);

  const corrected = usesCorrectedExtraction(projectionVersion);
  const timestamps = samples.map((sample) => sample.timestamp);
  const x = samples.map((s) => s.x);
  const y = samples.map((s) => s.y);
  const pressure = samples.map((s) => s.pressure);
  const area = samples.map((s) => s.width * s.height);

  const features: number[] = [];

  // X velocity and acceleration
  const vx = derivativeForProjection(x, timestamps, corrected);
  const accX = derivativeForProjection(vx.values, vx.timestamps, corrected);
  features.push(...Object.values(condense(vx.values)));
  features.push(...Object.values(condense(accX.values)));

  // Y velocity and acceleration
  const vy = derivativeForProjection(y, timestamps, corrected);
  const accY = derivativeForProjection(vy.values, vy.timestamps, corrected);
  features.push(...Object.values(condense(vy.values)));
  features.push(...Object.values(condense(accY.values)));

  // Pressure statistics
  features.push(...Object.values(condense(pressure)));

  // Contact area statistics
  features.push(...Object.values(condense(area)));

  // Jerk of touch path
  const jerkX = derivativeForProjection(accX.values, accX.timestamps, corrected);
  const jerkY = derivativeForProjection(accY.values, accY.timestamps, corrected);
  features.push(...Object.values(condense(jerkX.values)));
  features.push(...Object.values(condense(jerkY.values)));

  // Jitter variance for touch signals
  for (const values of [vx.values, vy.values, pressure, area]) {
    const windowSize = Math.max(5, Math.floor(values.length / 4));
    const windowVariances: number[] = [];
    for (let i = 0; i <= values.length - windowSize; i += windowSize) {
      windowVariances.push(variance(values.slice(i, i + windowSize)));
    }
    features.push(windowVariances.length >= 2 ? variance(windowVariances) : 0);
  }

  // ---- v2 additions ----
  features.push(...computeTouchV2(samples, vx.values, vy.values, corrected));

  return features;
}

/**
 * v2 touch additions (21 features). Pulled into a helper so the legacy
 * 36-feature block stays a visually identifiable unit.
 */
function computeTouchV2(
  samples: TouchSample[],
  vx: number[],
  vy: number[],
  corrected: boolean,
): number[] {
  const out: number[] = [];
  const timestamps = samples.map((sample) => sample.timestamp);

  // 1. Pressure first-derivative stats (4)
  const pressure = samples.map((s) => s.pressure);
  const dPressure = derivativeForProjection(pressure, timestamps, corrected).values;
  out.push(...Object.values(condense(dPressure)));

  // 2. Contact aspect ratio stats (mean, variance)
  const aspect = samples.map((s) => {
    const h = s.height;
    return h > 0 ? s.width / h : 0;
  });
  out.push(mean(aspect), variance(aspect));

  // 3. Contact-area first-derivative stats (mean, variance)
  const area = samples.map((s) => s.width * s.height);
  const dArea = derivativeForProjection(area, timestamps, corrected).values;
  out.push(mean(dArea), variance(dArea));

  // 4. Trajectory curvature stats (mean, var, skew).
  const CURVATURE_REST_EPS = 1e-3;
  const curvatures: number[] = [];
  for (let i = 1; i < vx.length; i++) {
    const v1x = vx[i - 1] ?? 0;
    const v1y = vy[i - 1] ?? 0;
    const v2x = vx[i] ?? 0;
    const v2y = vy[i] ?? 0;
    if (Math.hypot(v1x, v1y) < CURVATURE_REST_EPS || Math.hypot(v2x, v2y) < CURVATURE_REST_EPS) {
      continue;
    }
    const a1 = Math.atan2(v1y, v1x);
    const a2 = Math.atan2(v2y, v2x);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    curvatures.push(Math.abs(d));
  }
  const curvStats = condense(curvatures);
  out.push(curvStats.mean, curvStats.variance, curvStats.skewness);

  // 5. Velocity-magnitude autocorrelation at short lags
  const speed = vx.map((dx, i) => {
    const dy = vy[i] ?? 0;
    return Math.sqrt(dx * dx + dy * dy);
  });
  for (const lag of [1, 3, 5]) out.push(autocorrelation(speed, lag));

  // 6. Inter-touch gap duration stats (mean, var, skew, kurt).
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    gaps.push((samples[i]?.timestamp ?? 0) - (samples[i - 1]?.timestamp ?? 0));
  }
  out.push(...Object.values(condense(gaps)));

  // 7. Path efficiency = straight-line displacement / total path length.
  const stepDistances = coordinateStepDistances(samples);
  const pathSeries = corrected
    ? stepDistances
    : vx.map((dx, index) => Math.hypot(dx, vy[index] ?? 0));
  const totalPath = pathSeries.reduce((a, b) => a + b, 0);
  const dx = (samples[samples.length - 1]?.x ?? 0) - (samples[0]?.x ?? 0);
  const dy = (samples[samples.length - 1]?.y ?? 0) - (samples[0]?.y ?? 0);
  const straight = Math.sqrt(dx * dx + dy * dy);
  out.push(totalPath > 0 ? straight / totalPath : 0);

  // 8. Per-stroke total path length
  const strokeLengths = perStrokePathLengths(pathSeries);
  out.push(mean(strokeLengths), variance(strokeLengths));

  return out;
}

/** Split step distances at rest points and return each stroke's path length. */
function perStrokePathLengths(stepDistances: number[]): number[] {
  const PAUSE_THRESHOLD = 0.5;
  const lengths: number[] = [];
  let acc = 0;
  let inStroke = false;
  for (const distance of stepDistances) {
    if (distance >= PAUSE_THRESHOLD) {
      acc += distance;
      inStroke = true;
    } else if (inStroke) {
      lengths.push(acc);
      acc = 0;
      inStroke = false;
    }
  }
  if (inStroke && acc > 0) lengths.push(acc);
  return lengths;
}

interface SampledSeries {
  values: number[];
  timestamps: number[];
}

function usesCorrectedExtraction(projectionVersion: number): boolean {
  if (projectionVersion !== 0 && projectionVersion !== 1) {
    throw new Error(`Unsupported projection version ${projectionVersion}`);
  }
  return projectionVersion === 1;
}

function legacyDerivative(values: number[]): number[] {
  const derivatives: number[] = [];
  for (let index = 1; index < values.length; index++) {
    derivatives.push((values[index] ?? 0) - (values[index - 1] ?? 0));
  }
  return derivatives;
}

function derivativeForProjection(
  values: number[],
  timestamps: number[],
  corrected: boolean,
): SampledSeries {
  return corrected
    ? differentiate(values, timestamps)
    : {
        values: legacyDerivative(values),
        timestamps: timestamps.slice(1),
      };
}

/** Differentiate a series using its measured sample intervals. */
function differentiate(values: number[], timestamps: number[]): SampledSeries {
  const derivatives: number[] = [];
  const midpointTimestamps: number[] = [];
  const count = Math.min(values.length, timestamps.length);
  for (let i = 1; i < count; i++) {
    const previousTimestamp = timestamps[i - 1] ?? 0;
    const timestamp = timestamps[i] ?? previousTimestamp;
    const intervalSeconds = (timestamp - previousTimestamp) / 1000;
    const difference = (values[i] ?? 0) - (values[i - 1] ?? 0);
    derivatives.push(
      Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? difference / intervalSeconds : 0,
    );
    midpointTimestamps.push((previousTimestamp + timestamp) / 2);
  }
  return { values: derivatives, timestamps: midpointTimestamps };
}

function coordinateStepDistances(samples: TouchSample[]): number[] {
  const distances: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    distances.push(
      Math.hypot(
        (samples[i]?.x ?? 0) - (samples[i - 1]?.x ?? 0),
        (samples[i]?.y ?? 0) - (samples[i - 1]?.y ?? 0),
      ),
    );
  }
  return distances;
}

/** Subtract the arithmetic mean from a series; returns a new array. */
function meanCenter(values: number[]): number[] {
  if (values.length === 0) return [];
  let sum = 0;
  for (const v of values) sum += v;
  const m = sum / values.length;
  return values.map((v) => v - m);
}

/** Sample covariance Cov(a, b) = mean((a-mean(a))(b-mean(b))). */
function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i] ?? 0;
    sumB += b[i] ?? 0;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    cov += ((a[i] ?? 0) - meanA) * ((b[i] ?? 0) - meanB);
  }
  return cov / (n - 1);
}

/** Count strict sign changes (zero-crossings excluding zero-runs). */
function signChangeCount(values: number[]): number {
  let count = 0;
  let last = 0;
  for (const v of values) {
    if (v > 0 && last < 0) count++;
    else if (v < 0 && last > 0) count++;
    if (v !== 0) last = v;
  }
  return count;
}

/**
 * Recover the sample rate (Hz) from a millisecond-timestamped sensor stream.
 */
function sampleRateFromTimestamps(timestampsMs: number[]): number {
  if (timestampsMs.length < 2) return 0;
  const span = (timestampsMs[timestampsMs.length - 1] ?? 0) - (timestampsMs[0] ?? 0);
  if (!Number.isFinite(span) || span <= 0) return 0;
  return ((timestampsMs.length - 1) * 1000) / span;
}

/** Capture duration in seconds from a millisecond-timestamped sample set. */
function captureDurationSec(samples: { timestamp: number }[]): number {
  if (samples.length < 2) return 0;
  const span = (samples[samples.length - 1]?.timestamp ?? 0) - (samples[0]?.timestamp ?? 0);
  return Number.isFinite(span) && span > 0 ? span / 1000 : 0;
}

/**
 * Extract mouse dynamics features as a desktop replacement for motion sensor data.
 */
export function extractMouseDynamics(samples: TouchSample[], projectionVersion = 0): number[] {
  if (samples.length < 10) return new Array(MOUSE_DYNAMICS_FEATURE_COUNT).fill(0);

  const corrected = usesCorrectedExtraction(projectionVersion);
  const x = samples.map((s) => s.x);
  const y = samples.map((s) => s.y);
  const pressure = samples.map((s) => s.pressure);
  const timestamps = samples.map((sample) => sample.timestamp);
  const stepDistances = coordinateStepDistances(samples);

  // Velocity
  const vxSeries = derivativeForProjection(x, timestamps, corrected);
  const vySeries = derivativeForProjection(y, timestamps, corrected);
  const vx = vxSeries.values;
  const vy = vySeries.values;
  const speed = vx.map((dx, i) => Math.sqrt(dx * dx + (vy[i] ?? 0) * (vy[i] ?? 0)));

  // Acceleration
  const accXSeries = derivativeForProjection(vx, vxSeries.timestamps, corrected);
  const accYSeries = derivativeForProjection(vy, vySeries.timestamps, corrected);
  const accX = accXSeries.values;
  const accY = accYSeries.values;
  const acc = accX.map((ax, i) => Math.sqrt(ax * ax + (accY[i] ?? 0) * (accY[i] ?? 0)));

  // Jerk
  const jerkXSeries = derivativeForProjection(accX, accXSeries.timestamps, corrected);
  const jerkYSeries = derivativeForProjection(accY, accYSeries.timestamps, corrected);
  const jerkX = jerkXSeries.values;
  const jerkY = jerkYSeries.values;
  const jerk = jerkX.map((jx, i) => Math.sqrt(jx * jx + (jerkY[i] ?? 0) * (jerkY[i] ?? 0)));

  // Path curvature
  const curvatures: number[] = [];
  for (let i = 1; i < vx.length; i++) {
    const angle1 = Math.atan2(vy[i - 1] ?? 0, vx[i - 1] ?? 0);
    const angle2 = Math.atan2(vy[i] ?? 0, vx[i] ?? 0);
    let diff = angle2 - angle1;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    curvatures.push(Math.abs(diff));
  }

  // Movement directions
  const directions = vx.map((dx, i) => Math.atan2(vy[i] ?? 0, dx));

  // Micro-corrections
  let reversals = 0;
  for (let i = 2; i < directions.length; i++) {
    const d1 = directions[i - 1]! - directions[i - 2]!;
    const d2 = directions[i]! - directions[i - 1]!;
    if (d1 * d2 < 0) reversals++;
  }
  const reversalRate = directions.length > 2 ? reversals / (directions.length - 2) : 0;
  const reversalMagnitude =
    curvatures.length > 0 ? curvatures.reduce((a, b) => a + b, 0) / curvatures.length : 0;

  // Pause detection
  const speedThreshold = 0.5;
  const pathSeries = corrected ? stepDistances : speed;
  const pauseFrames = pathSeries.filter((distance) => distance < speedThreshold).length;
  const pauseRatio = pathSeries.length > 0 ? pauseFrames / pathSeries.length : 0;

  // Path efficiency
  const totalPathLength = pathSeries.reduce((a, b) => a + b, 0);
  const straightLine = Math.sqrt((x[x.length - 1]! - x[0]!) ** 2 + (y[y.length - 1]! - y[0]!) ** 2);
  const pathEfficiency = totalPathLength > 0 ? straightLine / totalPathLength : 0;

  // Movement durations
  const movementDurations: number[] = [];
  let currentDuration = 0;
  for (const distance of pathSeries) {
    if (distance >= speedThreshold) {
      currentDuration++;
    } else if (currentDuration > 0) {
      movementDurations.push(currentDuration);
      currentDuration = 0;
    }
  }
  if (currentDuration > 0) movementDurations.push(currentDuration);

  // Segment lengths
  const segmentLengths: number[] = [];
  let segLen = 0;
  for (let i = 1; i < directions.length; i++) {
    segLen += pathSeries[i] ?? 0;
    const angleDiff = Math.abs(directions[i]! - directions[i - 1]!);
    if (angleDiff > Math.PI / 4) {
      segmentLengths.push(segLen);
      segLen = 0;
    }
  }
  if (segLen > 0) segmentLengths.push(segLen);

  // Windowed jitter variance
  const windowSize = Math.max(5, Math.floor(speed.length / 4));
  const windowVariances: number[] = [];
  for (let i = 0; i + windowSize <= speed.length; i += windowSize) {
    const window = speed.slice(i, i + windowSize);
    windowVariances.push(variance(window));
  }
  const speedJitter = windowVariances.length > 1 ? variance(windowVariances) : 0;

  // Path length
  const duration =
    samples.length > 1
      ? (samples[samples.length - 1]!.timestamp - samples[0]!.timestamp) / 1000
      : 1;
  const normalizedPathLength = totalPathLength / Math.max(duration, 0.001);

  // Angle autocorrelation
  const angleAutoCorr: number[] = [];
  for (let lag = 1; lag <= 3; lag++) {
    if (directions.length <= lag) {
      angleAutoCorr.push(0);
      continue;
    }
    const n = directions.length - lag;
    const meanDir = directions.reduce((a, b) => a + b, 0) / directions.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (directions[i]! - meanDir) * (directions[i + lag]! - meanDir);
      den += (directions[i]! - meanDir) ** 2;
    }
    angleAutoCorr.push(den > 0 ? num / den : 0);
  }

  // Assemble 54 features
  const curvatureStats = condense(curvatures);
  const dirEntropy = entropy(directions, 16);
  const speedStats = condense(speed);
  const accStats = condense(acc);
  const jerkStats = condense(jerk);
  const vxStats = condense(vx);
  const vyStats = condense(vy);
  const accXStats = condense(accX);
  const accYStats = condense(accY);
  const pressureStats = condense(pressure);
  const moveDurStats = condense(movementDurations);
  const segLenStats = condense(segmentLengths);

  const legacyMouseDynamics = [
    curvatureStats.mean,
    curvatureStats.variance,
    curvatureStats.skewness,
    curvatureStats.kurtosis,
    dirEntropy,
    speedStats.mean,
    speedStats.variance,
    speedStats.skewness,
    speedStats.kurtosis,
    accStats.mean,
    accStats.variance,
    accStats.skewness,
    accStats.kurtosis,
    reversalRate,
    reversalMagnitude,
    pauseRatio,
    pathEfficiency,
    speedJitter,
    jerkStats.mean,
    jerkStats.variance,
    jerkStats.skewness,
    jerkStats.kurtosis,
    vxStats.mean,
    vxStats.variance,
    vxStats.skewness,
    vxStats.kurtosis,
    vyStats.mean,
    vyStats.variance,
    vyStats.skewness,
    vyStats.kurtosis,
    accXStats.mean,
    accXStats.variance,
    accXStats.skewness,
    accXStats.kurtosis,
    accYStats.mean,
    accYStats.variance,
    accYStats.skewness,
    accYStats.kurtosis,
    pressureStats.mean,
    pressureStats.variance,
    pressureStats.skewness,
    pressureStats.kurtosis,
    moveDurStats.mean,
    moveDurStats.variance,
    moveDurStats.skewness,
    moveDurStats.kurtosis,
    segLenStats.mean,
    segLenStats.variance,
    segLenStats.skewness,
    segLenStats.kurtosis,
    angleAutoCorr[0] ?? 0,
    angleAutoCorr[1] ?? 0,
    angleAutoCorr[2] ?? 0,
    normalizedPathLength,
  ];

  // Mouse V2 additions
  const v2 = computeMouseV2(
    samples,
    vx,
    vy,
    accX,
    accY,
    speed,
    acc,
    jerk,
    directions,
    vxSeries.timestamps,
    accXSeries.timestamps,
    jerkXSeries.timestamps,
    corrected,
  );
  return [...legacyMouseDynamics, ...v2];
}

/**
 * v2 mouse-dynamics additions (27 features).
 */
function computeMouseV2(
  samples: TouchSample[],
  vx: number[],
  vy: number[],
  accX: number[],
  accY: number[],
  speed: number[],
  acc: number[],
  jerk: number[],
  directions: number[],
  velocityTimestamps: number[],
  accelerationTimestamps: number[],
  jerkTimestamps: number[],
  corrected: boolean,
): number[] {
  const out: number[] = [];

  // 1. Cross-axis covariance
  const covPairs: [number[], number[]][] = [
    [vx, vy],
    [vx, accX],
    [vx, accY],
    [vy, accX],
    [vy, accY],
    [accX, accY],
  ];
  for (const [a, b] of covPairs) out.push(covariance(a, b));

  // 2. FFT band energy
  const sampleRate = sampleRateFromTimestamps(
    corrected ? velocityTimestamps : samples.map((sample) => sample.timestamp),
  );
  const fftSize = nextPow2(Math.max(64, speed.length));
  const bands: [number, number][] = [
    [0, 2],
    [2, 6],
    [6, 12],
    [12, 30],
  ];
  const speedSpectrum = realFFT(meanCenter(speed), fftSize);
  const accSpectrum = realFFT(meanCenter(acc), fftSize);
  const jerkSpectrum = realFFT(meanCenter(jerk), fftSize);
  for (const [spectrum, realSampleCount, spectrumSampleRate] of [
    [speedSpectrum, corrected ? speed.length : fftSize, sampleRate],
    [
      accSpectrum,
      corrected ? acc.length : fftSize,
      corrected ? sampleRateFromTimestamps(accelerationTimestamps) : sampleRate,
    ],
    [
      jerkSpectrum,
      corrected ? jerk.length : fftSize,
      corrected ? sampleRateFromTimestamps(jerkTimestamps) : sampleRate,
    ],
  ] as const) {
    for (const [lo, hi] of bands) {
      out.push(
        bandEnergy(spectrum.real, spectrum.imag, spectrumSampleRate, lo, hi, realSampleCount),
      );
    }
  }

  // 3. Physiological-tremor peak (4-12 Hz) on speed magnitude.
  const tremor = peakInBand(
    speedSpectrum.real,
    speedSpectrum.imag,
    sampleRate,
    4,
    12,
    corrected ? speed.length : fftSize,
  );
  out.push(tremor.freq, tremor.amplitude);

  // 4. Reversal rate per second per channel
  const duration = captureDurationSec(samples);
  const reversalChannels: [number[], number[]][] = [
    [vx, velocityTimestamps],
    [vy, velocityTimestamps],
    [speed, velocityTimestamps],
  ];
  const reversalRates = reversalChannels.map(([channel, channelTimestamps]) =>
    duration > 0
      ? signChangeCount(derivativeForProjection(channel, channelTimestamps, corrected).values) /
        duration
      : 0,
  );
  out.push(mean(reversalRates), variance(reversalRates));

  // 5. Mean angular speed: mean of unwrapped |Δdirection|.
  let dirAccum = 0;
  for (let i = 1; i < directions.length; i++) {
    let diff = directions[i]! - directions[i - 1]!;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    dirAccum += Math.abs(diff);
  }
  out.push(directions.length > 1 ? dirAccum / (directions.length - 1) : 0);

  // 6. Speed-magnitude autocorrelation
  for (const lag of [1, 5, 10, 25]) {
    out.push(autocorrelation(speed, lag));
  }

  return out.map((v) => (Number.isFinite(v) ? v : 0));
}
