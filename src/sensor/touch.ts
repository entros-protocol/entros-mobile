// Touch capture. Backed by react-native-gesture-handler PanGesture in the
// capture screen — this module is a thin recorder that the gesture callback
// pushes samples into. Coordinates are normalised to [0, 1] relative to the
// trace canvas before they reach this module so raw pixel positions never
// leave the gesture handler.
//
// PRIVACY: samples held in memory, discarded after extraction.

import { TouchCapture, TouchSample } from "./types";

export interface TouchRecorder {
  /** Most recent velocity magnitude (normalised units / s) for live UI feedback. */
  velocity: number;
  /** Push a normalised sample. Coordinates expected in [0, 1]. */
  push: (sample: TouchSample) => void;
  stop: () => TouchCapture;
}

export const startTouchRecording = (onVelocity?: (v: number) => void): TouchRecorder => {
  const samples: TouchSample[] = [];
  const startedAt = Date.now();
  let prev: TouchSample | null = null;

  return {
    velocity: 0,
    push(sample) {
      samples.push(sample);
      if (prev) {
        const dt = Math.max(1, sample.t - prev.t);
        const dx = sample.x - prev.x;
        const dy = sample.y - prev.y;
        const v = Math.sqrt(dx * dx + dy * dy) / (dt / 1000);
        onVelocity?.(v);
      }
      prev = sample;
    },
    stop() {
      const durationMs = Date.now() - startedAt;
      return { samples, durationMs };
    },
  };
};
