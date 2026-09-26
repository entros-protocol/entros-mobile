import { bytesToHex } from "@noble/hashes/utils.js";
import { PublicKey } from "@solana/web3.js";

import {
  buildCommitBody,
  buildFinalizeBody,
  checkFinalizeSuccess,
  commitWithRetry,
  computeFinalDigest,
  finalizeRetryAfterMs,
  initialCommitment,
  PairedClientError,
  parseCommitResponse,
  parseOpenResponse,
  refusalOf,
  type FinalizeBinding,
  type PairedHttpResponse,
  type PairedOpenSession,
  type PairedRoundCommit,
} from "../client";
import {
  attestationDigest,
  challengeDigest,
  encodePathTarget,
  MAX_ROUND_SAMPLES,
} from "../transcript";

import { bytes, traceSession, vectors, type RoundEntryVector } from "./vectors";

const session = traceSession();
const SESSION_ID = "8f14e45fceea167a5a36dedd4bea2543";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function entry(index: number): RoundEntryVector {
  const round = session.roundEntries[index - 1];
  if (!round) throw new Error(`The trace session has no round ${index}.`);
  return round;
}

function idempotencyKey(round: number): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, index) => (round * 16 + index) & 0xff);
}

function revealJson(round: RoundEntryVector): Record<string, unknown> {
  return {
    round_index: round.index,
    round_nonce: round.roundNonceHex,
    word: round.word,
    path_target_hex: round.pathTargetHex,
    challenge_digest: round.challengeDigestHex,
    expires_in_ms: 120_000,
  };
}

function openJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "paired",
    protocol_version: 1,
    session_id: SESSION_ID,
    session_nonce: session.sessionNonceHex,
    attempt_binding: session.attemptBindingDigestHex,
    rounds: 3,
    tier: "trace",
    session_expiry_unix_ms: session.sessionExpiryUnixMs,
    expires_in_ms: 600_000,
    audio_format: "pcm_s16le_16000_mono",
    bounds: {
      max_round_samples: 192_000,
      max_session_samples: 576_000,
      min_path_points: 8,
      max_path_points: 64,
    },
    reveal: revealJson(entry(1)),
    ...overrides,
  };
}

function commitResponseJson(
  round: RoundEntryVector,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const next = session.roundEntries[round.index];
  return {
    state: next ? "awaiting_commit" : "ready_to_finalize",
    accepted_round: round.index,
    commitment: round.commitmentHex,
    ...(next ? { reveal: revealJson(next) } : {}),
    session_expires_in_ms: 590_000,
    ...overrides,
  };
}

function commitRound(
  open: PairedOpenSession,
  reveal: PairedOpenSession["reveal"],
  previous: Uint8Array,
): PairedRoundCommit {
  const round = entry(reveal.roundIndex);
  return buildCommitBody({
    open,
    reveal,
    walletId: WALLET,
    previousCommitment: previous,
    segment: bytes(round.audioSegmentHex),
    coarsePath: bytes(round.coarsePathHex),
    pointCount: round.pathPointCount,
    idempotencyKey: idempotencyKey(round.index),
  });
}

function runSession(): { open: PairedOpenSession; commits: PairedRoundCommit[] } {
  const open = parseOpenResponse(openJson());
  let previous = initialCommitment(open);
  let reveal: PairedOpenSession["reveal"] | undefined = open.reveal;
  const commits: PairedRoundCommit[] = [];
  while (reveal) {
    const commit = commitRound(open, reveal, previous);
    const response = parseCommitResponse(commitResponseJson(entry(reveal.roundIndex)), commit);
    commits.push(commit);
    previous = commit.commitment;
    reveal = response.reveal;
  }
  return { open, commits };
}

function openFailure(json: unknown): PairedClientError {
  try {
    parseOpenResponse(json);
  } catch (error) {
    if (error instanceof PairedClientError) return error;
    throw error;
  }
  throw new Error("Expected the open response to be refused.");
}

