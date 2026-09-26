// Unit tests for the reason taxonomy mirror. These are the drift guard: the
// file is a hand-maintained copy of pulse-sdk/src/reasons.ts, so the labels and
// their dispositions are asserted literally rather than derived, and a silent
// edit that would make mobile disagree with web fails here. Runs in pure Node.

import {
  CLIENT_ORIGIN_REASONS,
  COOLDOWN_REASONS,
  isClientOriginReason,
  isVerificationReason,
  reasonDisposition,
  RETRYABLE_REASONS,
  type VerificationReason,
} from "../reasons";

/** Keys every object literal inherits from Object.prototype. `reason` is
 *  copied out of a server body, so any of these is reachable input. The guard
 *  used to be `value in DISPOSITIONS`, and `in` walks the prototype chain: all
 *  seven passed, and the lookup behind them returned a function (or, for
 *  `__proto__`, the prototype object) from a function declared to return a
 *  `ReasonDisposition`. */
const INHERITED_KEYS = [
  "toString",
  "constructor",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
  "isPrototypeOf",
  "propertyIsEnumerable",
];

/** Paired-session labels, grouped by the disposition the SDK gives them. */
const PAIRED_RETRY: VerificationReason[] = [
  "technical_failure",
  "session_expired",
  "round_expired",
  "session_superseded",
  "session_consumed",
  "session_unknown",
  "session_not_ready",
  "round_not_outstanding",
  "session_busy",
];
const PAIRED_WAIT: VerificationReason[] = [
  "finalize_in_progress",
  "session_active",
  "session_budget_exhausted",
  "capacity_reached",
];
const PAIRED_FATAL: VerificationReason[] = [
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

/** Every label in the taxonomy, written out so an addition to the type without
 *  a disposition shows up as a failing assertion rather than a silent fatal. */
const ALL_REASONS: VerificationReason[] = [
  "variance_floor",
  "entropy_bounds",
  "temporal_coupling_low",
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
  ...PAIRED_RETRY,
  ...PAIRED_WAIT,
  ...PAIRED_FATAL,
];

describe("reasonDisposition", () => {
  it("classifies payload_too_large as fatal, not retry", () => {
    // An identical body earns an identical 413, so a retry is pure cost.
    expect(reasonDisposition("payload_too_large")).toBe("fatal");
    expect(RETRYABLE_REASONS.has("payload_too_large")).toBe(false);
  });

  it("classifies cooldowns as wait, which is distinct from fatal", () => {
    for (const reason of ["rate_limited", "ip_rate_limited", "cross_wallet_cooldown"]) {
      expect(reasonDisposition(reason)).toBe("wait");
      expect(reasonDisposition(reason)).not.toBe("fatal");
      expect(reasonDisposition(reason)).not.toBe("retry");
    }
  });

  it("classifies captcha_required as retry (the mobile dead-end that started this)", () => {
    expect(reasonDisposition("captcha_required")).toBe("retry");
    expect(RETRYABLE_REASONS.has("captcha_required")).toBe(true);
  });

  it("classifies the paired labels as the SDK does", () => {
    for (const reason of PAIRED_RETRY) expect(reasonDisposition(reason)).toBe("retry");
    for (const reason of PAIRED_WAIT) expect(reasonDisposition(reason)).toBe("wait");
    for (const reason of PAIRED_FATAL) expect(reasonDisposition(reason)).toBe("fatal");
  });

  it("retries an incomplete trace and stops on a refused capture environment", () => {
    expect(reasonDisposition("trace_incomplete")).toBe("retry");
    expect(reasonDisposition("automated_browser_detected")).toBe("fatal");
  });

  it("no longer knows the retired audio bound label", () => {
    expect(isVerificationReason("audio_bounds_exceeded")).toBe(false);
  });

  it("classifies the client-origin reasons as retry", () => {
    expect(reasonDisposition("validation_unavailable")).toBe("retry");
    expect(reasonDisposition("validation_timeout")).toBe("retry");
  });

  it("fails closed on an unrecognised or absent reason", () => {
    // A newer executor must not be able to grant retries to an older client.
    expect(reasonDisposition("some_future_reason")).toBe("fatal");
    expect(reasonDisposition(undefined)).toBe("fatal");
    expect(reasonDisposition("")).toBe("fatal");
  });

  it("gives every label in the taxonomy a disposition", () => {
    for (const reason of ALL_REASONS) {
      expect(["retry", "wait", "fatal"]).toContain(reasonDisposition(reason));
      expect(isVerificationReason(reason)).toBe(true);
    }
  });

  it("returns fatal for every key inherited from Object.prototype", () => {
    for (const key of INHERITED_KEYS) {
      expect(reasonDisposition(key)).toBe("fatal");
    }
  });

  it("only ever returns one of the three disposition literals", () => {
    // The original defect produced a value outside the declared union without
    // TypeScript noticing, because the narrowing that let it through happened
    // at runtime. Assert the return type by inspection, on hostile input as
    // well as valid input, since the compiler cannot.
    const hostile = [
      ...INHERITED_KEYS,
      "some_future_reason",
      "",
      "0",
      "null",
      "undefined",
      "prototype",
      "__defineGetter__",
      "Verification failed",
    ];
    for (const input of [...ALL_REASONS, ...hostile, undefined]) {
      const disposition = reasonDisposition(input);
      expect(typeof disposition).toBe("string");
      expect(["retry", "wait", "fatal"]).toContain(disposition);
    }
  });
});

describe("isVerificationReason", () => {
  it("accepts known labels and rejects everything else", () => {
    expect(isVerificationReason("variance_floor")).toBe(true);
    expect(isVerificationReason("Verification failed")).toBe(false);
    expect(isVerificationReason(undefined)).toBe(false);
    expect(isVerificationReason(null)).toBe(false);
    expect(isVerificationReason(413)).toBe(false);
  });

  it("rejects every key inherited from Object.prototype", () => {
    for (const key of INHERITED_KEYS) {
      expect(isVerificationReason(key)).toBe(false);
    }
  });
});

describe("derived sets", () => {
  it("RETRYABLE_REASONS holds exactly the retry-disposition labels", () => {
    expect([...RETRYABLE_REASONS].sort()).toEqual(
      [
        "captcha_required",
        "entropy_bounds",
        "phrase_content_mismatch",
        "temporal_coupling_low",
        "trace_incomplete",
        "validation_timeout",
        "validation_unavailable",
        "variance_floor",
        ...PAIRED_RETRY,
      ].sort(),
    );
  });

  it("COOLDOWN_REASONS holds exactly the wait-disposition labels", () => {
    expect([...COOLDOWN_REASONS].sort()).toEqual(
      ["cross_wallet_cooldown", "ip_rate_limited", "rate_limited", ...PAIRED_WAIT].sort(),
    );
  });

  it("keeps the retryable and cooldown sets disjoint", () => {
    for (const reason of RETRYABLE_REASONS) {
      expect(COOLDOWN_REASONS.has(reason)).toBe(false);
    }
  });

  it("CLIENT_ORIGIN_REASONS covers the failures no server judged", () => {
    expect([...CLIENT_ORIGIN_REASONS].sort()).toEqual(
      ["validation_timeout", "validation_unavailable", ...PAIRED_RETRY, ...PAIRED_WAIT].sort(),
    );
    expect(isClientOriginReason("validation_timeout")).toBe(true);
    expect(isClientOriginReason("validation_unavailable")).toBe(true);
    expect(isClientOriginReason("session_active")).toBe(true);
  });

  it("does not treat a server verdict as client-origin", () => {
    expect(isClientOriginReason("variance_floor")).toBe(false);
    expect(isClientOriginReason("payload_too_large")).toBe(false);
    expect(isClientOriginReason("trace_incomplete")).toBe(false);
    expect(isClientOriginReason("some_future_reason")).toBe(false);
    expect(isClientOriginReason(undefined)).toBe(false);
  });
});
