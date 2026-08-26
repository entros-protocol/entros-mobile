import { extractFeatures, extractProjectionOneCompatibilityFeatures } from "../index";
import { extractMotionFeatures, extractTouchFeatures } from "../kinematic";
import { fuseRawFeatures } from "../statistics";
import type { SensorData } from "@/sensor/types";

describe("mobile modality selection", () => {
  it("does not use the native readback rate for canonical PCM extraction", async () => {
    const startedAt = 500;
    const pcm = Float32Array.from({ length: 16_384 }, (_, index) =>
      Math.sin((2 * Math.PI * 220 * index) / 48_000),
    );
    const touchSamples = Array.from({ length: 24 }, (_, index) => ({
      t: index * 20,
      x: index / 24,
      y: 0.5,
      pressure: 0.5,
    }));
    const capture: SensorData = {
      audio: {
        pcm,
        sampleRate: 16_000,
        nativeSampleRate: 16_000,
        durationMs: (pcm.length / 16_000) * 1_000,
        startedAt,
      },
      motion: { samples: [], sampleRate: 0, durationMs: 0, startedAt },
      touch: { samples: touchSamples, durationMs: 460 },
    };
    const alternateNativeRateCapture: SensorData = {
      ...capture,
      audio: {
        ...capture.audio,
        nativeSampleRate: 48_000,
      },
    };

    const defaultNativeRateFeatures = await extractFeatures(capture, 2);
    const alternateNativeRateFeatures = await extractFeatures(alternateNativeRateCapture, 2);

    expect(alternateNativeRateFeatures.raw.slice(0, 170)).toEqual(
      defaultNativeRateFeatures.raw.slice(0, 170),
    );
  });

  it("uses accelerometer features when touch is present too", async () => {
    const startedAt = 1_000;
    const motionSamples = Array.from({ length: 24 }, (_, index) => ({
      t: index * 20,
      ax: Math.sin(index * 0.2),
      ay: Math.cos(index * 0.2),
      az: 9.8 + Math.sin(index * 0.1) * 0.1,
      gx: index * 0.001,
      gy: index * -0.002,
      gz: Math.sin(index * 0.3) * 0.02,
    }));
    const capture: SensorData = {
      audio: {
        pcm: new Float32Array(500),
        sampleRate: 16_000,
        nativeSampleRate: 16_000,
        durationMs: 31.25,
        startedAt,
      },
      motion: {
        samples: motionSamples,
        sampleRate: 50,
        durationMs: 460,
        startedAt,
      },
      touch: {
        samples: Array.from({ length: 24 }, (_, index) => ({
          t: index * 20,
          x: index / 24,
          y: Math.sin(index * 0.2) * 0.2 + 0.5,
          pressure: 0.5,
        })),
        durationMs: 460,
      },
    };

    const extracted = await extractFeatures(capture, 1);
    const adaptedMotion = motionSamples.map((sample) => ({
      timestamp: startedAt + sample.t,
      ax: sample.ax,
      ay: sample.ay,
      az: sample.az,
      gx: sample.gx,
      gy: sample.gy,
      gz: sample.gz,
    }));

    expect(extracted.raw.slice(170, 251)).toEqual(extractMotionFeatures(adaptedMotion, 1));
  });

  it("derives projection 1 compatibility evidence from the retained source trace", async () => {
    const startedAt = 2_000;
    const motionSamples = Array.from({ length: 24 }, (_, index) => ({
      t: index * 20,
      ax: index / 10,
      ay: index / 20,
      az: 9.8,
      gx: 0.01,
      gy: 0.02,
      gz: 0.03,
    }));
    const compatibilitySamples = Array.from({ length: 24 }, (_, index) => ({
      t: index * 20,
      x: index / 24,
      y: 1 - index / 48,
      pressure: 0.5,
    }));
    const capture: SensorData = {
      audio: {
        pcm: new Float32Array(500),
        sampleRate: 16_000,
        nativeSampleRate: 16_000,
        durationMs: 31.25,
        startedAt,
      },
      motion: { samples: motionSamples, sampleRate: 50, durationMs: 460, startedAt },
      touch: {
        samples: compatibilitySamples.filter((_, index) => index % 2 === 0),
        compatibilitySamples,
        durationMs: 460,
      },
    };
    const primary = Array.from({ length: 308 }, (_, index) => index / 100);
    const evidence = await extractProjectionOneCompatibilityFeatures(capture, primary);
    const adaptedMotion = motionSamples.map((sample) => ({
      timestamp: startedAt + sample.t,
      ax: sample.ax,
      ay: sample.ay,
      az: sample.az,
      gx: sample.gx,
      gy: sample.gy,
      gz: sample.gz,
    }));
    const adaptedTouch = compatibilitySamples.map((sample) => ({
      timestamp: sample.t,
      x: sample.x,
      y: sample.y,
      pressure: sample.pressure,
      width: 1,
      height: 1,
    }));
    expect(evidence).toEqual(
      fuseRawFeatures(
        primary.slice(0, 170),
        extractMotionFeatures(adaptedMotion, 1),
        extractTouchFeatures(adaptedTouch, 1),
      ),
    );
    expect(evidence.slice(0, 170)).toEqual(primary.slice(0, 170));
  });
});