function flipLastHex(hex: string): string {
  return hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");
}

describe("open response", () => {
  test("parses a valid response and derives C_0", () => {
    const open = parseOpenResponse(openJson());
    expect(open.sessionId).toBe(SESSION_ID);
    expect(open.reveal.word).toBe(entry(1).word);
    expect(open.reveal.waypoints).toEqual(entry(1).pathTargetWaypoints.map(([x, y]) => ({ x, y })));
    expect(bytesToHex(initialCommitment(open))).toBe(session.sessionCommitmentHex);
  });

  test.each([
    ["an unknown protocol", { protocol: "single" }, "protocol"],
    ["another protocol version", { protocol_version: 2 }, "protocol_version"],
    ["a uuid session id", { session_id: "8f14e45f-ceea-167a-5a36-dedd4bea2543" }, "session_id"],
    ["an uppercase session id", { session_id: SESSION_ID.toUpperCase() }, "session_id"],
    ["a short session nonce", { session_nonce: session.sessionNonceHex.slice(2) }, "session_nonce"],
    [
      "an uppercase attempt binding",
      { attempt_binding: session.attemptBindingDigestHex.toUpperCase() },
      "attempt_binding",
    ],
    ["another round count", { rounds: 4 }, "rounds"],
    ["the speech-only tier", { tier: "speech_only" }, "tier"],
    ["a fractional expiry", { session_expiry_unix_ms: 1.5 }, "session_expiry_unix_ms"],
    ["a negative lifetime", { expires_in_ms: -1 }, "expires_in_ms"],
    [
      "a negative round lifetime",
      { reveal: { ...revealJson(entry(1)), expires_in_ms: -1 } },
      "reveal.expires_in_ms",
    ],
    ["another audio format", { audio_format: "pcm_s16le_48000_mono" }, "audio_format"],
    [
      "other bounds",
      {
        bounds: {
          max_round_samples: 160_000,
          max_session_samples: 576_000,
          min_path_points: 8,
          max_path_points: 64,
        },
      },
      "bounds.max_round_samples",
    ],
    ["no reveal", { reveal: undefined }, "reveal"],
    ["an uppercase word", { reveal: { ...revealJson(entry(1)), word: "Balance" } }, "reveal.word"],
    ["an empty word", { reveal: { ...revealJson(entry(1)), word: "" } }, "reveal.word"],
    [
      "a word past 32 letters",
      { reveal: { ...revealJson(entry(1)), word: "a".repeat(33) } },
      "reveal.word",
    ],
  ])("refuses %s", (_name, overrides, field) => {
    const error = openFailure(openJson(overrides));
    expect(error.kind).toBe("invalid_response");
    expect(error.field).toBe(field);
  });

  test.each([
    ["protocol", { protocol: "single" }],
    ["protocol version", { protocol_version: 2 }],
    ["round count", { rounds: 4 }],
    ["tier", { tier: "speech_only" }],
    ["audio format", { audio_format: "pcm_s16le_48000_mono" }],
    [
      "bounds",
      {
        bounds: {
          max_round_samples: 192_000,
          max_session_samples: 576_000,
          min_path_points: 8,
          max_path_points: 32,
        },
      },
    ],
  ])("names another %s an unsupported session", (_name, overrides) => {
    expect(openFailure(openJson(overrides)).reason).toBe("unsupported_session");
  });

  test("accepts lifetimes of zero, which expire at once", () => {
    const open = parseOpenResponse(
      openJson({ expires_in_ms: 0, reveal: { ...revealJson(entry(1)), expires_in_ms: 0 } }),
    );
    expect(open.expiresInMs).toBe(0);
    expect(open.reveal.expiresInMs).toBe(0);
  });

  test("accepts a word of 32 letters", () => {
    const round = entry(1);
    const word = "a".repeat(32);
    const digest = challengeDigest(
      bytes(session.sessionNonceHex),
      1,
      bytes(round.roundNonceHex),
      word,
      bytes(round.pathTargetHex),
    );
    const open = parseOpenResponse(
      openJson({
        reveal: { ...revealJson(round), word, challenge_digest: bytesToHex(digest) },
      }),
    );
    expect(open.reveal.word).toBe(word);
  });

  test("refuses a body that is not an object", () => {
    expect(openFailure(null).field).toBe("response");
    expect(openFailure([openJson()]).field).toBe("response");
  });

  test("refuses a reveal whose challenge digest does not match", () => {
    const reveal = {
      ...revealJson(entry(1)),
      challenge_digest: flipLastHex(entry(1).challengeDigestHex),
    };
    const error = openFailure(openJson({ reveal }));
    expect(error.reason).toBe("challenge_mismatch");
    expect(error.field).toBe("reveal.challenge_digest");
  });

  test("refuses a reveal for any round but the first", () => {
    const error = openFailure(openJson({ reveal: revealJson(entry(2)) }));
    expect(error.reason).toBe("round_mismatch");
  });

  test.each([2, 6])("refuses a path target with %i waypoints", (count) => {
    // Encoded by hand, with a matching digest, so only the waypoint count is wrong.
    const target = new Uint8Array(2 + count * 4);
    target.set([1, count]);
    const view = new DataView(target.buffer);
    for (let index = 0; index < count; index++) {
      view.setUint16(2 + index * 4, index * 100, false);
      view.setUint16(4 + index * 4, index * 50, false);
    }
    const round = entry(1);
    const digest = challengeDigest(
      bytes(session.sessionNonceHex),
      1,
      bytes(round.roundNonceHex),
      round.word,
      target,
    );
    const error = openFailure(
      openJson({
        reveal: {
          ...revealJson(round),
          path_target_hex: bytesToHex(target),
          challenge_digest: bytesToHex(digest),
        },
      }),
    );
    expect(error.reason).toBe("waypoint_count_out_of_range");
    expect(error.field).toBe("reveal.path_target_hex");
  });
});

