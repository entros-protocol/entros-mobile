// The wallet's signed authorization for paired sessions, held in memory for
// the visit.
//
// Unlike the capture buffers, a read does not clear it: one signature serves
// every paired session of the wallet until the authorization expires. It is
// never persisted, so a restarted app asks the wallet again.

import {
  pairedAuthorizationUsable,
  readPairedClock,
  type PairedAuthorization,
  type PairedClockReading,
} from "@/paired";

let held: PairedAuthorization | null = null;

export const holdPairedAuthorization = (authorization: PairedAuthorization): void => {
  held = authorization;
};

/** The held authorization while it can still open a session for `wallet`. */
export const usablePairedAuthorization = (
  wallet: string,
  now: PairedClockReading = readPairedClock(),
): PairedAuthorization | null => (pairedAuthorizationUsable(held, wallet, now) ? held : null);

/**
 * Drops the held authorization. With a wallet and a challenge, only when the
 * held one is that wallet's and carries that challenge, so a refusal of an
 * earlier authorization never drops a newer one.
 */
export function dropPairedAuthorization(): void;
export function dropPairedAuthorization(wallet: string, challenge: string): void;
export function dropPairedAuthorization(wallet?: string, challenge?: string): void {
  if (wallet === undefined || (held?.wallet === wallet && held.challenge === challenge)) {
    held = null;
  }
}
