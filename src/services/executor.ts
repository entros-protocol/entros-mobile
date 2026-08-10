// Typed HTTP client for the executor (challenge issuance + feature validation).
//
// The executor is the wallet-connected verify flow's server side: it issues
// a wallet-bound nonce + 5-word phrase via /challenge, then validates the
// captured 308-feature vector + cross-modal time-series + audio b64 via
// /validate-features. Wire format is the canonical one served by
// executor-node/src/{challenge,validation}/handler.rs.
//
// Errors-as-values for validateFeatures: the four error categories that the
// caller routes differently (soft-reject, rate-limited, service-down, hard
// failure) are returned as a discriminated union, not thrown. fetchChallenge
// is the single-failure-UX path (Alert + stay on /verify/intro), so it
// throws.
//
// Timeouts: 5 s for /challenge (small payload, cheap to fail-fast and
// retry); 15 s for /validate-features (Whisper-tiny inference adds ~1 s on
// warm path, more on Railway cold-start — matches pulse-sdk's window).
//
// PRIVACY: see src/sensor/types.ts for the audio b64 contract. This module
// only forwards what the caller assembled; it never logs values or retains
// references after the fetch resolves.

import { config } from "@/config";
import type { SignedReceiptDto } from "@/protocol/receipt";

import { reasonDisposition, type VerificationReason } from "./reasons";

const CHALLENGE_TIMEOUT_MS = 5_000;
// Must exceed the executor's own ceiling, not sit inside it. The executor
// waits up to VALIDATOR_REQUEST_TIMEOUT (20s) on the validation service and
// pads every timed response to HANDLER_MIN_DURATION (4s), so a legitimate
// two-pass validation can legitimately take past 24s.
//
// Aborting earlier does not cancel any of that. The executor has already
// recorded the wallet attempt and deducted quota by the time it calls the
// validator, and the refund only runs if the handler completes. A client that
// walks away at 15s therefore burns an attempt with no refund, and five of
// those lock the wallet out for an hour. The previous 15s was safe only while
// the executor's own ceiling was 8s.
const VALIDATE_TIMEOUT_MS = 45_000;

export interface ChallengeResponse {
  /** 32-byte server-issued nonce. Bound to the wallet in the executor's
   *  ChallengeNonceRegistry; consumed by the on-chain create_challenge
   *  instruction in Stage 7. */
  nonce: Uint8Array;
  /** 5-word phrase drawn from the executor's curated dictionary. The
   *  validation service looks this up by wallet+ttl during phrase binding;
   *  the mobile client only needs to display it. */
  phrase: string;
  /** Server-side TTL in seconds. Default 60 per executor config. */
  expiresIn: number;
}

/** Discriminated outcome of a /validate-features call. Which reasons are
 *  recoverable is not decided here: `reasonDisposition` from ./reasons is the
 *  only thing that classifies a label, so mobile and web cannot disagree about
 *  whether a given rejection offers a retry. This union is the mobile routing
 *  shape layered on top of that verdict.
 *
 *  - `ok`: validation passed; verify flow advances to ZK proof generation.
 *    When the validator has a signing key, `signedReceipt` carries the Ed25519
 *    receipt and `commitmentHex`/`saltHex` carry the SERVER-derived commitment
 *    + salt the client must adopt and mint (C2 — the client no longer chooses
 *    its own commitment). The first-verify path bundles the receipt as an
 *    Ed25519 prefix before `mint_anchor`; re-verify ignores the receipt
 *    (update_anchor binds via the VerificationResult PDA instead).
 *  - `soft-reject`: a `retry` reason; surface hint + Try Again
 *  - `rate-limited`: a cooldown is in force (executor 429, or a `wait` reason
 *    on any status); surface the countdown
 *  - `hard-reject`: the opaque attack-signal rejection. A 400 carrying no
 *    reason, an unrecognised one, or a `fatal` one.
 *  - `payload-too-large`: the executor refused the body unread (413). Its own
 *    kind rather than a `hard-reject` so the copy can say what happened, and
 *    so `hard-reject` keeps meaning what its line above says.
 *  - `quota-exhausted`: integrator API key out of quota (402)
 *  - `unauthorized`: API key missing/wrong (401) — config bug, surfaces generic
 *  - `timeout`: the request outlived VALIDATE_TIMEOUT_MS and we aborted it.
 *    Separate from `service-down` because the executor may be healthy and the
 *    upload merely slow, which makes "can't reach the service" a lie.
 *  - `service-down`: 5xx, or a transport failure that never became a response
 *  - `unknown`: anything else; logged status for triage */
