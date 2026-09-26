import { bytesToHex } from "@noble/hashes/utils.js";
import { PublicKey } from "@solana/web3.js";

import { extractFeatures } from "@/extraction";
import {
  analysisSignal,
  attestationDigest,
  buildCommitBody,
  computeFinalDigest,
  encodeCoarsePath,
  encodePcm16,
  initialCommitment,
  parseOpenResponse,
  type PairedFinalizeBody,
  type PairedOpenSession,
  type PairedReveal,
  type PairedRoundCommit,
} from "@/paired";
import { bytes, traceSession, vectors } from "@/paired/__tests__/vectors";
import { finalizePairedSession, type PairedFinalizeOutcome } from "@/services/pairedExecutor";
import type { MotionCapture, SensorData, TouchCapture } from "@/sensor/types";
import type { PairedSessionHandoff } from "@/state/pairedSessionBuffer";

import { preparePairedVerification, type PairedVerificationContext } from "../pairedVerification";
import type { WalletSession } from "../verificationPipeline";

import { openJson, WALLET } from "./pairedFixtures";

jest.mock("@/extraction", () => ({ MIN_AUDIO_SAMPLES: 16_000, extractFeatures: jest.fn() }));
jest.mock("@/lib/log", () => ({ devWarn: jest.fn() }));
jest.mock("@/services/pairedExecutor", () => ({ finalizePairedSession: jest.fn() }));
jest.mock("@/services/executor", () => ({ fetchChallenge: jest.fn() }));

// The finalize step reads only the wallet's address.
const wallet = { address: WALLET, kind: "phantom", authToken: "token" } as unknown as WalletSession;

const extractMock = jest.mocked(extractFeatures);
const finalizeMock = jest.mocked(finalizePairedSession);

const motion: MotionCapture = {
  samples: [
    { t: 0, ax: 0, ay: 0, az: 9.8, gx: 0, gy: 0, gz: 0 },
    { t: 16, ax: 0.1, ay: 0, az: 9.8, gx: 0, gy: 0, gz: 0 },
  ],
  sampleRate: 62.5,
  durationMs: 16,
  startedAt: 1_000,
};
const touch: TouchCapture = { samples: [{ t: 0, x: 0.5, y: 0.5, pressure: 1 }], durationMs: 0 };

function tone(length: number, gain: number): Float32Array {
  return Float32Array.from({ length }, (_, index) => gain * Math.sin(index / 9));
}

/** The reveal for a round of the vectors' trace session. */
function revealFor(index: number): PairedReveal {
  const round = traceSession().roundEntries[index - 1]!;
  return {
    roundIndex: round.index,
    roundNonce: bytes(round.roundNonceHex),
    word: round.word,
    pathTarget: bytes(round.pathTargetHex),
    waypoints: [],
    challengeDigest: bytes(round.challengeDigestHex),
    expiresInMs: 120_000,
  };
}

/** Three rounds chained from C_0, each with the given segment and coarse path. */
function chain(
  open: PairedOpenSession,
  segment: (round: number) => Uint8Array,
  path: (round: number) => { bytes: Uint8Array; count: number },
): PairedRoundCommit[] {
  const commits: PairedRoundCommit[] = [];
  let previous = initialCommitment(open);
  for (let round = 1; round <= 3; round++) {
    const coarse = path(round);
    const commit = buildCommitBody({
      open,
      reveal: revealFor(round),
      walletId: WALLET,
      previousCommitment: previous,
      segment: segment(round),
      coarsePath: coarse.bytes,
      pointCount: coarse.count,
      idempotencyKey: new Uint8Array(16).fill(round),
    });
    commits.push(commit);
    previous = commit.commitment;
  }
  return commits;
}

/** A second of audio per round. */
function sessionCommits(open: PairedOpenSession): PairedRoundCommit[] {
  const points = Array.from({ length: 12 }, (_, index) => ({ x: index * 50, y: 500 }));
  return chain(
    open,
    (round) => encodePcm16(tone(16_000, 0.02 * round)),
    () => ({ bytes: encodeCoarsePath("trace", points), count: points.length }),
  );
}

function handoff(commits?: PairedRoundCommit[]): PairedSessionHandoff {
  const open = parseOpenResponse(openJson());
  return {
    rounds: {
      open,
      commits: commits ?? sessionCommits(open),
      walletId: WALLET,
      audioStartedAtMs: 2_000,
      audioEndedAtMs: 5_000,
      sessionEndsAtMs: 90_000,
      nativeSampleRate: 48_000,
    },
    motion,
    touch,
  };
}

function context(overrides: Partial<PairedVerificationContext> = {}): PairedVerificationContext {
  return {
    wallet,
    flowIntent: "verify",
    receiptPurpose: undefined,
    isCancelled: () => false,
    signal: new AbortController().signal,
    attestationToken: jest.fn(async () => "integrity-token"),
    now: () => 0,
    ...overrides,
  };
}

const request = { features: [1, 2], f0Contour: [120], accelMagnitude: [0.1], commitmentNewHex: "" };