describe("commit chain", () => {
  test("reproduces every commitment and the final digest of the trace session", () => {
    const { open, commits } = runSession();
    expect(commits).toHaveLength(3);
    commits.forEach((commit, index) => {
      const round = entry(index + 1);
      expect(commit.body).toEqual({
        wallet_id: WALLET,
        session_id: SESSION_ID,
        round_index: round.index,
        round_nonce: round.roundNonceHex,
        challenge_digest: round.challengeDigestHex,
        previous_commitment: round.previousCommitmentHex,
        audio_format: round.audioFormat,
        audio_byte_length: round.audioByteLength,
        audio_digest: round.audioDigestHex,
        path_point_count: round.pathPointCount,
        path_digest: round.pathDigestHex,
        commitment: round.commitmentHex,
        idempotency_key: bytesToHex(idempotencyKey(round.index)),
      });
    });
    const final = computeFinalDigest(open, commits);
    expect(bytesToHex(final)).toBe(session.finalDigestHex);

    const expected = vectors.attestation.find(
      (vector) =>
        vector.finalDigestHex === session.finalDigestHex && vector.projectionVersion === 1,
    );
    expect(
      bytesToHex(
        attestationDigest({
          protocolVersion: 1,
          sessionNonce: open.sessionNonce,
          attemptBinding: open.attemptBinding,
          finalDigest: final,
          projectionVersion: 1,
        }),
      ),
    ).toBe(expected?.requestHash);
  });

  test("refuses inputs that disagree with the declared evidence", () => {
    const open = parseOpenResponse(openJson());
    const round = entry(1);
    const base = {
      open,
      reveal: open.reveal,
      walletId: WALLET,
      previousCommitment: initialCommitment(open),
      segment: bytes(round.audioSegmentHex),
      coarsePath: bytes(round.coarsePathHex),
      pointCount: round.pathPointCount,
      idempotencyKey: idempotencyKey(1),
    };
    expect(() => buildCommitBody(base)).not.toThrow();
    expect(() => buildCommitBody({ ...base, pointCount: round.pathPointCount + 1 })).toThrow(
      RangeError,
    );
    expect(() => buildCommitBody({ ...base, pointCount: 0 })).toThrow("tier_violation");
    expect(() => buildCommitBody({ ...base, segment: new Uint8Array(3) })).toThrow(RangeError);
    expect(() => buildCommitBody({ ...base, segment: new Uint8Array(0) })).toThrow(RangeError);
    expect(() =>
      buildCommitBody({ ...base, segment: new Uint8Array((MAX_ROUND_SAMPLES + 1) * 2) }),
    ).toThrow(RangeError);
    expect(() =>
      buildCommitBody({ ...base, segment: new Uint8Array(MAX_ROUND_SAMPLES * 2) }),
    ).not.toThrow();
    expect(() => buildCommitBody({ ...base, idempotencyKey: new Uint8Array(15) })).toThrow(
      RangeError,
    );
    expect(() => buildCommitBody({ ...base, previousCommitment: new Uint8Array(31) })).toThrow(
      RangeError,
    );
    expect(() => buildCommitBody({ ...base, walletId: "not a wallet" })).toThrow(RangeError);
  });

  test("refuses commit responses that disagree with the commit", () => {
    const open = parseOpenResponse(openJson());
    const commit = commitRound(open, open.reveal, initialCommitment(open));
    const failure = (json: unknown): PairedClientError => {
      try {
        parseCommitResponse(json, commit);
      } catch (error) {
        if (error instanceof PairedClientError) return error;
        throw error;
      }
      throw new Error("Expected the commit response to be refused.");
    };

    expect(
      failure(commitResponseJson(entry(1), { commitment: flipLastHex(entry(1).commitmentHex) }))
        .reason,
    ).toBe("commitment_mismatch");
    expect(failure(commitResponseJson(entry(1), { accepted_round: 2 })).reason).toBe(
      "round_mismatch",
    );
    expect(failure(commitResponseJson(entry(1), { reveal: undefined })).field).toBe("reveal");
    expect(failure(commitResponseJson(entry(1), { state: "ready_to_finalize" })).field).toBe(
      "state",
    );
    expect(failure(commitResponseJson(entry(1), { state: "finalized" })).field).toBe("state");
    expect(failure(commitResponseJson(entry(1), { session_expires_in_ms: -1 })).field).toBe(
      "session_expires_in_ms",
    );
    expect(
      failure(
        commitResponseJson(entry(1), {
          reveal: {
            ...revealJson(entry(2)),
            challenge_digest: flipLastHex(entry(2).challengeDigestHex),
          },
        }),
      ).reason,
    ).toBe("challenge_mismatch");
    expect(failure(commitResponseJson(entry(1), { reveal: revealJson(entry(3)) })).reason).toBe(
      "round_mismatch",
    );
  });

  test("the final round answers ready_to_finalize with no reveal", () => {
    const { commits } = runSession();
    const last = commits[2]!;
    const response = parseCommitResponse(
      commitResponseJson(entry(3), { session_expires_in_ms: 0 }),
      last,
    );
    expect(response.state).toBe("ready_to_finalize");
    expect(response.reveal).toBeUndefined();
    expect(response.sessionExpiresInMs).toBe(0);
    expect(() =>
      parseCommitResponse(commitResponseJson(entry(3), { state: "awaiting_commit" }), last),
    ).toThrow(PairedClientError);
  });

  test("computing the final digest refuses a broken chain", () => {
    const { open, commits } = runSession();
    expect(() => computeFinalDigest(open, commits.slice(0, 2))).toThrow(RangeError);
    expect(() => computeFinalDigest(open, [commits[0]!, commits[0]!, commits[2]!])).toThrow(
      RangeError,
    );
    const forked = commitRound(open, open.reveal, new Uint8Array(32));
    expect(() => computeFinalDigest(open, [forked, commits[1]!, commits[2]!])).toThrow(
      "does not extend",
    );
  });
});