export type ValidateOutcome =
  | {
      kind: "ok";
      remainingQuota: number | null;
      signedReceipt: SignedReceiptDto | null;
      commitmentHex: string | null;
      saltHex: string | null;
      compositeRiskScore: number | null;
    }
  | { kind: "soft-reject"; reason: VerificationReason }
  | { kind: "rate-limited"; retryAfterSec: number }
  | { kind: "hard-reject" }
  | { kind: "payload-too-large" }
  | { kind: "quota-exhausted" }
  | { kind: "unauthorized" }
  | { kind: "timeout" }
  | { kind: "service-down"; message: string }
  | { kind: "unknown"; status: number; message: string };

export interface ValidateInput {
  features: number[];
  projectionVersion: number;
  walletId: string;
  f0Contour?: number[];
  accelMagnitude?: number[];
  audioSamplesB64?: string;
  audioSampleRateHz?: number;
  /** Lowercase 64-char hex of the 32-byte Poseidon commitment. When present,
   *  the validator signs a (wallet, commitment, validated_at) receipt and
   *  returns it on the `ok` outcome for first-verify Ed25519 binding. */
  commitmentNewHex?: string;
  receiptPurpose?: "mint" | "rebaseline" | "reset";
}

/** Thrown when EXPO_PUBLIC_RELAYER_URL is not set. The intro screen
 *  surfaces this as a friendly Alert; reaching this in production is a
 *  build-config bug. */
export class ExecutorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorConfigError";
  }
}

interface RelayerConfig {
  baseUrl: string;
  apiKey: string | null;
}

const requireRelayer = (): RelayerConfig => {
  const baseUrl = config.relayerUrl;
  if (!baseUrl) {
    throw new ExecutorConfigError(
      "EXPO_PUBLIC_RELAYER_URL is not set. Copy .env.example to .env and fill in the executor URL.",
    );
  }
  return { baseUrl, apiKey: config.relayerApiKey };
};

/** Fetch a fresh nonce + phrase for the given wallet. Throws on network
 *  error, non-2xx, or a malformed response — the caller (/verify/intro)
 *  catches and routes to a single Alert. */
