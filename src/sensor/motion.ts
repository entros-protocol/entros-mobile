// Motion capture via expo-sensors. Subscribes to Accelerometer + Gyroscope
// at ~60Hz and accumulates samples in memory. Each tick fuses the latest
// gyro reading with the accelerometer event so the kinematic extractor sees
// the same DeviceMotionEvent-shaped 6-axis sample the browser produces.
//
// PRIVACY: samples held in memory, discarded after extraction.

import { Accelerometer, Gyroscope } from "expo-sensors";

import { MotionCapture, MotionSample } from "./types";

const SAMPLE_INTERVAL_MS = 16; // ~62.5 Hz target

type SensorSubscription = ReturnType<typeof Accelerometer.addListener>;

export interface MotionRecorder {
  stop: () => Promise<MotionCapture>;
  cancel: () => Promise<void>;
}

export const isMotionAvailable = async (): Promise<boolean> => {
  try {
    const [accelOk, gyroOk] = await Promise.all([
      Accelerometer.isAvailableAsync(),
      Gyroscope.isAvailableAsync(),
    ]);
    return accelOk && gyroOk;
  } catch {
    return false;
  }
};

export const startMotionRecording = async (
  onMagnitude?: (m: number) => void,
): Promise<MotionRecorder> => {
  Accelerometer.setUpdateInterval(SAMPLE_INTERVAL_MS);
  Gyroscope.setUpdateInterval(SAMPLE_INTERVAL_MS);

  const samples: MotionSample[] = [];
  const startedAt = Date.now();
  let latestGyro = { x: 0, y: 0, z: 0 };

  const accelSub: SensorSubscription = Accelerometer.addListener((data) => {
    samples.push({
      t: Date.now() - startedAt,
      ax: data.x,
      ay: data.y,
      az: data.z,
      gx: latestGyro.x,
      gy: latestGyro.y,
      gz: latestGyro.z,
    });
    if (onMagnitude) {
      onMagnitude(Math.sqrt(data.x * data.x + data.y * data.y + data.z * data.z));
    }
  });
  const gyroSub: SensorSubscription = Gyroscope.addListener((data) => {
    latestGyro = data;
  });

  const teardown = () => {
    accelSub.remove();
    gyroSub.remove();
  };

  return {
    stop: async () => {
      teardown();
      const durationMs = Date.now() - startedAt;
      const sampleRate = durationMs > 0 ? (samples.length * 1000) / durationMs : 0;
      return { samples, sampleRate, durationMs, startedAt };
    },
    cancel: async () => {
      teardown();
      samples.length = 0;
    },
  };
};
