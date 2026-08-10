import { extractFeatures } from "../index";
import { extractMotionFeatures } from "../kinematic";
import type { SensorData } from "@/sensor/types";

describe("mobile modality selection", () => {
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
});
