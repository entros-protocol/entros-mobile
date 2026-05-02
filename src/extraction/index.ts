// Extraction entry point. Adapts mobile sensor capture types to the
// pulse-sdk-shaped types expected by the ported extractors, then runs the
// same 134-element feature pipeline as the web SDK.
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
});

const adaptMotion = (samples: MobileMotionSample[]): MotionSample[] =>
  samples.map((s) => ({
    timestamp: s.t,
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
export async function extractFeatures(sensorData: MobileSensorData): Promise<ExtractedFeatures> {
  const audio = adaptAudio(sensorData.audio);
  const motion = adaptMotion(sensorData.motion.samples);
  const touch = adaptTouch(sensorData.touch.samples);

  const { features: audioFeatures, f0Contour } = await extractSpeakerFeaturesDetailed(audio);
  // The audio path is the dominant cost. Yield once it's done so the
  // verify UI gets a paint frame before motion/touch extraction resumes
  // the JS-thread work.
  await yieldToMainThread();

  const hasMotion = motion.length >= MIN_MOTION_SAMPLES;
  const hasTouch = touch.length >= MIN_TOUCH_SAMPLES;

  // Same branch logic as pulse.ts. When both modalities are present,
  // mouse-dynamics on the touch path takes precedence — IMU still
  // contributes via the cross-modal accel_magnitude time series below.
  const motionFeatures =
    hasMotion && hasTouch
      ? extractMouseDynamics(touch)
      : hasMotion
        ? extractMotionFeatures(motion)
        : extractMouseDynamics(touch);
  await yieldToMainThread();

  const touchFeatures = extractTouchFeatures(touch);
  await yieldToMainThread();

  const accelMagnitude =
    hasMotion && f0Contour.length > 0 ? extractAccelerationMagnitude(motion, f0Contour.length) : [];

  return {
    raw: fuseRawFeatures(audioFeatures, motionFeatures, touchFeatures),
    normalized: fuseFeatures(audioFeatures, motionFeatures, touchFeatures),
    f0Contour,
    accelMagnitude,
  };
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
