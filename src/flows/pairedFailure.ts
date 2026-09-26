// Where a paired-session failure sends the person. Every reason, known or not,
// lands on a screen with a way to start again.

import type { FinalizeRefusal } from "@/paired";
import type { PairedFailure } from "@/services/pairedErrors";
import {
  isVerificationReason,
  reasonDisposition,
  type VerificationReason,
} from "@/services/reasons";
import type { FailureBucket } from "@/state/types";

/** The failure screen a paired failure opens. */
export interface PairedFailureScreen {
  /** The failure screen's route params. `soft` is the retry hint screen, keyed by `reason`. */
  params: Record<string, string>;
  /** The bucket local history records the attempt under, or null when it records nothing. */
  record: FailureBucket | null;
}

interface FailureRoute {
  bucket: FailureBucket | "soft";
  reason?: VerificationReason;
  retryAfterSec?: number;
  /** Diagnostic code shown on the report screens. */
  message?: string;
  record: boolean;
}

/** Limits on opening or finishing a session, as distinct from a rate limit. */
const SESSION_LIMITS: ReadonlySet<VerificationReason> = new Set([
  "finalize_in_progress",
  "session_active",
  "session_budget_exhausted",
  "capacity_reached",
]);

/** Finalize answers the app refused before any wallet prompt. */
const FINALIZE_REFUSALS: ReadonlySet<string> = new Set<FinalizeRefusal>([
  "receipt_missing",
  "receipt_mismatch",
  "commitment_malformed",
]);

/** A rate limit with no server wait still shows a countdown, as the single capture does. */
const DEFAULT_RATE_LIMIT_SEC = 60;

function routeFor(failure: PairedFailure): FailureRoute {
  const { reason, status } = failure;
  if (isVerificationReason(reason)) {
    switch (reasonDisposition(reason)) {
      case "retry":
        return { bucket: "soft", reason, record: false };
      case "wait":
        return SESSION_LIMITS.has(reason)
          ? { bucket: "session-busy", reason, retryAfterSec: failure.retryAfterSec, record: false }
          : {
              bucket: "rate-limited",
              reason,
              retryAfterSec: failure.retryAfterSec ?? DEFAULT_RATE_LIMIT_SEC,
              record: true,
            };
      case "fatal":
        return reason === "payload_too_large"
          ? { bucket: "report-bug", message: reason, record: true }
          : { bucket: "session-error", reason, message: reason, record: true };
    }
  }
  if (status !== undefined && status >= 500) return { bucket: "relayer-down", record: true };
  if (failure.detail !== undefined && FINALIZE_REFUSALS.has(failure.detail)) {
    return { bucket: "session-error", message: failure.detail, record: true };
  }
  return { bucket: "generic", message: reason ?? failure.detail, record: true };
}

export function pairedFailureScreen(failure: PairedFailure): PairedFailureScreen {
  const route = routeFor(failure);
  const params: Record<string, string> = { bucket: route.bucket };
  if (route.reason) params.reason = route.reason;
  if (route.retryAfterSec !== undefined) params.retryAfter = String(route.retryAfterSec);
  if (route.message) params.message = route.message;
  return { params, record: route.record && route.bucket !== "soft" ? route.bucket : null };
}
