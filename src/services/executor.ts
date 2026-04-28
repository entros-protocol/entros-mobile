// Typed HTTP client for the executor (challenge issuance + feature validation).
//
// The executor is the wallet-connected verify flow's server side: it issues
// a wallet-bound nonce + 5-word phrase via /challenge, then validates the
// captured 134-feature vector + cross-modal time-series + audio b64 via
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

const CHALLENGE_TIMEOUT_MS = 5_000;
const VALIDATE_TIMEOUT_MS = 15_000;

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

/** Soft-reject reasons that map to the retry-with-hint UX. Mirrored from
 *  entros-validation::ReasonCode::safe_label and entros.io's RETRYABLE_REASONS
 *  (verify-wallet-connected.tsx:270-275). Drift in any direction = a reason
 *  either escapes to hard-fail (annoying) or slips into soft-fail without a
 *  hint (confusing). */
export type ValidateReason =
  | "variance_floor"
  | "entropy_bounds"
  | "temporal_coupling_low"
  | "phrase_content_mismatch";

export const SOFT_REJECT_REASONS: readonly ValidateReason[] = [
  "variance_floor",
  "entropy_bounds",
  "temporal_coupling_low",
  "phrase_content_mismatch",
];

/** Discriminated outcome of a /validate-features call.
 *
 *  - `ok`: validation passed; verify flow advances to ZK proof generation
 *  - `soft-reject`: user-recoverable; surface hint + Try Again
 *  - `rate-limited`: per-wallet cap exceeded (executor 429); surface cooldown
 *  - `hard-reject`: 400 with no safe reason — opaque attack-signal rejection
 *  - `quota-exhausted`: integrator API key out of quota (402)
 *  - `unauthorized`: API key missing/wrong (401) — config bug, surfaces generic
 *  - `service-down`: 5xx, network error, or abort — show "try again later"
 *  - `unknown`: anything else; logged status for triage */
export type ValidateOutcome =
  | { kind: "ok"; remainingQuota: number | null }
  | { kind: "soft-reject"; reason: ValidateReason }
  | { kind: "rate-limited"; retryAfterSec: number }
  | { kind: "hard-reject" }
  | { kind: "quota-exhausted" }
  | { kind: "unauthorized" }
  | { kind: "service-down"; message: string }
  | { kind: "unknown"; status: number; message: string };

export interface ValidateInput {
  features: number[];
  walletId: string;
  f0Contour?: number[];
  accelMagnitude?: number[];
  audioSamplesB64?: string;
  audioSampleRateHz?: number;
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

const SOFT_REASON_SET: ReadonlySet<string> = new Set(SOFT_REJECT_REASONS);

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
    wallet_id: input.walletId,
    f0_contour: input.f0Contour,
    accel_magnitude: input.accelMagnitude,
    audio_samples_b64: input.audioSamplesB64,
    audio_sample_rate_hz: input.audioSampleRateHz,
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
    };
  }

  if (response.status === 400) {
    if (parsed.reason && SOFT_REASON_SET.has(parsed.reason)) {
      return { kind: "soft-reject", reason: parsed.reason as ValidateReason };
    }
    return { kind: "hard-reject" };
  }

  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status === 402) return { kind: "quota-exhausted" };

  if (response.status === 429) {
    const retryAfterSec =
      typeof parsed.retry_after === "number" && parsed.retry_after > 0 ? parsed.retry_after : 60;
    return { kind: "rate-limited", retryAfterSec };
  }

  if (response.status >= 502 && response.status <= 504) {
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