describe("commit retry", () => {
  function clock(start = 0) {
    let time = start;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => time,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        time += ms;
      },
    };
  }

  function roundOneCommit(): PairedRoundCommit {
    const open = parseOpenResponse(openJson());
    return commitRound(open, open.reveal, initialCommitment(open));
  }

  const accepted = (overrides: Record<string, unknown> = {}): PairedHttpResponse => ({
    status: 200,
    body: commitResponseJson(entry(1), overrides),
  });

  test("resends identical bytes after network errors, 408 and 5xx", async () => {
    const commit = roundOneCommit();
    const time = clock();
    const outcomes: (PairedHttpResponse | Error)[] = [
      new TypeError("Network request failed"),
      { status: 503, body: { error: "unavailable", reason: "validator_unavailable" } },
      { status: 408, body: null },
      new TypeError("Network request failed"),
      accepted(),
    ];
    const post = jest.fn(async (_body: string): Promise<PairedHttpResponse> => {
      const next = outcomes.shift();
      if (!next) throw new Error("Unexpected extra attempt.");
      if (next instanceof Error) throw next;
      return next;
    });

    const response = await commitWithRetry(post, commit, { deadlineMs: 60_000, ...time });
    expect(response.acceptedRound).toBe(1);
    expect(response.reveal?.roundIndex).toBe(2);
    expect(post).toHaveBeenCalledTimes(5);
    const sent = post.mock.calls.map(([body]) => body);
    expect(new Set(sent).size).toBe(1);
    expect(JSON.parse(sent[0]!)).toEqual(commit.body);
    expect(time.sleeps).toEqual([250, 500, 1_000, 2_000]);
  });

  test("caps the backoff at four seconds", async () => {
    const commit = roundOneCommit();
    const time = clock();
    let attempts = 0;
    const post = async (): Promise<PairedHttpResponse> => {
      attempts++;
      if (attempts < 8) return { status: 502, body: null };
      return accepted();
    };
    await commitWithRetry(post, commit, { deadlineMs: 120_000, ...time });
    expect(time.sleeps).toEqual([250, 500, 1_000, 2_000, 4_000, 4_000, 4_000]);
  });

  test("stops at the deadline without sleeping past it", async () => {
    const commit = roundOneCommit();
    const time = clock(10_000);
    const post = jest.fn(async (): Promise<PairedHttpResponse> => {
      throw new TypeError("Network request failed");
    });

    const error = await commitWithRetry(post, commit, { deadlineMs: 11_000, ...time }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PairedClientError);
    expect((error as PairedClientError).kind).toBe("refused");
    expect((error as PairedClientError).reason).toBe("validation_unavailable");
    expect(post).toHaveBeenCalledTimes(3);
    expect(time.sleeps).toEqual([250, 500]);
    expect(time.now()).toBeLessThan(11_000);
  });

  test("reports an expired round without sending once the deadline has passed", async () => {
    const post = jest.fn(async (): Promise<PairedHttpResponse> => accepted());
    const time = clock(5_000);
    await expect(
      commitWithRetry(post, roundOneCommit(), { deadlineMs: 5_000, ...time }),
    ).rejects.toMatchObject({ kind: "refused", reason: "round_expired" });
    expect(post).not.toHaveBeenCalled();
  });

  test("treats a 409 as terminal and carries its reason", async () => {
    const time = clock();
    const post = jest.fn(
      async (): Promise<PairedHttpResponse> => ({
        status: 409,
        body: { error: "The session was replaced.", reason: "session_superseded" },
      }),
    );
    await expect(
      commitWithRetry(post, roundOneCommit(), { deadlineMs: 60_000, ...time }),
    ).rejects.toMatchObject({ kind: "refused", status: 409, reason: "session_superseded" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toEqual([]);
  });

  test("treats a 400 without a reason as terminal and names it by its status", async () => {
    const post = async (): Promise<PairedHttpResponse> => ({ status: 400, body: "bad" });
    await expect(
      commitWithRetry(post, roundOneCommit(), { deadlineMs: 60_000, ...clock() }),
    ).rejects.toMatchObject({ kind: "refused", status: 400, reason: "malformed_response" });
  });

  test("accepts the stored answer to a resent commit as success", async () => {
    const post = async (): Promise<PairedHttpResponse> => accepted({ replayed: true });
    const response = await commitWithRetry(post, roundOneCommit(), {
      deadlineMs: 60_000,
      ...clock(),
    });
    expect(response.acceptedRound).toBe(1);
    expect(response.reveal?.roundIndex).toBe(2);
  });

  test("waits at least retry_after on a 429", async () => {
    const time = clock();
    const outcomes: PairedHttpResponse[] = [
      { status: 429, body: { error: "busy", reason: "capacity_reached", retry_after: 2 } },
      { status: 429, body: { error: "busy", reason: "capacity_reached", retry_after: 0.1 } },
      accepted(),
    ];
    const post = async (): Promise<PairedHttpResponse> => outcomes.shift()!;
    await commitWithRetry(post, roundOneCommit(), { deadlineMs: 60_000, ...time });
    expect(time.sleeps).toEqual([2_000, 500]);
  });

  test("gives up when retry_after reaches past the deadline and reports the service unavailable", async () => {
    const time = clock();
    const post = jest.fn(
      async (): Promise<PairedHttpResponse> => ({
        status: 429,
        body: { error: "busy", reason: "capacity_reached", retry_after: 30 },
      }),
    );
    await expect(
      commitWithRetry(post, roundOneCommit(), { deadlineMs: 10_000, ...time }),
    ).rejects.toMatchObject({ kind: "refused", status: 429, reason: "validation_unavailable" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toEqual([]);
  });

  test("refuses a success whose commitment differs from the one sent", async () => {
    const post = async (): Promise<PairedHttpResponse> =>
      accepted({ commitment: flipLastHex(entry(1).commitmentHex) });
    await expect(
      commitWithRetry(post, roundOneCommit(), { deadlineMs: 60_000, ...clock() }),
    ).rejects.toMatchObject({ kind: "invalid_response", reason: "commitment_mismatch" });
  });
});

describe("finalize body", () => {
  const extraction = {
    features: [0.25, -1.5, 3],
    f0Contour: [120, 121.5],
    accelMagnitude: [0.01, 0.02],
    captureTiming: { v: 1, audio_window_ms: 3_200, audio_gain_clipped: false },
    clientSignals: { v: 1, env: "native-android" },
    baselineReset: false,
  };

  test("carries the committed segments in round order and the final digest", () => {
    const { open, commits } = runSession();
    const body = buildFinalizeBody({
      open,
      commits: [commits[2]!, commits[0]!, commits[1]!],
      ...extraction,
      attestationToken: "token-value",
    });
    expect(body).toEqual({
      capture_protocol: "paired",
      wallet_id: WALLET,
      projection_version: 1,
      session_id: SESSION_ID,
      final_digest: session.finalDigestHex,
      segments: session.roundEntries.map((round) => ({
        round_index: round.index,
        audio_b64: Buffer.from(round.audioSegmentHex, "hex").toString("base64"),
        coarse_path_hex: round.coarsePathHex,
      })),
      features: extraction.features,
      f0_contour: extraction.f0Contour,
      accel_magnitude: extraction.accelMagnitude,
      capture_timing: extraction.captureTiming,
      client_signals: extraction.clientSignals,
      baseline_reset: false,
      attestation: { platform: "play_integrity", token: "token-value" },
    });
    for (const excluded of [
      "audio_samples_b64",
      "curve_trace",
      "wallet_authorization",
      "compatibility_evidence",
    ]) {
      expect(body).not.toHaveProperty(excluded);
    }
  });

  test("omits attestation when absent and never carries study context", () => {
    const { open, commits } = runSession();
    const body = buildFinalizeBody({ open, commits, ...extraction });
    expect(body).not.toHaveProperty("study");
    expect(body).not.toHaveProperty("attestation");
    expect(JSON.stringify(body)).not.toContain("undefined");
  });

  test("refuses an incomplete session or an empty token", () => {
    const { open, commits } = runSession();
    expect(() => buildFinalizeBody({ open, commits: commits.slice(1), ...extraction })).toThrow(
      RangeError,
    );
    expect(() => buildFinalizeBody({ open, commits, ...extraction, attestationToken: "" })).toThrow(
      RangeError,
    );
  });

  test("the path target encoder agrees with the reveal the client parsed", () => {
    const open = parseOpenResponse(openJson());
    expect(bytesToHex(encodePathTarget("trace", open.reveal.waypoints))).toBe(
      entry(1).pathTargetHex,
    );
  });
});

describe("refusals", () => {
  const response = (status: number, body: unknown = null): PairedHttpResponse => ({ status, body });

  test("names a refusal by its reason, or by its status when it has none", () => {
    expect(refusalOf(response(409, { reason: "session_active", retry_after: 42 }))).toMatchObject({
      kind: "refused",
      reason: "session_active",
      status: 409,
      retryAfterSec: 42,
    });
    expect(refusalOf(response(404)).reason).toBe("unsupported_session");
    expect(refusalOf(response(408)).reason).toBe("validation_unavailable");
    expect(refusalOf(response(429, {})).reason).toBe("validation_unavailable");
    expect(refusalOf(response(502, "<html>")).reason).toBe("validation_unavailable");
    expect(refusalOf(response(401)).reason).toBe("malformed_response");
    expect(refusalOf(response(400, { reason: "" })).reason).toBe("malformed_response");
    expect(refusalOf(response(429, { retry_after: -3 })).retryAfterSec).toBeUndefined();
  });

  test("resends a finalize only while nothing was judged", () => {
    expect(finalizeRetryAfterMs(null, 0)).toBe(250);
    expect(finalizeRetryAfterMs(response(408), 1)).toBe(500);
    expect(finalizeRetryAfterMs(response(503, { reason: "session_busy", retry_after: 1 }), 0)).toBe(
      1_000,
    );
    expect(finalizeRetryAfterMs(response(503, { reason: "validation_unavailable" }), 6)).toBe(
      4_000,
    );
    expect(finalizeRetryAfterMs(response(502), 2)).toBe(1_000);
    expect(finalizeRetryAfterMs(response(503, { reason: "technical_failure" }), 0)).toBeNull();
    expect(finalizeRetryAfterMs(response(400, { reason: "trace_incomplete" }), 0)).toBeNull();
    expect(finalizeRetryAfterMs(response(409, { reason: "session_consumed" }), 0)).toBeNull();
    expect(finalizeRetryAfterMs(response(429, { reason: "rate_limited" }), 0)).toBeNull();
    expect(finalizeRetryAfterMs(response(200, { valid: true }), 0)).toBeNull();
  });
});

describe("finalize success check", () => {
  const { open, commits } = runSession();
  const finalDigest = computeFinalDigest(open, commits);
  const wallet = new PublicKey(WALLET).toBytes();
  const commitmentHex = "11".repeat(32);
  const saltHex = "22".repeat(32);

  function receipt(
    overrides: {
      version?: 2 | 3;
      purpose?: number;
      projection?: number;
      walletBytes?: Uint8Array;
      commitment?: string;
      digest?: Uint8Array;
      tier?: number;
    } = {},
  ) {
    const version = overrides.version ?? 3;
    const message = Buffer.alloc(version === 3 ? 136 : 103);
    Buffer.from(`entros-validator-receipt-v${version}\0`, "ascii").copy(message, 0);
    message[28] = overrides.purpose ?? 1;
    message.writeUInt16LE(overrides.projection ?? 1, 29);
    Buffer.from(overrides.walletBytes ?? wallet).copy(message, 31);
    Buffer.from(overrides.commitment ?? commitmentHex, "hex").copy(message, 63);
    message.writeBigInt64LE(1_790_000_000n, 95);
    if (version === 3) {
      Buffer.from(overrides.digest ?? finalDigest).copy(message, 103);
      message[135] = overrides.tier ?? 1;
    }
    return {
      validator_pubkey_hex: "8c".repeat(32),
      signature_hex: "ab".repeat(64),
      message_hex: message.toString("hex"),
    };
  }

  const mint: FinalizeBinding = { purpose: "mint", wallet, finalDigest };
  const body = (extra: Record<string, unknown> = {}) => ({
    valid: true,
    remaining_quota: 4,
    signed_receipt: receipt(),
    commitment_hex: commitmentHex,
    salt_hex: saltHex,
    ...extra,
  });

  test("accepts a mint receipt that binds this session and reads the tier it signs", () => {
    expect(checkFinalizeSuccess(body({ assurance_tier: 2 }), mint)).toEqual({
      remainingQuota: 4,
      signedReceipt: receipt(),
      commitmentHex,
      saltHex,
      assuranceTier: 1,
    });
    for (const [purpose, code] of [
      ["rebaseline", 2],
      ["reset", 3],
    ] as const) {
      expect(
        checkFinalizeSuccess(body({ signed_receipt: receipt({ purpose: code }) }), {
          ...mint,
          purpose,
        }),
      ).toMatchObject({ assuranceTier: 1 });
    }
  });

  test.each([
    ["a version 2 receipt", { signed_receipt: receipt({ version: 2 }) }],
    ["another session", { signed_receipt: receipt({ digest: new Uint8Array(32) }) }],
    ["another transition", { signed_receipt: receipt({ purpose: 2 }) }],
    ["another projection", { signed_receipt: receipt({ projection: 2 }) }],
    ["another wallet", { signed_receipt: receipt({ walletBytes: new Uint8Array(32).fill(9) }) }],
    ["another commitment", { commitment_hex: "33".repeat(32) }],
    ["no commitment", { commitment_hex: undefined }],
    ["no salt", { salt_hex: undefined }],
    ["an unknown tier", { signed_receipt: receipt({ tier: 3 }) }],
    ["a receipt field that is not a string", { signed_receipt: { ...receipt(), message_hex: 1 } }],
    ["a receipt that is not an object", { signed_receipt: "receipt" }],
  ])("refuses %s before any wallet prompt", (_name, extra) => {
    expect(checkFinalizeSuccess(body(extra), mint)).toBe("receipt_mismatch");
  });

  test("refuses a transition without a receipt", () => {
    expect(checkFinalizeSuccess(body({ signed_receipt: undefined }), mint)).toBe("receipt_missing");
  });

  test("refuses a commitment or salt that is not 32 bytes of lowercase hex", () => {
    for (const extra of [
      { commitment_hex: "11".repeat(31) },
      { commitment_hex: "AB".repeat(32) },
      { salt_hex: 7 },
    ]) {
      expect(checkFinalizeSuccess(body(extra), mint)).toBe("commitment_malformed");
      expect(
        checkFinalizeSuccess(body({ ...extra, signed_receipt: undefined }), {
          wallet,
          finalDigest,
        }),
      ).toBe("commitment_malformed");
    }
  });

  test("an update needs no receipt and must not carry one", () => {
    const update: FinalizeBinding = { wallet, finalDigest };
    expect(checkFinalizeSuccess(body({ signed_receipt: undefined }), update)).toEqual({
      remainingQuota: 4,
      signedReceipt: null,
      commitmentHex,
      saltHex,
      assuranceTier: null,
    });
    expect(checkFinalizeSuccess({ valid: true }, update)).toEqual({
      remainingQuota: null,
      signedReceipt: null,
      commitmentHex: null,
      saltHex: null,
      assuranceTier: null,
    });
    expect(checkFinalizeSuccess(body(), update)).toBe("receipt_mismatch");
  });
});
