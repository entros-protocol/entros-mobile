// In-memory handoff slot for the server-issued challenge that flows from
// /verify/intro (where it's fetched) to /verify/capture (peeks the phrase
// for display) and on to /verify/processing (Stage 7 will take the nonce
// for the on-chain create_challenge instruction).
//
// Mirrors captureBuffer.ts / commitmentBuffer.ts semantics: module-level,
// never persisted, never serialised. peek leaves the slot intact so capture
// and the later create_challenge can both see the same nonce; take clears
// for the eventual single-consumer Stage 7 wiring.
//
// PRIVACY:
// - The phrase is drawn from the executor's curated neutral-vocabulary
//   English dictionary; it carries no personal content. The nonce is a
//   32-byte CSPRNG draw bound to the wallet.
// - Both fields are public on-the-wire (the wallet pubkey + phrase already
//   travel through the executor's logs); no encryption needed at this
//   layer.

export interface PendingChallenge {
  nonce: Uint8Array;
  phrase: string;
}

let pending: PendingChallenge | null = null;

export const setChallenge = (challenge: PendingChallenge): void => {
  pending = challenge;
};

export const peekChallenge = (): PendingChallenge | null => pending;

export const takeChallenge = (): PendingChallenge | null => {
  const challenge = pending;
  pending = null;
  return challenge;
};

export const clearChallenge = (): void => {
  pending = null;
};
