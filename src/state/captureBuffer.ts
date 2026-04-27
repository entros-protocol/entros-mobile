// In-memory handoff slot for the captured SensorData between the
// /verify/capture and /verify/processing screens.
//
// PRIVACY:
// - The buffer holds raw PCM, motion samples, and touch coordinates for
//   only the few hundred ms it takes the processing screen to mount and
//   call `takeCapture()`. Take-and-clear semantics.
// - Never serialised, never persisted, never read by any other screen.
// - On error the processing screen MUST call `clearCapture()` so the
//   buffer doesn't survive into the next verification attempt.

import type { SensorData } from "@/sensor/types";

let pending: SensorData | null = null;

export const setCapture = (data: SensorData): void => {
  pending = data;
};

export const takeCapture = (): SensorData | null => {
  const data = pending;
  pending = null;
  return data;
};

export const clearCapture = (): void => {
  pending = null;
};
