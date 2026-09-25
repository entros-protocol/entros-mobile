// Touch capture. Backed by react-native-gesture-handler PanGesture in the
// capture screen — this module is a thin recorder that the gesture callback
// pushes samples into. Coordinates are normalised to [0, 1] relative to the
// trace canvas before they reach this module so raw pixel positions never
// leave the gesture handler.
//
// PRIVACY: samples held in memory, discarded after extraction.

import { getProjectionDefinition } from "../projection";
import type { CurveTracePoint, TouchCapture, TouchSample } from "./types";

const TOUCH_CANONICAL_RATE_HZ = 30;
const TOUCH_MAX_INPUT_RATE_HZ = 240;
const TOUCH_MAX_DURATION_MS = 60_000;
const MOBILE_CAPTURE_MAX_DURATION_MS = 12_000;
const TOUCH_MAX_SOURCE_SAMPLES =
  Math.ceil((TOUCH_MAX_DURATION_MS * TOUCH_MAX_INPUT_RATE_HZ) / 1_000) + 2;
const MOBILE_MAX_SOURCE_SAMPLES =
  Math.ceil((MOBILE_CAPTURE_MAX_DURATION_MS * TOUCH_MAX_INPUT_RATE_HZ) / 1_000) + 2;
const TOUCH_MAX_SOURCE_GAP_MS = 250;
const TOUCH_MIN_CANONICAL_POINTS = 10;
const TOUCH_MIN_INPUT_INTERVAL_MS = 1_000 / TOUCH_MAX_INPUT_RATE_HZ;

/** Normalize projection 2 touch samples onto an endpoint-preserving 30 Hz grid. */
export function canonicalizeTouchSamples(
  samples: TouchSample[],
  projectionVersion: number,
): TouchSample[] {
  const definition = getProjectionDefinition(projectionVersion);
  if (definition.featurePipeline !== "normalized-touch") return samples;
  if (samples.length === 0) {
    throw new Error("Normalized touch capture requires source samples");
  }
  if (samples.length > TOUCH_MAX_SOURCE_SAMPLES) {
    throw new Error("Normalized touch capture exceeded the source sample limit");
  }
  if (samples.length < 2) {
    throw new Error("Normalized touch capture has insufficient source samples");
  }

  const source: TouchSample[] = [];
  for (const sample of samples) {
    if (![sample.t, sample.x, sample.y, sample.pressure].every(Number.isFinite)) {
      throw new Error("Normalized touch capture contains a non-finite value");
    }
    if (sample.x < 0 || sample.x > 1 || sample.y < 0 || sample.y > 1) {
      throw new Error("Normalized touch coordinates must stay inside the unit surface");
    }
    if (sample.pressure < 0 || sample.pressure > 1) {
      throw new Error("Normalized touch pressure must stay inside the unit interval");
    }

    const previous = source[source.length - 1];
    if (previous && sample.t < previous.t) {
      throw new Error("Normalized touch timestamps must be monotonic");
    }
    const normalized = { ...sample };
    if (previous && sample.t === previous.t) {
      source[source.length - 1] = normalized;
    } else {
      source.push(normalized);
    }
  }

  if (source.length < 2) {
    throw new Error("Normalized touch capture has insufficient distinct timestamps");
  }
  for (let index = 1; index < source.length; index++) {
    if (source[index]!.t - source[index - 1]!.t > TOUCH_MAX_SOURCE_GAP_MS) {
      throw new Error("Normalized touch capture clock was interrupted");
    }
  }

  const firstAt = source[0]!.t;
  const lastAt = source[source.length - 1]!.t;
  const durationMs = lastAt - firstAt;
  if (durationMs <= 0 || durationMs > TOUCH_MAX_DURATION_MS) {
    throw new Error("Normalized touch capture duration is outside the supported range");
  }
  const pointCount = Math.floor((durationMs * TOUCH_CANONICAL_RATE_HZ) / 1_000) + 1;
  if (pointCount < TOUCH_MIN_CANONICAL_POINTS) {
    throw new Error("Normalized touch capture has insufficient duration");
  }

  const output = new Array<TouchSample>(pointCount);
  let cursor = 0;
  for (let index = 0; index < pointCount; index++) {
    const t = index === pointCount - 1 ? lastAt : firstAt + (index * durationMs) / (pointCount - 1);
    while (cursor + 1 < source.length && source[cursor + 1]!.t < t) cursor += 1;

    const left = source[cursor]!;
    const right = source[Math.min(cursor + 1, source.length - 1)]!;
    if (t === right.t) {
      output[index] = { ...right };
      continue;
    }
    const span = right.t - left.t;
    const fraction = span > 0 ? (t - left.t) / span : 0;
    output[index] = {
      t,
      x: left.x + (right.x - left.x) * fraction,
      y: left.y + (right.y - left.y) * fraction,
      pressure: left.pressure + (right.pressure - left.pressure) * fraction,
    };
  }
  return output;
}

