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

/** Every label in the taxonomy, written out so an addition to the type without
 *  a disposition shows up as a failing assertion rather than a silent fatal. */
const ALL_REASONS: VerificationReason[] = [
  "variance_floor",
  "entropy_bounds",
  "temporal_coupling_low",
  "phrase_content_mismatch",
  "captcha_required",
  "rate_limited",
  "ip_rate_limited",
  "cross_wallet_cooldown",
  "payload_too_large",
  "validation_unavailable",
  "validation_timeout",
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
        "validation_timeout",
        "validation_unavailable",
        "variance_floor",
      ].sort(),
    );
  });

  it("COOLDOWN_REASONS holds exactly the wait-disposition labels", () => {
    expect([...COOLDOWN_REASONS].sort()).toEqual(
      ["cross_wallet_cooldown", "ip_rate_limited", "rate_limited"].sort(),
    );
  });

  it("keeps the retryable and cooldown sets disjoint", () => {
    for (const reason of RETRYABLE_REASONS) {
      expect(COOLDOWN_REASONS.has(reason)).toBe(false);
    }
  });

  it("CLIENT_ORIGIN_REASONS covers the failures no server judged", () => {
    expect([...CLIENT_ORIGIN_REASONS].sort()).toEqual([
      "validation_timeout",
      "validation_unavailable",
    ]);
    expect(isClientOriginReason("validation_timeout")).toBe(true);
    expect(isClientOriginReason("validation_unavailable")).toBe(true);
  });

  it("does not treat a server verdict as client-origin", () => {
    expect(isClientOriginReason("variance_floor")).toBe(false);
    expect(isClientOriginReason("payload_too_large")).toBe(false);
    expect(isClientOriginReason("some_future_reason")).toBe(false);
    expect(isClientOriginReason(undefined)).toBe(false);
  });
});
