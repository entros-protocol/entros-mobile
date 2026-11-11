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
  "audio_evidence_insufficient",
  "anchor_retry",
  "paired_required",
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
  "authorization_required",
  "authorization_invalid",
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
    expect(SCREEN_BUCKETS.has(screen.screen.bucket!)).toBe(true);
    if (screen.screen.bucket === "soft") {
      // The soft screen keys its hint on the retryable set, which the type
      // system forces the screen to cover.
      expect(RETRYABLE_REASONS.has(reason)).toBe(true);
      expect(screen.screen.reason).toBe(reason);
      expect(screen.record).toBeNull();
    }
  });

  test("a refused wallet authorization opens the retry screen and records no failure", () => {
    for (const reason of ["authorization_required", "authorization_invalid"]) {
      expect(pairedFailureScreen({ reason, status: 401 })).toEqual({
        screen: { bucket: "soft", reason },
        record: null,
      });
    }
  });

  test("session limits show a countdown and are not recorded as failures", () => {
    for (const reason of SESSION_LIMITS) {
      expect(pairedFailureScreen({ reason, retryAfterSec: 20 })).toEqual({
        screen: { bucket: "session-busy", reason, retryAfterSec: 20 },
        record: null,
      });
    }
  });

  test("rate limits keep the single capture's countdown and default", () => {
    for (const reason of COOLDOWN_REASONS) {
      if (SESSION_LIMITS.includes(reason)) continue;
      expect(pairedFailureScreen({ reason })).toEqual({
        screen: { bucket: "rate-limited", reason, retryAfterSec: 60 },
        record: "rate-limited",
      });
    }
  });

  test("protocol disagreements carry their reason and code to the session error screen", () => {
    expect(pairedFailureScreen({ reason: "final_digest_mismatch" })).toEqual({
      screen: {
        bucket: "session-error",
        reason: "final_digest_mismatch",
        message: "final_digest_mismatch",
      },
      record: "session-error",
    });
    expect(pairedFailureScreen({ reason: "invalid_request" }).screen.reason).toBe(
      "invalid_request",
    );
    expect(pairedFailureScreen({ reason: "payload_too_large", status: 413 })).toEqual({
      screen: { bucket: "report-bug", message: "payload_too_large" },
      record: "report-bug",
    });
  });

  test.each(["receipt_missing", "receipt_mismatch", "commitment_malformed"])(
    "a refused finalize answer, %s, reaches the session error screen",
    (detail) => {
      expect(pairedFailureScreen({ detail })).toEqual({
        screen: { bucket: "session-error", message: detail },
        record: "session-error",
      });
    },
  );

  test("unknown and absent reasons fall to a screen with a retry, never a dead end", () => {
    expect(pairedFailureScreen({ reason: "projection_update_required", status: 409 })).toEqual({
      screen: { bucket: "generic", message: "projection_update_required" },
      record: "generic",
    });
    expect(pairedFailureScreen({ reason: "toString" }).screen.bucket).toBe("generic");
    expect(pairedFailureScreen({ reason: "audio_bounds_exceeded" }).screen.bucket).toBe("generic");
    expect(pairedFailureScreen({ status: 400 })).toEqual({
      screen: { bucket: "generic" },
      record: "generic",
    });
    expect(pairedFailureScreen({ status: 502 })).toEqual({
      screen: { bucket: "relayer-down" },
      record: "relayer-down",
    });
    expect(pairedFailureScreen({ detail: "AudioRecord read failed (-3)" })).toEqual({
      screen: { bucket: "generic", message: "AudioRecord read failed (-3)" },
      record: "generic",
    });
  });
});