export interface TouchRecorder {
  /** Most recent velocity magnitude (normalised units / s) for live UI feedback. */
  velocity: number;
  /** Push a normalised sample. Coordinates expected in [0, 1]. */
  push: (sample: TouchSample, curvePoint?: CurveTracePoint) => void;
  beginContact: () => void;
  endContact: () => void;
  fail: (message: string) => void;
  stop: () => TouchCapture;
  cancel: () => void;
}

export const startTouchRecording = (
  onVelocity?: (v: number) => void,
  projectionVersion = 0,
): TouchRecorder => {
  const samples: TouchSample[] = [];
  const compatibilitySamples: TouchSample[] = [];
  const curveTrace: CurveTracePoint[] = [];
  const startedAt = Date.now();
  let prev: TouchSample | null = null;
  let contactCount = 0;
  let contactActive = false;
  let failure: string | null = null;
  let pendingSample: TouchSample | null = null;
  let pendingCurvePoint: CurveTracePoint | null = null;
  let lastAcceptedAt: number | null = null;
  let latestSample: TouchSample | null = null;
  let latestReceivedAtMs = 0;
  let stopped = false;

  const normalizedTouch =
    getProjectionDefinition(projectionVersion).featurePipeline === "normalized-touch";

  const reject = (message: string): void => {
    failure ??= message;
  };

  const reportVelocity = (sample: TouchSample): void => {
    if (prev) {
      const dt = Math.max(1, sample.t - prev.t);
      const dx = sample.x - prev.x;
      const dy = sample.y - prev.y;
      onVelocity?.(Math.sqrt(dx * dx + dy * dy) / (dt / 1000));
    }
    prev = sample;
  };

  const appendLegacySample = (sample: TouchSample): void => {
    samples.push(sample);
    reportVelocity(sample);
  };

  const appendCompatibilitySample = (
    sample: TouchSample,
    curvePoint?: CurveTracePoint,
  ): boolean => {
    if (failure) return false;
    if (!contactActive) {
      reject("Normalized touch capture requires one continuous contact");
      return false;
    }
    if (![sample.t, sample.x, sample.y, sample.pressure].every(Number.isFinite)) {
      reject("Normalized touch capture contains a non-finite value");
      return false;
    }
    if (sample.x < 0 || sample.x > 1 || sample.y < 0 || sample.y > 1) {
      reject("Normalized touch coordinates must stay inside the unit surface");
      return false;
    }
    if (sample.pressure < 0 || sample.pressure > 1) {
      reject("Normalized touch pressure must stay inside the unit interval");
      return false;
    }
    if (sample.t < 0 || sample.t > MOBILE_CAPTURE_MAX_DURATION_MS) {
      reject("Normalized touch capture duration is outside the supported range");
      return false;
    }
    const last = pendingSample ?? compatibilitySamples[compatibilitySamples.length - 1];
    if (last && sample.t < last.t) {
      reject("Normalized touch timestamps must be monotonic");
      return false;
    }
    if (lastAcceptedAt !== null && sample.t - lastAcceptedAt < TOUCH_MIN_INPUT_INTERVAL_MS) {
      pendingSample = sample;
      pendingCurvePoint = curvePoint ?? null;
      return true;
    }
    if (compatibilitySamples.length >= MOBILE_MAX_SOURCE_SAMPLES) {
      reject("Normalized touch capture exceeded the source sample limit");
      return false;
    }
    compatibilitySamples.push(sample);
    if (curvePoint) curveTrace.push(curvePoint);
    pendingSample = null;
    pendingCurvePoint = null;
    lastAcceptedAt = sample.t;
    reportVelocity(sample);
    return true;
  };

  const appendCanonicalSourceSample = (sample: TouchSample): void => {
    const last = samples[samples.length - 1];
    if (last && sample.t < last.t) {
      reject("Normalized touch sampling clock moved backwards");
      return;
    }
    if (last && sample.t === last.t) {
      samples[samples.length - 1] = sample;
      return;
    }
    if (samples.length >= MOBILE_MAX_SOURCE_SAMPLES) {
      reject("Normalized touch capture exceeded the source sample limit");
      return;
    }
    samples.push(sample);
  };

  const appendHeldPoint = (): void => {
    if (!normalizedTouch || !contactActive || !latestSample) return;
    const elapsed = performance.now() - latestReceivedAtMs;
    const t = Math.min(MOBILE_CAPTURE_MAX_DURATION_MS, latestSample.t + Math.max(0, elapsed));
    appendCanonicalSourceSample({ ...latestSample, t });
  };

  const samplingTimer = normalizedTouch ? setInterval(appendHeldPoint, 1_000 / 60) : null;

  const recorder: TouchRecorder = {
    velocity: 0,
    push(sample, curvePoint) {
      if (stopped) return;
      if (!normalizedTouch) {
        appendLegacySample(sample);
        return;
      }
      if (!appendCompatibilitySample(sample, curvePoint)) return;
      latestSample = sample;
      latestReceivedAtMs = performance.now();
      if (samples.length === 0) appendCanonicalSourceSample(sample);
    },
    beginContact() {
      if (stopped) return;
      if (!normalizedTouch) return;
      contactCount += 1;
      if (contactCount > 1 || contactActive) {
        reject("Normalized touch capture requires one continuous contact");
      }
      contactActive = true;
    },
    endContact() {
      if (stopped) return;
      if (!normalizedTouch) return;
      appendHeldPoint();
      contactActive = false;
    },
    fail(message) {
      if (stopped) return;
      reject(message);
    },
    stop() {
      if (stopped) throw new Error("Touch capture has already stopped");
      stopped = true;
      if (samplingTimer) clearInterval(samplingTimer);
      appendHeldPoint();
      if (normalizedTouch && contactCount !== 1) {
        reject("Normalized touch capture requires one continuous contact");
      }
      if (failure) throw new Error(failure);
      if (normalizedTouch && pendingSample) {
        if (compatibilitySamples.length < MOBILE_MAX_SOURCE_SAMPLES) {
          compatibilitySamples.push(pendingSample);
          if (pendingCurvePoint) curveTrace.push(pendingCurvePoint);
        } else {
          compatibilitySamples[compatibilitySamples.length - 1] = pendingSample;
          if (pendingCurvePoint && curveTrace.length > 0) {
            curveTrace[curveTrace.length - 1] = pendingCurvePoint;
          }
        }
        pendingSample = null;
        pendingCurvePoint = null;
      }
      const durationMs = Date.now() - startedAt;
      if (!normalizedTouch) return { samples, durationMs };
      return {
        samples: canonicalizeTouchSamples(samples, projectionVersion),
        compatibilitySamples: compatibilitySamples.map((sample) => ({ ...sample })),
        curveTrace: curveTrace.map((point) => ({ ...point })),
        durationMs,
      };
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      if (samplingTimer) clearInterval(samplingTimer);
      samples.length = 0;
      compatibilitySamples.length = 0;
      curveTrace.length = 0;
      prev = null;
      pendingSample = null;
      pendingCurvePoint = null;
      latestSample = null;
    },
  };
  return recorder;
};
