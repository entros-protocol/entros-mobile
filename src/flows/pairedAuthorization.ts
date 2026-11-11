// Gets the wallet's authorization for paired sessions before a capture starts.
//
// The relayer opens and finalizes a paired session only for the wallet's
// owner. The wallet signs one challenge from the relayer, and that signature
// serves every session of the visit until it expires. This step runs before
// the recorder starts, so no capture is in progress when the wallet app opens.
//
// PRIVACY: the request names the wallet. The signed message holds the wallet,
// the relayer's challenge and an expiry, and nothing from a capture.

import {
  pairedAuthorizationMessage,
  pairedAuthorizationUsable,
  readPairedClock,
  signedPairedAuthorization,
  type PairedAuthorization,
  type PairedClockReading,
} from "@/paired";
import { parseSubmitError } from "@/protocol/errors";
import { PairedServiceError, type PairedFailure } from "@/services/pairedErrors";
import {
  requestPairedAuthorizationGrant,
  type GrantedPairedAuthorization,
} from "@/services/pairedExecutor";
import {
  holdPairedAuthorization,
  usablePairedAuthorization,
} from "@/state/pairedAuthorizationBuffer";
import * as mwa from "@/wallet/mwa";
import type { WalletSession } from "@/wallet/session";

export type PairedAuthorizationOutcome =
  /** `authorization` is null when the relayer asks for none. */
  | { kind: "ready"; authorization: PairedAuthorization | null }
  /** The person declined the request in the wallet. */
  | { kind: "declined" }
  /** The wallet could not sign for another reason. `message` is the wallet's own. */
  | { kind: "wallet-failed"; message: string }
  /** The wallet never answered the prompt. */
  | { kind: "wallet-unresponsive" }
  /** The signature arrived after the authorization stopped being usable. */
  | { kind: "expired" }
  /** The relayer could not be reached or refused the grant. */
  | { kind: "failed"; failure: PairedFailure };

export interface PairedAuthorizationDeps {
  requestGrant?: (wallet: string) => Promise<GrantedPairedAuthorization>;
  signMessage?: typeof mwa.signMessage;
  /** Reads the clocks the authorization's lifetime counts on. */
  now?: () => PairedClockReading;
}

/**
 * Returns the authorization the app already holds for the wallet, or has the
 * wallet sign a new one and holds it. A relayer without the authorization
 * route asks for none, so the session opens without one.
 */
export async function ensurePairedAuthorization(
  wallet: WalletSession,
  {
    requestGrant = requestPairedAuthorizationGrant,
    signMessage = mwa.signMessage,
    now = readPairedClock,
  }: PairedAuthorizationDeps = {},
): Promise<PairedAuthorizationOutcome> {
  const held = usablePairedAuthorization(wallet.address, now());
  if (held) return { kind: "ready", authorization: held };

  let granted: GrantedPairedAuthorization;
  try {
    granted = await requestGrant(wallet.address);
  } catch (error) {
    if (!(error instanceof PairedServiceError)) throw error;
    if (error.failure.status === 404) return { kind: "ready", authorization: null };
    return { kind: "failed", failure: error.failure };
  }

  const { grant, requestedAt } = granted;
  const message = new TextEncoder().encode(
    pairedAuthorizationMessage(wallet.address, grant.challenge, grant.expiresAt),
  );
  let signed: mwa.SignMessageResult;
  try {
    signed = await signMessage(
      wallet.authToken,
      message,
      wallet.address,
      wallet.kind,
      undefined,
      wallet.acceptRotated,
    );
  } catch (error) {
    const { kind, raw } = parseSubmitError(error);
    if (kind === "wallet-rejected") return { kind: "declined" };
    // The prompt times out well before any accepted grant leaves its margin,
    // so a timeout means the wallet did not answer.
    if (kind === "wallet-timeout") return { kind: "wallet-unresponsive" };
    return { kind: "wallet-failed", message: raw };
  }
  wallet.adopt(signed.authToken);

  const authorization = signedPairedAuthorization(
    wallet.address,
    grant,
    signed.signature,
    requestedAt,
  );
  // A prompt left open for most of the lifetime leaves too little to open with.
  if (!pairedAuthorizationUsable(authorization, wallet.address, now())) {
    return { kind: "expired" };
  }
  holdPairedAuthorization(authorization);
  return { kind: "ready", authorization };
}
