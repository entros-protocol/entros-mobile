// In-memory handoff slot for a paired session whose three rounds the server
// accepted, from /verify/rounds to /verify/processing.
//
// Mirrors captureBuffer.ts semantics: module-level, take-and-clear, never
// persisted, never serialised.
//
// PRIVACY:
// - The slot holds the committed PCM16 segments, motion samples and pressed
//   touch samples for only the moment it takes the processing screen to
//   mount and call `takePairedSession()`.
// - The processing screen MUST call `clearPairedSession()` on unmount so the
//   slot never survives into the next verification attempt.

import type { CompletedPairedRounds } from "@/flows/pairedSession";
import type { MotionCapture, TouchCapture } from "@/sensor/types";

export interface PairedSessionHandoff {
  rounds: CompletedPairedRounds;
  motion: MotionCapture;
  touch: TouchCapture;
}

let pending: PairedSessionHandoff | null = null;

export const setPairedSession = (session: PairedSessionHandoff): void => {
  pending = session;
};

export const takePairedSession = (): PairedSessionHandoff | null => {
  const session = pending;
  pending = null;
  return session;
};

export const clearPairedSession = (): void => {
  pending = null;
};
