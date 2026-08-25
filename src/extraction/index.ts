// Extraction entry point. Adapts mobile sensor capture types to the
// pulse-sdk-shaped types expected by the ported extractors, then runs the
// same 308-element feature pipeline as the web SDK (170 audio + 81 motion +
// 57 touch). This said 134 until 2026-08-01, long after the v3 port landed,
// and the stale figure was read back as fact when deciding whether a defect
// in this file could reach the validator.
//
// Cross-platform reproducibility (Stage 3): identical inputs on web and
// mobile must produce identical raw feature vectors. The adapter sets
// touch width/height = 1 by default (mobile gesture handler does not
// expose contact area), so the area block in extractTouchFeatures
// degenerates to a constant — consistent across platforms when the
// fixture pre-populates the same width/height.
//
// PRIVACY: extractFeatures is the LAST function that ever sees raw audio
// PCM, motion samples, and touch coordinates. Callers must drop their
// references to the input SensorData immediately after this returns.

import type {
  SensorData as MobileSensorData,
  AudioCapture as MobileAudioCapture,
  MotionSample as MobileMotionSample,
  TouchSample as MobileTouchSample,
} from "@/sensor/types";

import { extractSpeakerFeaturesDetailed, SPEAKER_FEATURE_COUNT } from "./speaker";
import {
  extractMotionFeatures,
  extractTouchFeatures,
  extractMouseDynamics,
  extractAccelerationMagnitude,
} from "./kinematic";
import { fuseFeatures, fuseRawFeatures } from "./statistics";
import { yieldToMainThread } from "../lib/yield";
import type { AudioCapture, MotionSample, TouchSample, ExtractedFeatures } from "./types";

// Mirror pulse-sdk's data-quality thresholds so the same validation
// rules apply on both web and mobile.
export const MIN_AUDIO_SAMPLES = 16_000; // ~1s at 16kHz
export const MIN_MOTION_SAMPLES = 10;
export const MIN_TOUCH_SAMPLES = 10;

const adaptAudio = (cap: MobileAudioCapture): AudioCapture => ({
  samples: cap.pcm,
  sampleRate: cap.sampleRate,
  duration: cap.durationMs / 1000,
  windowStartMs: cap.startedAt,
  windowEndMs: cap.startedAt + cap.durationMs,
});

/**
 * `epochMs` converts motion's capture-relative `t` to the absolute `Date.now()`
 * domain audio reports its window in. Both sensors already stamp `Date.now()`
 * at start, and each counted from its own, so neither could be placed against
 * the other. Recording starts motion one `await` before audio, so the offset is
 * real rather than notional.
 *
 * No feature moves as a result. Every consumer of `timestamp` reads differences
 * only: `sampleRateFromTimestamps`, `captureDurationSec` and the inter-sample
 * gaps in `computeMotionV2`. Touch is deliberately left capture-relative,
 * because nothing correlates it against audio.
 */
const adaptMotion = (samples: MobileMotionSample[], epochMs: number): MotionSample[] =>
  samples.map((s) => ({
    timestamp: epochMs + s.t,
    ax: s.ax,
    ay: s.ay,
    az: s.az,
    gx: s.gx,
    gy: s.gy,
    gz: s.gz,
  }));

const adaptTouch = (samples: MobileTouchSample[]): TouchSample[] =>
  samples.map((s) => ({
    timestamp: s.t,
    x: s.x,
    y: s.y,
    pressure: s.pressure,
    // Mobile gesture handler does not expose contact area. Setting
    // width = height = 1 collapses the area block in extractTouchFeatures
    // to a constant — reproducible across platforms when fixture data
    // pre-populates the same defaults.
    width: 1,
    height: 1,
  }));

/**
 * Extract the raw + normalised feature vectors from a captured session.
 * Mirrors pulse.ts:extractFeatures() bit-for-bit so SimHash commitments
 * stay reproducible across web and mobile.
 */
export async function extractFeatures(
  sensorData: MobileSensorData,
  projectionVersion = 0,
): Promise<ExtractedFeatures> {
  const audio = adaptAudio(sensorData.audio);
  const motion = adaptMotion(sensorData.motion.samples, sensorData.motion.startedAt);
  const touch = adaptTouch(sensorData.touch.samples);

  const { features: audioFeatures, f0Contour } = await extractSpeakerFeaturesDetailed(
    audio,
    projectionVersion,
  );
  // The audio path is the dominant cost. Yield once it's done so the
  // verify UI gets a paint frame before motion/touch extraction resumes
  // the JS-thread work.
  await yieldToMainThread();

  const hasMotion = motion.length >= MIN_MOTION_SAMPLES;
  const hasTouch = touch.length >= MIN_TOUCH_SAMPLES;

  const motionFeatures =
    projectionVersion >= 1
      ? hasMotion
        ? extractMotionFeatures(motion, projectionVersion)
        : extractMouseDynamics(touch, projectionVersion)
      : hasMotion && hasTouch
        ? extractMouseDynamics(touch, projectionVersion)
        : hasMotion
          ? extractMotionFeatures(motion, projectionVersion)
          : extractMouseDynamics(touch, projectionVersion);
  await yieldToMainThread();

  const touchFeatures = extractTouchFeatures(touch, projectionVersion);
  await yieldToMainThread();

  // Resampled onto the exact stretch of wall-clock time the transmitted audio
  // covers, so the validator's cross-correlation compares two views of one
  // moment. Empty if motion is absent, F0 produced no frames, or motion does
  // not span enough of the audio window.
  const accelMagnitude =
    hasMotion && f0Contour.length > 0
      ? extractAccelerationMagnitude(motion, f0Contour.length, {
          startMs: audio.windowStartMs,
          endMs: audio.windowEndMs,
        })
      : [];

  return {
    raw: fuseRawFeatures(audioFeatures, motionFeatures, touchFeatures),
    normalized: fuseFeatures(audioFeatures, motionFeatures, touchFeatures),
    f0Contour,
    accelMagnitude,
  };
}

/** Derive schema 4 evidence from the same bounded projection 2 capture. */
export async function extractProjectionOneCompatibilityFeatures(
  sensorData: MobileSensorData,
  primaryRawFeatures: number[],
): Promise<number[]> {
  const compatibilitySamples = sensorData.touch.compatibilitySamples;
  if (!compatibilitySamples || compatibilitySamples.length < MIN_TOUCH_SAMPLES) {
    throw new Error("Projection 2 baseline changes require projection 1 compatibility capture");
  }

  const motion = adaptMotion(sensorData.motion.samples, sensorData.motion.startedAt);
  const touch = adaptTouch(compatibilitySamples);
  const motionFeatures =
    motion.length >= MIN_MOTION_SAMPLES
      ? extractMotionFeatures(motion, 1)
      : extractMouseDynamics(touch, 1);
  await yieldToMainThread();
  const touchFeatures = extractTouchFeatures(touch, 1);
  await yieldToMainThread();

  return fuseRawFeatures(
    primaryRawFeatures.slice(0, SPEAKER_FEATURE_COUNT),
    motionFeatures,
    touchFeatures,
  );
}

export {
  SPEAKER_FEATURE_COUNT,
  extractSpeakerFeaturesDetailed,
  extractMotionFeatures,
  extractTouchFeatures,
  extractMouseDynamics,
  extractAccelerationMagnitude,
  fuseFeatures,
  fuseRawFeatures,
};
export type { ExtractedFeatures, AudioCapture, MotionSample, TouchSample } from "./types";
