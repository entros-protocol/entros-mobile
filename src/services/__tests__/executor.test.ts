// Unit tests for validateFeatures' response classification: the mapping from
// (HTTP status, body reason) to a ValidateOutcome kind that /verify/processing
// routes on. Each case mirrors a response the executor actually emits; see
// executor-node/src/error.rs for the status + body pairings.
//
// `@/config` is mocked rather than driven through env vars: the real module
// imports @solana/web3.js and throws at load time when EXPO_PUBLIC_SOLANA_RPC
// is unset, neither of which this file needs. executor.ts's only other import
// is `import type`, so nothing else is pulled in.

import { encodeAudioAsBase64 } from "@/sensor/encode";

import {
  buildValidateFeaturesRequestBody,
  fetchChallenge,
  validateFeatures,
  validateFeaturesRequest,
  type ValidateOutcome,
} from "../executor";

// Babel hoists jest.mock above the import, so the mock is already in force by
// the time executor.ts reads `config`. It sits here rather than at the top of
// the file to satisfy import/first.
jest.mock("@/config", () => ({
  config: { relayerUrl: "https://executor.test", relayerApiKey: null },
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Stub the next fetch with an executor JSON envelope. */
const respondWith = (status: number, body: Record<string, unknown> = {}) => {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
};

/** Stub the next fetch with a rejection, matched by `name` the way the runtime
 *  surfaces one: AbortController.abort() throws an "AbortError", a dead host
 *  throws a plain TypeError. */
const rejectWith = (name: string, message: string) => {
  const err = new Error(message);
  err.name = name;
  fetchMock.mockRejectedValueOnce(err);
};

const run = (): Promise<ValidateOutcome> =>
  validateFeatures({
    features: [1, 2, 3],
    projectionVersion: 0,
    walletId: "So11111111111111111111111111111111111111112",
  });

describe("fetchChallenge", () => {
  test("preserves the nonce, deadline, phrase, and server curve", async () => {
    jest.spyOn(performance, "now").mockReturnValue(2_500);
    respondWith(200, {
      nonce: Array.from({ length: 32 }, (_, index) => index),
      expires_in: 60,
      phrase: "alpha beta gamma delta epsilon",
      curve: { a: 3, b: 5, delta: 1.25, points: 200, anchor_x: 50, anchor_y: 50 },
    });
    await expect(fetchChallenge("11111111111111111111111111111111")).resolves.toEqual({
      nonce: Uint8Array.from({ length: 32 }, (_, index) => index),
      expiresIn: 60,
      expiresAtMs: 62_500,
      phrase: "alpha beta gamma delta epsilon",
      curve: { a: 3, b: 5, delta: 1.25, points: 200, anchorX: 50, anchorY: 50 },
    });
  });

  test("rejects invalid nonce bytes, lifetimes, and curve fields", async () => {
    const valid = {
      nonce: new Array(32).fill(1),
      expires_in: 60,
      phrase: "alpha beta gamma delta epsilon",
      curve: { a: 3, b: 5, delta: 1.25, points: 200, anchor_x: 50, anchor_y: 50 },
    };
    respondWith(200, { ...valid, nonce: [...valid.nonce.slice(0, 31), 256] });
    await expect(fetchChallenge("11111111111111111111111111111111")).rejects.toThrow(
      "malformed nonce",
    );
    respondWith(200, { ...valid, expires_in: 0 });
    await expect(fetchChallenge("11111111111111111111111111111111")).rejects.toThrow(
      "malformed challenge lifetime",
    );
    respondWith(200, { ...valid, expires_in: 301 });
    await expect(fetchChallenge("11111111111111111111111111111111")).rejects.toThrow(
      "malformed challenge lifetime",
    );
    respondWith(200, { ...valid, curve: { ...valid.curve, anchor_x: 100 } });
    await expect(fetchChallenge("11111111111111111111111111111111")).rejects.toThrow(
      "malformed touch curve",
    );
    respondWith(200, { ...valid, curve: { ...valid.curve, a: 1, b: 5 } });
    await expect(fetchChallenge("11111111111111111111111111111111")).rejects.toThrow(
      "malformed touch curve",
    );
    respondWith(200, { ...valid, curve: { ...valid.curve, points: 199 } });
    await expect(fetchChallenge("11111111111111111111111111111111")).rejects.toThrow(
      "malformed touch curve",
    );
  });
});

describe("projection 2 request DTO", () => {
  test("sends authorization and compatibility evidence without raw touch or motion", async () => {
    const request = buildValidateFeaturesRequestBody({
      features: new Array(308).fill(0.25),
      projectionVersion: 2,
      walletId: "11111111111111111111111111111111",
      compatibilityEvidence: {
        projection_version: 1,
        feature_schema_version: 4,
        features: new Array(308).fill(0.5),
      },
      walletAuthorization: { nonce: new Array(32).fill(7), signature_hex: "ab".repeat(64) },
      receiptPurpose: "mint",
      curveTrace: {
        points: [
          [0, 0],
          [100, 100],
        ],
        duration_ms: 12_000,
      },
    });
    expect(request).toMatchObject({
      projection_version: 2,
      baseline_reset: false,
      request_receipt: true,
      receipt_purpose: "mint",
      compatibility_evidence: { projection_version: 1, feature_schema_version: 4 },
      wallet_authorization: { nonce: new Array(32).fill(7), signature_hex: "ab".repeat(64) },
    });
    expect(request).not.toHaveProperty("touch_samples");
    expect(request).not.toHaveProperty("motion_samples");

    respondWith(200, { valid: true });
    await validateFeaturesRequest(request);
    const sent = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sent.curve_trace).toEqual({
      points: [
        [0, 0],
        [100, 100],
      ],
      duration_ms: 12_000,
    });
    expect(sent).not.toHaveProperty("touch_samples");
    expect(sent).not.toHaveProperty("motion_samples");
  });

  test("preserves the canonical PCM rate in the request body", async () => {
    const request = buildValidateFeaturesRequestBody({
      features: new Array(308).fill(0.25),
      projectionVersion: 2,
      walletId: "11111111111111111111111111111111",
      audioSamplesB64: "AEAAQA==",
      audioSampleRateHz: 16_000,
    });
    expect(request.audio_sample_rate_hz).toBe(16_000);

    respondWith(200, { valid: true });
    await validateFeaturesRequest(request);
    const sent = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sent.audio_sample_rate_hz).toBe(16_000);
  });

  test("keeps a maximum canonical capture below the executor body limit", () => {
    const request = buildValidateFeaturesRequestBody({
      features: new Array(308).fill(123.456789),
      projectionVersion: 2,
      walletId: "11111111111111111111111111111111",
      compatibilityEvidence: {
        projection_version: 1,
        feature_schema_version: 4,
        features: new Array(308).fill(123.456789),
      },
      walletAuthorization: { nonce: new Array(32).fill(255), signature_hex: "ab".repeat(64) },
      f0Contour: new Array(1_200).fill(599.999999),
      accelMagnitude: new Array(1_200).fill(99.999999),
      audioSamplesB64: encodeAudioAsBase64(new Float32Array(192_000).fill(0.5)),
      audioSampleRateHz: 16_000,
      commitmentNewHex: "ff".repeat(32),
      receiptPurpose: "mint",
      curveTrace: {
        points: Array.from({ length: 64 }, (_, index) => [index * 1.587301, index * 1.587301]),
        duration_ms: 12_000,
      },
    });
    const bodyBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;

    expect(bodyBytes).toBeGreaterThan(500_000);
    expect(bodyBytes).toBeLessThan(1_048_576);
  });
});

describe("validateFeatures: soft-reject classification", () => {
  it("routes captcha_required to the retry surface instead of a dead end", async () => {
    // The executor returns this as a 400 with a safe reason. It used to miss
    // mobile's hand-written soft list and fall through to hard-reject, so the
    // same rejection offered a retry on web and dead-ended here.
    respondWith(400, { error: "Verification failed", reason: "captcha_required" });
    expect(await run()).toEqual({ kind: "soft-reject", reason: "captcha_required" });
  });

  it("routes the validator's other safe-reveal reasons to soft-reject", async () => {
    for (const reason of [
      "variance_floor",
      "entropy_bounds",
      "temporal_coupling_low",
      "phrase_content_mismatch",
    ]) {
      respondWith(400, { error: "Verification failed", reason });
      expect(await run()).toEqual({ kind: "soft-reject", reason });
    }
  });

  it("hard-rejects a 400 carrying no reason", async () => {
    // The opaque attack-signal path: the validator withholds the label.
    respondWith(400, { error: "Verification failed" });
    expect(await run()).toEqual({ kind: "hard-reject" });
  });

  it("hard-rejects a 400 carrying an unrecognised reason", async () => {
    respondWith(400, { error: "Verification failed", reason: "some_future_reason" });
    expect(await run()).toEqual({ kind: "hard-reject" });
  });

  it("treats a cooldown reason on a 400 as a cooldown, not a hard failure", async () => {
    respondWith(400, { error: "Wait a bit", reason: "cross_wallet_cooldown", retry_after: 900 });
    expect(await run()).toEqual({ kind: "rate-limited", retryAfterSec: 900 });
  });
});

describe("validateFeatures: 413 is fatal", () => {
  it("classifies an oversized payload as its own non-retryable outcome", async () => {
    respondWith(413, {
      error: "Verification data was too large to submit.",
      reason: "payload_too_large",
    });
    const outcome = await run();
    expect(outcome).toEqual({ kind: "payload-too-large" });
    // Explicitly not any surface that invites resending the same body.
    expect(outcome.kind).not.toBe("soft-reject");
    expect(outcome.kind).not.toBe("rate-limited");
  });

  it("holds when a gateway swallows the body", async () => {
    // Matched on status, so a proxy's HTML error page still classifies.
    respondWith(413, {});
    expect(await run()).toEqual({ kind: "payload-too-large" });
  });
});

describe("validateFeatures: cooldowns are distinct from hard failures", () => {
  it("reads retry_after from the 429 body", async () => {
    // Deliberately the body, not the Retry-After header: a browser cannot read
    // that header cross-origin unless the server exposes it, and it does not.
    respondWith(429, { error: "Too many attempts.", reason: "rate_limited", retry_after: 120 });
    expect(await run()).toEqual({ kind: "rate-limited", retryAfterSec: 120 });
  });

  it("falls back to 60 s when the server sends nothing usable", async () => {
    respondWith(429, { error: "Rate limited" });
    expect(await run()).toEqual({ kind: "rate-limited", retryAfterSec: 60 });

    respondWith(429, { error: "Rate limited", retry_after: 0 });
    expect(await run()).toEqual({ kind: "rate-limited", retryAfterSec: 60 });
  });

  it("carries a countdown a hard failure has no place for", async () => {
    respondWith(429, { reason: "ip_rate_limited", retry_after: 30 });
    const cooldown = await run();
    respondWith(400, { error: "Verification failed" });
    const hard = await run();
    expect(cooldown.kind).not.toBe(hard.kind);
    expect(cooldown).toHaveProperty("retryAfterSec", 30);
  });
});

describe("validateFeatures: an abort is not an unreachable host", () => {
  it("classifies our own timeout abort as timeout", async () => {
    rejectWith("AbortError", "Aborted");
    expect(await run()).toEqual({ kind: "timeout" });
  });

  it("classifies a transport failure as service-down", async () => {
    rejectWith("TypeError", "Network request failed");
    expect(await run()).toEqual({ kind: "service-down", message: "Network request failed" });
  });

  it("keeps the two distinguishable", async () => {
    rejectWith("AbortError", "Aborted");
    const aborted = await run();
    rejectWith("TypeError", "Network request failed");
    const unreachable = await run();
    expect(aborted.kind).not.toBe(unreachable.kind);
  });
});

describe("validateFeatures: remaining status mapping", () => {
  it("does not mark a normal validation as a baseline reset", async () => {
    respondWith(200, { valid: true });
    await run();

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ baseline_reset: false });
  });

  it("sends the projection version and reset receipt intent at the top level", async () => {
    respondWith(200, { valid: true });
    await validateFeatures({
      features: [1, 2, 3],
      projectionVersion: 1,
      walletId: "So11111111111111111111111111111111111111112",
      receiptPurpose: "reset",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      projection_version: 1,
      request_receipt: true,
      receipt_purpose: "reset",
      baseline_reset: true,
    });
  });

  it("returns ok with the validator's commitment, salt and receipt", async () => {
    respondWith(200, {
      valid: true,
      remaining_quota: 4,
      commitment_hex: "ab".repeat(32),
      salt_hex: "cd".repeat(32),
      composite_risk_score: 0.12,
    });
    expect(await run()).toEqual({
      kind: "ok",
      remainingQuota: 4,
      signedReceipt: null,
      commitmentHex: "ab".repeat(32),
      saltHex: "cd".repeat(32),
      compositeRiskScore: 0.12,
    });
  });

  it("maps 401 and 402 to their own kinds", async () => {
    respondWith(401, { error: "Unauthorized" });
    expect(await run()).toEqual({ kind: "unauthorized" });

    respondWith(402, { error: "Insufficient verification quota" });
    expect(await run()).toEqual({ kind: "quota-exhausted" });
  });

  it("treats every 5xx as service-down, not just 502-504", async () => {
    // 500 (TransactionSubmissionFailed, AttestationServiceUnavailable) used to
    // reach the user as an untriaged `unknown`.
    respondWith(500, { error: "Verification could not be completed. Please try again." });
    expect(await run()).toEqual({
      kind: "service-down",
      message: "Verification could not be completed. Please try again.",
    });

    respondWith(502, { error: "Validation service temporarily unavailable. Please try again." });
    expect(await run()).toEqual({
      kind: "service-down",
      message: "Validation service temporarily unavailable. Please try again.",
    });

    respondWith(503, {});
    expect(await run()).toEqual({ kind: "service-down", message: "Executor returned HTTP 503." });
  });

  it("leaves anything else as unknown with the status kept for triage", async () => {
    respondWith(404, { error: "Not Found" });
    expect(await run()).toEqual({ kind: "unknown", status: 404, message: "Not Found" });
  });
});
