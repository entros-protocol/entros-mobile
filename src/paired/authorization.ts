// The wallet's authorization for paired sessions.
//
// A paired open and a paired finalize both name a wallet. The relayer serves
// them only for the wallet's owner, so the wallet signs one challenge from the
// relayer and the app sends that signed authorization with every open and
// finalize until it expires. One signature covers a whole visit.
//
// Mirrors pulse-sdk/src/paired/authorization.ts. The signed message and the
// wire fields must stay identical to it and to the relayer's.

import { bytesToHex } from "@noble/hashes/utils.js";

import { isRecord } from "@/lib/values";

import { PairedClientError } from "./client";

/**
 * An authorization with less than this left is treated as absent, so no
 * capture starts on one that expires before the session opens.
 */
export const PAIRED_AUTHORIZATION_MARGIN_MS = 120_000;

/** The longest lifetime a relayer may give an authorization. */
const MAX_LIFETIME_SECS = 3_600;
const SIGNATURE_BYTES = 64;
const BASE58_WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** What the relayer issues for the wallet to sign. */
export interface PairedAuthorizationGrant {
  challenge: string;
  expiresAt: number;
  expiresInSecs: number;
  origin: string;
  mac: string;
}

/**
 * One reading of both clocks. `performance.now()` can stop while the device
 * sleeps, so elapsed time is the larger of the two deltas. A wall clock that
 * is off by a constant cancels out of its delta, and one that moved backwards
 * gives a negative delta that loses to the monotonic one.
 */
export interface PairedClockReading {
  readonly monotonicMs: number;
  readonly wallMs: number;
}

export const readPairedClock = (): PairedClockReading => ({
  monotonicMs: performance.now(),
  wallMs: Date.now(),
});

/** Time between two readings, never less than the monotonic delta. */
export const pairedElapsedMs = (from: PairedClockReading, to: PairedClockReading): number =>
  Math.max(to.monotonicMs - from.monotonicMs, to.wallMs - from.wallMs);

/** A grant the wallet has signed. */
export interface PairedAuthorization {
  /** The wallet it authorizes, in base58. */
  readonly wallet: string;
  readonly challenge: string;
  readonly expiresAt: number;
  readonly origin: string;
  readonly mac: string;
  readonly signatureHex: string;
  /** How long the relayer accepts it at open, counted from `requestedAt`. */
  readonly lifetimeMs: number;
  /** Both clocks, read before the grant was requested. */
  readonly requestedAt: PairedClockReading;
}

/** The `authorization` object of an open or a finalize request. */
export interface PairedAuthorizationBody {
  challenge: string;
  expires_at: number;
  origin: string;
  mac: string;
  signature_hex: string;
}

/** The plain-language block a wallet shows above the signed fields. */
const MESSAGE_PREAMBLE =
  "Entros verification\n" +
  "Sign to start verification sessions for this wallet. The authorization expires within the hour. It moves no funds and approves no transaction.";

/**
 * The text the wallet signs. The app builds it from the grant's fields and
 * never signs text a server supplies whole.
 */
export function pairedAuthorizationMessage(
  wallet: string,
  challenge: string,
  expiresAt: number,
): string {
  return `${MESSAGE_PREAMBLE}\n\nEntros-Paired-Open-v1\nwallet:${wallet}\nchallenge:${challenge}\nexpires:${expiresAt}`;
}

const isLowerHex = (value: unknown, bytes: number): value is string =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function invalid(field: string): PairedClientError {
  return new PairedClientError("invalid_response", "malformed_response", { field });
}

/** Reads a grant and refuses any field outside its fixed form. */
export function parsePairedAuthorizationGrant(value: unknown): PairedAuthorizationGrant {
  if (!isRecord(value)) throw invalid("authorization");
  const { challenge, origin, mac, expires_at: expiresAt, expires_in: expiresIn } = value;
  if (!isLowerHex(challenge, 32)) throw invalid("authorization.challenge");
  if (!isLowerHex(origin, 16)) throw invalid("authorization.origin");
  if (!isLowerHex(mac, 32)) throw invalid("authorization.mac");
  if (!isPositiveInteger(expiresAt)) throw invalid("authorization.expires_at");
  // A lifetime inside the margin is unusable from the moment it arrives.
  if (
    !isPositiveInteger(expiresIn) ||
    expiresIn > MAX_LIFETIME_SECS ||
    expiresIn * 1_000 <= PAIRED_AUTHORIZATION_MARGIN_MS
  ) {
    throw invalid("authorization.expires_in");
  }
  return { challenge, expiresAt, expiresInSecs: expiresIn, origin, mac };
}

/**
 * The authorization a wallet's signature over a grant makes. `requestedAt`
 * holds the readings from before the grant was requested, so the lifetime the
 * app counts never runs past the one the relayer counts.
 */
export function signedPairedAuthorization(
  wallet: string,
  grant: PairedAuthorizationGrant,
  signature: Uint8Array,
  requestedAt: PairedClockReading,
): PairedAuthorization {
  if (!BASE58_WALLET.test(wallet)) throw new RangeError("The wallet must be a base58 address.");
  if (signature.length !== SIGNATURE_BYTES) {
    throw new RangeError("A wallet signature holds 64 bytes.");
  }
  return {
    wallet,
    challenge: grant.challenge,
    expiresAt: grant.expiresAt,
    origin: grant.origin,
    mac: grant.mac,
    signatureHex: bytesToHex(signature),
    lifetimeMs: grant.expiresInSecs * 1_000,
    requestedAt: { monotonicMs: requestedAt.monotonicMs, wallMs: requestedAt.wallMs },
  };
}

export function pairedAuthorizationBody(
  authorization: PairedAuthorization,
): PairedAuthorizationBody {
  return {
    challenge: authorization.challenge,
    expires_at: authorization.expiresAt,
    origin: authorization.origin,
    mac: authorization.mac,
    signature_hex: authorization.signatureHex,
  };
}

/** True while `authorization` is for `wallet` and has more than the margin left. */
export function pairedAuthorizationUsable(
  authorization: PairedAuthorization | null | undefined,
  wallet: string,
  now: PairedClockReading,
): authorization is PairedAuthorization {
  return (
    !!authorization &&
    authorization.wallet === wallet &&
    authorization.lifetimeMs - pairedElapsedMs(authorization.requestedAt, now) >=
      PAIRED_AUTHORIZATION_MARGIN_MS
  );
}

/** True for a refusal that means the wallet must sign a new authorization. */
export function isPairedAuthorizationRefusal(reason: string | undefined): boolean {
  return reason === "authorization_required" || reason === "authorization_invalid";
}