export async function fetchChallenge(walletAddress: string): Promise<ChallengeResponse> {
  const { baseUrl, apiKey } = requireRelayer();
  const url = new URL("/challenge", new URL(baseUrl).origin);
  url.searchParams.set("wallet", walletAddress);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHALLENGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach the executor: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Executor returned ${response.status} for /challenge.`);
  }

  const body = (await response.json()) as {
    nonce?: number[];
    expires_in?: number;
    phrase?: string;
  };

  if (!Array.isArray(body.nonce) || body.nonce.length !== 32) {
    throw new Error("Executor returned a malformed nonce; expected a 32-byte array.");
  }
  if (typeof body.phrase !== "string" || body.phrase.trim().length === 0) {
    throw new Error("Executor returned an empty challenge phrase.");
  }

  return {
    nonce: Uint8Array.from(body.nonce),
    phrase: body.phrase,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 60,
  };
}

interface ValidateBody {
  valid?: boolean;
  remaining_quota?: number;
  error?: string;
  reason?: string;
  retry_after?: number;
  signed_receipt?: SignedReceiptDto;
  commitment_hex?: string;
  salt_hex?: string;
  composite_risk_score?: number;
}

/** POST /validate-features. Always resolves with a ValidateOutcome — never
 *  throws. The caller switches on `kind`. Config errors degrade to
 *  `service-down` so the contract holds even when the executor URL is
 *  missing (the relayer-down bucket surfaces the right "try again later"
 *  UX without leaking config detail to the user). */
export async function validateFeatures(input: ValidateInput): Promise<ValidateOutcome> {
  let relayer: RelayerConfig;
  try {
    relayer = requireRelayer();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Executor not configured.";
    return { kind: "service-down", message };
  }
  const { baseUrl, apiKey } = relayer;
  const url = new URL("/validate-features", new URL(baseUrl).origin);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const body = JSON.stringify({
    features: input.features,
    projection_version: input.projectionVersion,
    wallet_id: input.walletId,
    f0_contour: input.f0Contour,
    accel_magnitude: input.accelMagnitude,
    audio_samples_b64: input.audioSamplesB64,
    audio_sample_rate_hz: input.audioSampleRateHz,
    commitment_new_hex: input.commitmentNewHex,
    // Explicit mint-intent signal. New validators sign a receipt over a
    // commitment THEY derive from `features`; `commitment_new_hex` is still
    // sent so older validators (which trust it) keep working.
    request_receipt: input.receiptPurpose !== undefined,
    receipt_purpose: input.receiptPurpose,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    // The only thing that aborts this request is our own timer, so an
    // AbortError means the upload outran VALIDATE_TIMEOUT_MS. Folding it into
    // `service-down` told the user the executor was unreachable when it may
    // have been healthy the whole time and the connection merely slow.
    if (err instanceof Error && err.name === "AbortError") {
      return { kind: "timeout" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "service-down", message };
  } finally {
    clearTimeout(timer);
  }

  // Parse once. Executor's IntoResponse always emits JSON for both success and
  // error paths; a body parse failure means the response wasn't from the
  // executor at all (proxy / gateway error page). Default to {} so the status
  // path below still gets to choose the right kind.
  const parsed: ValidateBody = await response.json().catch(() => ({}) as ValidateBody);

  if (response.ok && parsed.valid === true) {
    return {
      kind: "ok",
      remainingQuota: typeof parsed.remaining_quota === "number" ? parsed.remaining_quota : null,
      signedReceipt: parsed.signed_receipt ?? null,
      commitmentHex: parsed.commitment_hex ?? null,
      saltHex: parsed.salt_hex ?? null,
      compositeRiskScore:
        typeof parsed.composite_risk_score === "number" ? parsed.composite_risk_score : null,
    };
  }

  // Cooldown length rides in the JSON body. The executor also sets a
  // Retry-After header, but the body is the portable source: a browser cannot
  // read that header cross-origin unless the server lists it in
  // Access-Control-Expose-Headers, and it does not. 60 s covers a server that
  // sent nothing usable.
  const retryAfterSec =
    typeof parsed.retry_after === "number" && parsed.retry_after > 0 ? parsed.retry_after : 60;

  if (response.status === 400) {
    // Classify by disposition, not by membership of a list kept here. The
    // `wait` branch is defensive, since the executor sends cooldowns as 429
    // today, but routing by label means a status change upstream cannot turn a
    // cooldown into a dead end.
    switch (reasonDisposition(parsed.reason)) {
      case "retry":
        return { kind: "soft-reject", reason: parsed.reason as VerificationReason };
      case "wait":
        return { kind: "rate-limited", retryAfterSec };
      case "fatal":
        return { kind: "hard-reject" };
    }
  }

  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status === 402) return { kind: "quota-exhausted" };
  // 413 carries `reason: "payload_too_large"`, whose disposition is `fatal`.
  // Matched on the status so the outcome holds even when the body is a
  // gateway's error page rather than the executor's JSON.
  if (response.status === 413) return { kind: "payload-too-large" };
  if (response.status === 429) return { kind: "rate-limited", retryAfterSec };

  // Every 5xx, not just 502-504. A plain 500 (TransactionSubmissionFailed,
  // AttestationServiceUnavailable) used to reach the user as an untriaged
  // `unknown` despite being the same "nothing was decided, come back later"
  // situation as a 502.
  if (response.status >= 500) {
    return {
      kind: "service-down",
      message: parsed.error ?? `Executor returned HTTP ${response.status}.`,
    };
  }

  return {
    kind: "unknown",
    status: response.status,
    message: parsed.error ?? `Executor returned HTTP ${response.status}.`,
  };
}
