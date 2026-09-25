// In-memory handoff slot for the server-issued challenge that flows from
// /verify/intro (where it's fetched) to /verify/capture and processing.
//
// Mirrors captureBuffer.ts / commitmentBuffer.ts semantics: module-level,
// never persisted, never serialised. peek leaves the slot intact so capture
// and create_challenge can both see the same nonce. take clears the slot.
//
// PRIVACY:
// - The phrase is drawn from the executor's curated neutral-vocabulary
//   English dictionary; it carries no personal content. The nonce is a
//   32-byte CSPRNG draw bound to the wallet.
// - The app keeps the challenge in memory and never logs or persists it.

import type { LissajousParams } from "@/challenge/lissajous";

export interface PendingChallenge {
  nonce: Uint8Array;
  phrase: string;
  expiresIn: number;
  expiresAtMs: number;
  curve: LissajousParams;
  projectionVersion: number;
}

let pending: PendingChallenge | null = null;

export const setChallenge = (challenge: PendingChallenge): void => {
  pending = { ...challenge, nonce: challenge.nonce.slice(), curve: { ...challenge.curve } };
};

const clone = (challenge: PendingChallenge): PendingChallenge => ({
  ...challenge,
  nonce: challenge.nonce.slice(),
  curve: { ...challenge.curve },
});

export const peekChallenge = (): PendingChallenge | null => (pending ? clone(pending) : null);

export const takeChallenge = (): PendingChallenge | null => {
  const challenge = pending ? clone(pending) : null;
  pending = null;
  return challenge;
};

export const clearChallenge = (): void => {
  pending = null;
};
