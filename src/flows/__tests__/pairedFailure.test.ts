import {
  COOLDOWN_REASONS,
  isVerificationReason,
  RETRYABLE_REASONS,
  type VerificationReason,
} from "@/services/reasons";

import { pairedFailureScreen } from "../pairedFailure";

/** Buckets the failure screen renders with a way to start again. */
const SCREEN_BUCKETS: ReadonlySet<string> = new Set([
  "soft",
  "rate-limited",
  "session-busy",
  "session-error",
  "report-bug",
  "relayer-down",
  "generic",
]);

const SESSION_LIMITS = [
  "finalize_in_progress",
  "session_active",
  "session_budget_exhausted",
  "capacity_reached",
];

/** Every reason the executor's paired routes and the client can produce. */
const PAIRED_REASONS: VerificationReason[] = [
  "phrase_content_mismatch",
  "trace_incomplete",
  "captcha_required",
  "rate_limited",
  "ip_rate_limited",
  "cross_wallet_cooldown",
  "payload_too_large",
  "automated_browser_detected",
  "validation_unavailable",
  "validation_timeout",
  "technical_failure",
  "session_expired",
  "round_expired",
  "session_superseded",
  "session_consumed",
  "session_unknown",
  "session_not_ready",
  "round_not_outstanding",
  "session_busy",
  "finalize_in_progress",
  "session_active",
  "session_budget_exhausted",
  "capacity_reached",
  "commitment_mismatch",
  "challenge_mismatch",
  "previous_commitment_mismatch",
  "round_nonce_mismatch",
  "idempotency_conflict",
  "evidence_digest_mismatch",
  "evidence_length_mismatch",
  "evidence_bounds_invalid",
  "final_digest_mismatch",
  "audio_format_invalid",
  "tier_violation",
  "subject_mismatch",
  "projection_not_supported",
  "invalid_request",
  "unsupported_session",
  "malformed_response",
];

describe("paired failure routing", () => {
  test.each(PAIRED_REASONS)("%s reaches a screen with a way forward", (reason) => {
    expect(isVerificationReason(reason)).toBe(true);
    const screen = pairedFailureScreen({ reason, status: 409 });
    expect(SCREEN_BUCKETS.has(screen.params.bucket!)).toBe(true);
    if (screen.params.bucket === "soft") {
      // The soft screen keys its hint on the retryable set, which the type
      // system forces the screen to cover.
      expect(RETRYABLE_REASONS.has(reason)).toBe(true);
      expect(screen.params.reason).toBe(reason);
      expect(screen.record).toBeNull();
    }
  });

  test("session limits show a countdown and are not recorded as failures", () => {
    for (const reason of SESSION_LIMITS) {
      expect(pairedFailureScreen({ reason, retryAfterSec: 20 })).toEqual({
        params: { bucket: "session-busy", reason, retryAfter: "20" },
        record: null,
      });
    }
  });

  test("rate limits keep the single capture's countdown and default", () => {
    for (const reason of COOLDOWN_REASONS) {
      if (SESSION_LIMITS.includes(reason)) continue;
      expect(pairedFailureScreen({ reason })).toEqual({
        params: { bucket: "rate-limited", reason, retryAfter: "60" },
        record: "rate-limited",
      });
    }
  });

  test("protocol disagreements carry their reason and code to the session error screen", () => {
    expect(pairedFailureScreen({ reason: "final_digest_mismatch" })).toEqual({
      params: {
        bucket: "session-error",
        reason: "final_digest_mismatch",
        message: "final_digest_mismatch",
      },
      record: "session-error",
    });
    expect(pairedFailureScreen({ reason: "invalid_request" }).params.reason).toBe(
      "invalid_request",
    );
    expect(pairedFailureScreen({ reason: "payload_too_large", status: 413 })).toEqual({
      params: { bucket: "report-bug", message: "payload_too_large" },
      record: "report-bug",
    });
  });

  test.each(["receipt_missing", "receipt_mismatch", "commitment_malformed"])(
    "a refused finalize answer, %s, reaches the session error screen",
    (detail) => {
      expect(pairedFailureScreen({ detail })).toEqual({
        params: { bucket: "session-error", message: detail },
        record: "session-error",
      });
    },
  );

  test("unknown and absent reasons fall to a screen with a retry, never a dead end", () => {
    expect(pairedFailureScreen({ reason: "projection_update_required", status: 409 })).toEqual({
      params: { bucket: "generic", message: "projection_update_required" },
      record: "generic",
    });
    expect(pairedFailureScreen({ reason: "toString" }).params.bucket).toBe("generic");
    expect(pairedFailureScreen({ reason: "audio_bounds_exceeded" }).params.bucket).toBe("generic");
    expect(pairedFailureScreen({ status: 400 })).toEqual({
      params: { bucket: "generic" },
      record: "generic",
    });
    expect(pairedFailureScreen({ status: 502 })).toEqual({
      params: { bucket: "relayer-down" },
      record: "relayer-down",
    });
    expect(pairedFailureScreen({ detail: "AudioRecord read failed (-3)" })).toEqual({
      params: { bucket: "generic", message: "AudioRecord read failed (-3)" },
      record: "generic",
    });
  });
});