function okOutcome(extra: Record<string, unknown> = {}): PairedFinalizeOutcome {
  return {
    kind: "ok",
    body: {
      valid: true,
      remaining_quota: 3,
      commitment_hex: "11".repeat(32),
      salt_hex: "22".repeat(32),
      assurance_tier: 2,
      ...extra,
    },
  };
}

beforeEach(() => {
  extractMock.mockReset().mockImplementation(async () => ({
    raw: [1, 2],
    normalized: [0.1, 0.2],
    f0Contour: [120],
    accelMagnitude: [0.1],
  }));
  finalizeMock.mockReset();
});

describe("paired finalize", () => {
  test("requests the token over the attestation digest of the vectors' session", async () => {
    // The vector segments are too short to extract, but the request starts first.
    const session = traceSession();
    const open = parseOpenResponse(openJson());
    const commits = chain(
      open,
      (round) => bytes(session.roundEntries[round - 1]!.audioSegmentHex),
      (round) => ({
        bytes: bytes(session.roundEntries[round - 1]!.coarsePathHex),
        count: session.roundEntries[round - 1]!.pathPointCount,
      }),
    );
    const attestationToken = jest.fn(async () => null);
    const prepared = await preparePairedVerification(
      handoff(commits),
      context({ attestationToken }),
    );
    expect(prepared.kind).toBe("no-voice");
    expect(bytesToHex(computeFinalDigest(open, commits))).toBe(session.finalDigestHex);
    expect(attestationToken).toHaveBeenCalledWith(vectors.attestation[0]!.requestHash);
  });

  test("extracts features from the levelled join of the committed bytes", async () => {
    const session = handoff();
    await preparePairedVerification(session, context());
    const sensorData = extractMock.mock.calls[0]![0] as SensorData;
    const segments = session.rounds.commits.map((commit) => commit.segment);
    expect(sensorData.audio.pcm).toEqual(analysisSignal(segments).signal);
    expect(sensorData.audio.sampleRate).toBe(16_000);
    expect(sensorData.audio.startedAt).toBe(2_000);
    expect(sensorData.audio.durationMs).toBe(3_000);
    expect(sensorData.motion).toBe(motion);
    expect(sensorData.touch).toBe(touch);
    expect(extractMock.mock.calls[0]![1]).toBe(1);
  });

  test("sends the token only when one arrived, and never audio outside the segments", async () => {
    finalizeMock.mockResolvedValue(okOutcome());
    const withToken = await preparePairedVerification(handoff(), context());
    if (withToken.kind !== "ready") throw new Error("expected a prepared session");
    await withToken.validate(request);
    const [sent, options] = finalizeMock.mock.calls[0]! as [
      PairedFinalizeBody,
      { sessionEndsAtMs: number },
    ];
    // Resends stop at the end of the window to finalize in.
    expect(options.sessionEndsAtMs).toBe(90_000);
    expect(sent.attestation).toEqual({ platform: "play_integrity", token: "integrity-token" });
    expect(sent.client_signals).toEqual({
      v: 1,
      env: "non-browser",
      automation: { webdriver: false, tells: [] },
    });
    expect(sent.capture_timing).toMatchObject({ v: 1, motion_samples: 2, audio_window_ms: 3_000 });
    expect(sent.baseline_reset).toBe(false);
    expect(sent.features).toEqual([1, 2]);
    expect(sent).not.toHaveProperty("audio_samples_b64");

    const withoutToken = await preparePairedVerification(
      handoff(),
      context({ attestationToken: jest.fn(async () => null), flowIntent: "reset" }),
    );
    if (withoutToken.kind !== "ready") throw new Error("expected a prepared session");
    await withoutToken.validate(request);
    const second = finalizeMock.mock.calls[1]![0] as PairedFinalizeBody;
    expect(second).not.toHaveProperty("attestation");
    expect(second.baseline_reset).toBe(true);
  });

  test("a failing token request never fails the verification", async () => {
    finalizeMock.mockResolvedValue(okOutcome());
    const prepared = await preparePairedVerification(
      handoff(),
      context({ attestationToken: () => Promise.reject(new Error("Play failed")) }),
    );
    if (prepared.kind !== "ready") throw new Error("expected a prepared session");
    await expect(prepared.validate(request)).resolves.toMatchObject({ kind: "ok" });
    expect(finalizeMock.mock.calls[0]![0]).not.toHaveProperty("attestation");
  });

  test("checks a mint receipt binds the session before any wallet prompt", async () => {
    const session = handoff();
    const finalDigest = computeFinalDigest(session.rounds.open, session.rounds.commits);
    const receipt = (version: 2 | 3, digest: Uint8Array, purpose = 1) => {
      const message = Buffer.alloc(version === 3 ? 136 : 103);
      Buffer.from(`entros-validator-receipt-v${version}\0`, "ascii").copy(message, 0);
      message[28] = purpose;
      message.writeUInt16LE(1, 29);
      new PublicKey(WALLET).toBuffer().copy(message, 31);
      Buffer.from("11".repeat(32), "hex").copy(message, 63);
      message.writeBigInt64LE(1_790_000_000n, 95);
      if (version === 3) {
        Buffer.from(digest).copy(message, 103);
        message[135] = 2;
      }
      return {
        validator_pubkey_hex: "8c".repeat(32),
        signature_hex: "ab".repeat(64),
        message_hex: message.toString("hex"),
      };
    };
    const prepared = await preparePairedVerification(session, context({ receiptPurpose: "mint" }));
    if (prepared.kind !== "ready") throw new Error("expected a prepared session");

    finalizeMock.mockResolvedValueOnce(okOutcome({ signed_receipt: receipt(3, finalDigest) }));
    await expect(prepared.validate(request)).resolves.toEqual({
      kind: "ok",
      outcome: {
        kind: "ok",
        remainingQuota: 3,
        signedReceipt: receipt(3, finalDigest),
        commitmentHex: "11".repeat(32),
        saltHex: "22".repeat(32),
        compositeRiskScore: null,
      },
    });

    const refused = { kind: "failed", failure: { detail: "receipt_mismatch" } };
    finalizeMock.mockResolvedValueOnce(okOutcome({ signed_receipt: receipt(2, finalDigest) }));
    await expect(prepared.validate(request)).resolves.toEqual(refused);
    finalizeMock.mockResolvedValueOnce(
      okOutcome({ signed_receipt: receipt(3, new Uint8Array(32)) }),
    );
    await expect(prepared.validate(request)).resolves.toEqual(refused);
    finalizeMock.mockResolvedValueOnce(okOutcome({ signed_receipt: receipt(3, finalDigest, 2) }));
    await expect(prepared.validate(request)).resolves.toEqual(refused);
    finalizeMock.mockResolvedValueOnce(
      okOutcome({ signed_receipt: receipt(3, finalDigest), commitment_hex: "33".repeat(32) }),
    );
    await expect(prepared.validate(request)).resolves.toEqual(refused);
    finalizeMock.mockResolvedValueOnce(okOutcome());
    await expect(prepared.validate(request)).resolves.toEqual({
      kind: "failed",
      failure: { detail: "receipt_missing" },
    });
  });

  test("an update needs no receipt and refuses one it was not asked for", async () => {
    const prepared = await preparePairedVerification(handoff(), context());
    if (prepared.kind !== "ready") throw new Error("expected a prepared session");
    finalizeMock.mockResolvedValueOnce(okOutcome());
    await expect(prepared.validate(request)).resolves.toMatchObject({
      kind: "ok",
      outcome: { signedReceipt: null, commitmentHex: "11".repeat(32) },
    });
    finalizeMock.mockResolvedValueOnce(
      okOutcome({
        signed_receipt: {
          validator_pubkey_hex: "8c".repeat(32),
          signature_hex: "ab".repeat(64),
          message_hex: "00".repeat(136),
        },
      }),
    );
    await expect(prepared.validate(request)).resolves.toEqual({
      kind: "failed",
      failure: { detail: "receipt_mismatch" },
    });
  });

  test("stops the session's expiry as the finalize request goes out, and not before", async () => {
    const onFinalize = jest.fn();
    let cancelled = false;
    const prepared = await preparePairedVerification(
      handoff(),
      context({ onFinalize, isCancelled: () => cancelled }),
    );
    if (prepared.kind !== "ready") throw new Error("expected a prepared session");
    expect(onFinalize).not.toHaveBeenCalled();
    finalizeMock.mockImplementationOnce(async () => {
      expect(onFinalize).toHaveBeenCalledTimes(1);
      return okOutcome();
    });
    await prepared.validate(request);

    cancelled = true;
    await expect(prepared.validate(request)).resolves.toEqual({ kind: "cancelled" });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(onFinalize).toHaveBeenCalledTimes(1);
  });

  test("passes a server rejection through and fetches one fresh nonce for an update", async () => {
    const fetchProofNonce = jest.fn(async () => new Uint8Array(32).fill(5));
    const prepared = await preparePairedVerification(handoff(), context({ fetchProofNonce }));
    if (prepared.kind !== "ready") throw new Error("expected a prepared session");
    finalizeMock.mockResolvedValueOnce({
      kind: "rejected",
      failure: { reason: "phrase_content_mismatch", status: 400 },
    });
    await expect(prepared.validate(request)).resolves.toEqual({
      kind: "failed",
      failure: { reason: "phrase_content_mismatch", status: 400 },
    });
    const first = await prepared.proofNonce();
    const second = await prepared.proofNonce();
    expect(first).toBe(second);
    expect(fetchProofNonce).toHaveBeenCalledTimes(1);
    expect(fetchProofNonce).toHaveBeenCalledWith(WALLET);
  });

  test("hashes the attestation digest over this session's final digest", async () => {
    const session = handoff();
    const attestationToken = jest.fn(async () => null);
    await preparePairedVerification(session, context({ attestationToken }));
    const { open, commits } = session.rounds;
    const expected = attestationDigest({
      protocolVersion: 1,
      sessionNonce: open.sessionNonce,
      attemptBinding: open.attemptBinding,
      finalDigest: computeFinalDigest(open, commits),
      projectionVersion: 1,
    });
    expect(attestationToken).toHaveBeenCalledWith(bytesToHex(expected));
  });
});
