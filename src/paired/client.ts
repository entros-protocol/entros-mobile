// Paired-round wire client: response parsing, commit and finalize bodies, the finalize
// success check, and the retry rules. Pure and transport-injected, so every rule here runs
// under test without a network. Byte strings travel as lowercase hex, segment audio as
// standard base64, and every time as integer milliseconds.
//
// PRIVACY: a commit carries digests and lengths only. Segment audio and coarse paths leave
// the device only in the finalize body, and this module never logs or retains them.

import { bytesToHex } from "@noble/hashes/utils.js";

import { equalBytes, isRecord, type JsonRecord } from "@/lib/values";
import {
  decodeSignedReceipt,
  receiptMatchesBinding,
  type SignedReceiptDto,
} from "@/protocol/receipt";
import { bytesToBase64 } from "@/sensor/encode";
import type { ClientSignals } from "@/services/validationAuthorization";

import {
  audioDigest,
  challengeDigest,
  checkTierPointCount,
  decodeCoarsePath,
  decodePathTarget,
  evidenceManifest,
  finalDigest,
  MAX_PATH_POINTS,
  MAX_ROUND_SAMPLES,
  MAX_SESSION_SAMPLES,
  MIN_PATH_POINTS,
  PAIRED_AUDIO_FORMAT,
  PAIRED_PROTOCOL_VERSION,
  PAIRED_ROUNDS,
  PairedEncodingError,
  pathDigest,
  roundCommitment,
  sessionCommitment,
  type GridPoint,
} from "./transcript";

export const PAIRED_PROJECTION_VERSION = 1;

const DIGEST_BYTES = 32;
const NONCE_BYTES = 32;
const IDEMPOTENCY_KEY_BYTES = 16;
const SESSION_ID = /^[0-9a-f]{32}$/;
const LOWER_HEX = /^(?:[0-9a-f]{2})*$/;
const WORD = /^[a-z]{1,32}$/;
const BASE58_WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type PairedClientErrorKind = "invalid_response" | "refused";

/**
 * - `invalid_response`: the server answered with a body this client must not act on.
 * - `refused`: the request ended without an answer to act on. `reason` is the server's
 *   reason, one named by the status, `validation_unavailable` once retries run out, or
 *   `round_expired` when the round ended before the request could go out.
 */
export class PairedClientError extends Error {
  readonly kind: PairedClientErrorKind;
  /** A server reason code, an encoding reason, or a client check name. */
  readonly reason: string;
  readonly status: number | undefined;
  /** Seconds the server asked the client to wait. */
  readonly retryAfterSec: number | undefined;
  /** The response field that failed, for `invalid_response`. */
  readonly field: string | undefined;

  constructor(
    kind: PairedClientErrorKind,
    reason: string,
    details: { status?: number; retryAfterSec?: number; field?: string } = {},
  ) {
    super(details.field ? `${kind}: ${reason} (${details.field})` : `${kind}: ${reason}`);
    this.name = "PairedClientError";
    this.kind = kind;
    this.reason = reason;
    this.status = details.status;
    this.retryAfterSec = details.retryAfterSec;
    this.field = details.field;
  }
}

export interface PairedBounds {
  maxRoundSamples: number;
  maxSessionSamples: number;
  minPathPoints: number;
  maxPathPoints: number;
}

export interface PairedReveal {
  roundIndex: number;
  roundNonce: Uint8Array;
  word: string;
  pathTarget: Uint8Array;
  waypoints: GridPoint[];
  challengeDigest: Uint8Array;
  /** How long the round stays open, from the response's arrival. The session's end caps it. */
  expiresInMs: number;
}

export interface PairedOpenSession {
  sessionId: string;
  sessionNonce: Uint8Array;
  attemptBinding: Uint8Array;
  rounds: number;
  tier: "trace";
  /** The absolute expiry that `C_0` binds. */
  sessionExpiryUnixMs: number;
  /** How long the session stays open, from the response's arrival. */
  expiresInMs: number;
  audioFormat: typeof PAIRED_AUDIO_FORMAT;
  bounds: PairedBounds;
  reveal: PairedReveal;
}

export type PairedCommitState = "awaiting_commit" | "ready_to_finalize";

export interface PairedCommitResponse {
  /** `ready_to_finalize` exactly for the last round, `awaiting_commit` before it. */
  state: PairedCommitState;
  acceptedRound: number;
  commitment: Uint8Array;
  /** The next round. Present only while the state is `awaiting_commit`. */
  reveal?: PairedReveal;
  /**
   * How long the session stays open from the response's arrival: its own expiry while rounds
   * remain, then the window to finalize in.
   */
  sessionExpiresInMs: number;
}

export interface PairedCommitBody {
  wallet_id: string;
  session_id: string;
  round_index: number;
  round_nonce: string;
  challenge_digest: string;
  previous_commitment: string;
  audio_format: string;
  audio_byte_length: number;
  audio_digest: string;
  path_point_count: number;
  path_digest: string;
  commitment: string;
  idempotency_key: string;
}

/** One committed round. The flow keeps it until finalize, which sends these exact bytes. */
export interface PairedRoundCommit {
  body: PairedCommitBody;
  sessionNonce: Uint8Array;
  commitment: Uint8Array;
  audioDigest: Uint8Array;
  pathDigest: Uint8Array;
  segment: Uint8Array;
  coarsePath: Uint8Array;
}

export interface PairedHttpResponse {
  status: number;
  /** The parsed JSON body, or `null` when the body was absent or not JSON. */
  body: unknown;
}

/** Sends one serialized commit body. Throws on a network failure. */
export type PairedPost = (serializedBody: string) => Promise<PairedHttpResponse>;

export interface RetryClock {
  now(): number;
  /** A rejection ends the retry loop with that rejection, which is how a caller cancels. */
  sleep(ms: number): Promise<void>;
}

export interface CommitRetryOptions extends RetryClock {
  /** No attempt starts at or after this time on the `now` clock: the round's expiry. */
  deadlineMs: number;
}

/** Diagnostic envelope the executor forwards unread. Numeric and boolean fields only. */
export type PairedCaptureTiming = Readonly<Record<string, number | boolean>>;

export interface PairedFinalizeSegment {
  round_index: number;
  audio_b64: string;
  coarse_path_hex: string;
}

export interface PairedFinalizeBody {
  capture_protocol: "paired";
  wallet_id: string;
  projection_version: typeof PAIRED_PROJECTION_VERSION;
  session_id: string;
  final_digest: string;
  segments: PairedFinalizeSegment[];
  features: number[];
  f0_contour: number[];
  accel_magnitude: number[];
  capture_timing: PairedCaptureTiming;
  client_signals: ClientSignals;
  baseline_reset: boolean;
  attestation?: { platform: "play_integrity"; token: string };
}

function invalid(field: string, reason = "invalid_field"): PairedClientError {
  return new PairedClientError("invalid_response", reason, { field });
}

function readRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw invalid(field);
  return value;
}

function readString(record: JsonRecord, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== "string") throw invalid(field);
  return value;
}

function readInteger(record: JsonRecord, key: string, field: string, min: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw invalid(field);
  }
  return value;
}

/** A field this protocol version fixes. Another value means the server speaks another version. */
function readExact<T extends string | number>(
  record: JsonRecord,
  key: string,
  field: string,
  expected: T,
): T {
  if (record[key] !== expected) throw invalid(field, "unsupported_session");
  return expected;
}

/** Lowercase hex of `byteLength` bytes, or of any whole number of bytes when omitted. */
function lowerHexBytes(value: unknown, byteLength?: number): Uint8Array | null {
  if (typeof value !== "string" || !LOWER_HEX.test(value)) return null;
  if (byteLength !== undefined && value.length !== byteLength * 2) return null;
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function readHex(record: JsonRecord, key: string, field: string, byteLength?: number): Uint8Array {
  const value = lowerHexBytes(record[key], byteLength);
  if (!value) throw invalid(field);
  return value;
}

function parseReveal(
  value: unknown,
  sessionNonce: Uint8Array,
  expectedRound: number,
): PairedReveal {
  const record = readRecord(value, "reveal");
  const roundIndex = readInteger(record, "round_index", "reveal.round_index", 1);
  if (roundIndex !== expectedRound) throw invalid("reveal.round_index", "round_mismatch");
  const roundNonce = readHex(record, "round_nonce", "reveal.round_nonce", NONCE_BYTES);
  const word = readString(record, "word", "reveal.word");
  if (!WORD.test(word)) throw invalid("reveal.word");
  const pathTarget = readHex(record, "path_target_hex", "reveal.path_target_hex");
  let waypoints: GridPoint[];
  try {
    waypoints = decodePathTarget("trace", pathTarget);
  } catch (error) {
    if (error instanceof PairedEncodingError) throw invalid("reveal.path_target_hex", error.reason);
    throw error;
  }
  const declared = readHex(record, "challenge_digest", "reveal.challenge_digest", DIGEST_BYTES);
  const recomputed = challengeDigest(sessionNonce, roundIndex, roundNonce, word, pathTarget);
  // A reveal whose digest does not recompute is refused: the next commitment would bind a
  // challenge the server never issued.
  if (!equalBytes(declared, recomputed)) {
    throw invalid("reveal.challenge_digest", "challenge_mismatch");
  }
  const expiresInMs = readInteger(record, "expires_in_ms", "reveal.expires_in_ms", 0);
  return {
    roundIndex,
    roundNonce,
    word,
    pathTarget,
    waypoints,
    challengeDigest: recomputed,
    expiresInMs,
  };
}

/**
 * Validates every field of an open response and recomputes the first reveal's challenge
 * digest. A reveal that does not match its digest is refused.
 */
export function parseOpenResponse(json: unknown): PairedOpenSession {
  const record = readRecord(json, "response");
  readExact(record, "protocol", "protocol", "paired");
  readExact(record, "protocol_version", "protocol_version", PAIRED_PROTOCOL_VERSION);
  const sessionId = readString(record, "session_id", "session_id");
  if (!SESSION_ID.test(sessionId)) throw invalid("session_id");
  const sessionNonce = readHex(record, "session_nonce", "session_nonce", NONCE_BYTES);
  const attemptBinding = readHex(record, "attempt_binding", "attempt_binding", DIGEST_BYTES);
  const rounds = readExact(record, "rounds", "rounds", PAIRED_ROUNDS);
  const tier = readExact(record, "tier", "tier", "trace");
  const sessionExpiryUnixMs = readInteger(
    record,
    "session_expiry_unix_ms",
    "session_expiry_unix_ms",
    1,
  );
  const expiresInMs = readInteger(record, "expires_in_ms", "expires_in_ms", 0);
  const audioFormat = readExact(record, "audio_format", "audio_format", PAIRED_AUDIO_FORMAT);

  // Protocol version 1 fixes the bounds. A server that announces others under it has
  // drifted from the contract this client encodes against.
  const boundsRecord = readRecord(record.bounds, "bounds");
  const bounds: PairedBounds = {
    maxRoundSamples: readExact(
      boundsRecord,
      "max_round_samples",
      "bounds.max_round_samples",
      MAX_ROUND_SAMPLES,
    ),
    maxSessionSamples: readExact(
      boundsRecord,
      "max_session_samples",
      "bounds.max_session_samples",
      MAX_SESSION_SAMPLES,
    ),
    minPathPoints: readExact(
      boundsRecord,
      "min_path_points",
      "bounds.min_path_points",
      MIN_PATH_POINTS,
    ),
    maxPathPoints: readExact(
      boundsRecord,
      "max_path_points",
      "bounds.max_path_points",
      MAX_PATH_POINTS,
    ),
  };

  return {
    sessionId,
    sessionNonce,
    attemptBinding,
    rounds,
    tier,
    sessionExpiryUnixMs,
    expiresInMs,
    audioFormat,
    bounds,
    reveal: parseReveal(record.reveal, sessionNonce, 1),
  };
}

/**
 * Validates a commit response against the commit it answers. The accepted round and the
 * commitment must match what the client sent, the state must follow that round, and a next
 * reveal must carry a valid digest.
 */
export function parseCommitResponse(
  json: unknown,
  commit: PairedRoundCommit,
): PairedCommitResponse {
  const record = readRecord(json, "response");
  const acceptedRound = readInteger(record, "accepted_round", "accepted_round", 1);
  if (acceptedRound !== commit.body.round_index) throw invalid("accepted_round", "round_mismatch");
  const commitment = readHex(record, "commitment", "commitment", DIGEST_BYTES);
  if (!equalBytes(commitment, commit.commitment)) {
    throw invalid("commitment", "commitment_mismatch");
  }
  const finalRound = acceptedRound === PAIRED_ROUNDS;
  const state: PairedCommitState = finalRound ? "ready_to_finalize" : "awaiting_commit";
  if (record.state !== state) throw invalid("state");
  const sessionExpiresInMs = readInteger(
    record,
    "session_expires_in_ms",
    "session_expires_in_ms",
    0,
  );

  if (finalRound) {
    if (record.reveal !== undefined && record.reveal !== null) throw invalid("reveal");
    return { state, acceptedRound, commitment, sessionExpiresInMs };
  }
  const reveal = parseReveal(record.reveal, commit.sessionNonce, acceptedRound + 1);
  return { state, acceptedRound, commitment, reveal, sessionExpiresInMs };
}

/** `C_0`, from the session nonce, attempt binding, round count and absolute expiry. */
export function initialCommitment(open: PairedOpenSession): Uint8Array {
  return sessionCommitment(
    open.sessionNonce,
    open.attemptBinding,
    open.rounds,
    open.sessionExpiryUnixMs,
  );
}

export interface CommitInput {
  open: PairedOpenSession;
  reveal: PairedReveal;
  /** Base58 wallet address. */
  walletId: string;
  /** `C_{k-1}`: `initialCommitment(open)` for round 1, else the previous round's commitment. */
  previousCommitment: Uint8Array;
  /** The round's PCM16 segment, exactly as finalize will send it. */
  segment: Uint8Array;
  /** The encoded coarse path, exactly as finalize will send it. */
  coarsePath: Uint8Array;
  pointCount: number;
  /** 16 random bytes, fixed for every retry of this commit. */
  idempotencyKey: Uint8Array;
}

/** Builds the commit request for one round and computes `C_k`. */
export function buildCommitBody(input: CommitInput): PairedRoundCommit {
  const { open, reveal } = input;
  if (
    !Number.isInteger(reveal.roundIndex) ||
    reveal.roundIndex < 1 ||
    reveal.roundIndex > open.rounds
  ) {
    throw new RangeError(`Round index ${reveal.roundIndex} is outside the session.`);
  }
  if (!BASE58_WALLET.test(input.walletId)) {
    throw new RangeError("The wallet id must be a base58 address.");
  }
  if (input.previousCommitment.length !== DIGEST_BYTES) {
    throw new RangeError("The previous commitment must be 32 bytes.");
  }
  if (input.idempotencyKey.length !== IDEMPOTENCY_KEY_BYTES) {
    throw new RangeError("The idempotency key must be 16 bytes.");
  }
  const { segment, coarsePath, pointCount } = input;
  if (segment.length === 0 || segment.length % 2 !== 0) {
    throw new RangeError("A segment must hold at least one PCM16 sample.");
  }
  if (segment.length / 2 > open.bounds.maxRoundSamples) {
    throw new RangeError(`A segment holds at most ${open.bounds.maxRoundSamples} samples.`);
  }
  checkTierPointCount(open.tier, pointCount);
  if (decodeCoarsePath(open.tier, coarsePath).length !== pointCount) {
    throw new RangeError("The declared point count does not match the coarse path.");
  }

  const { sessionNonce } = open;
  const roundIndex = reveal.roundIndex;
  const challenge = reveal.challengeDigest;
  const audio = audioDigest(sessionNonce, roundIndex, challenge, open.audioFormat, segment);
  const path = pathDigest(sessionNonce, roundIndex, challenge, coarsePath);
  const commitment = roundCommitment({
    sessionNonce,
    roundIndex,
    roundNonce: reveal.roundNonce,
    challengeDigest: challenge,
    previousCommitment: input.previousCommitment,
    audioFormat: open.audioFormat,
    audioByteLength: segment.length,
    audioDigest: audio,
    pathPointCount: pointCount,
    pathDigest: path,
  });

  return {
    body: {
      wallet_id: input.walletId,
      session_id: open.sessionId,
      round_index: roundIndex,
      round_nonce: bytesToHex(reveal.roundNonce),
      challenge_digest: bytesToHex(challenge),
      previous_commitment: bytesToHex(input.previousCommitment),
      audio_format: open.audioFormat,
      audio_byte_length: segment.length,
      audio_digest: bytesToHex(audio),
      path_point_count: pointCount,
      path_digest: bytesToHex(path),
      commitment: bytesToHex(commitment),
      idempotency_key: bytesToHex(input.idempotencyKey),
    },
    sessionNonce,
    commitment,
    audioDigest: audio,
    pathDigest: path,
    segment,
    coarsePath,
  };
}

/** A status worth sending the same request again for. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function reasonOf(body: unknown): string | undefined {
  return isRecord(body) && typeof body.reason === "string" && body.reason.length > 0
    ? body.reason
    : undefined;
}

function retryAfterSecOf(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const seconds = body.retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : undefined;
}

/**
 * The refusal a non-success open or commit response carries. A response without a reason is
 * named by its status: a relayer without paired sessions, a transient fault, or a response
 * this client cannot read.
 */
export function refusalOf(response: PairedHttpResponse): PairedClientError {
  const reason =
    reasonOf(response.body) ??
    (response.status === 404
      ? "unsupported_session"
      : isTransientStatus(response.status)
        ? "validation_unavailable"
        : "malformed_response");
  return new PairedClientError("refused", reason, {
    status: response.status,
    retryAfterSec: retryAfterSecOf(response.body),
  });
}

/** The wait before the next attempt: 250 ms, doubling to 4 s. */
function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 4_000);
}

/** What one attempt produced: a value, or the error to report if no retry fits. */
export type Attempt<T> = { value: T } | { retry: Error; waitMs?: number };

/**
 * Runs `attempt` until it produces a value or no retry fits before `deadlineMs`. Each wait is
 * the backoff or the attempt's own wait, whichever is longer. An attempt that throws ends the
 * run with that error.
 */
export async function retryUntil<T>(
  attempt: () => Promise<Attempt<T>>,
  deadlineMs: number,
  clock: RetryClock,
): Promise<T> {
  for (let count = 0; ; count++) {
    const result = await attempt();
    if ("value" in result) return result.value;
    const wait = Math.max(backoffMs(count), result.waitMs ?? 0);
    if (clock.now() + wait >= deadlineMs) throw result.retry;
    await clock.sleep(wait);
  }
}

/**
 * Posts one commit until it lands or its round can no longer succeed.
 *
 * Every attempt sends the same serialized bytes with the same idempotency key, so a retry
 * after a lost response returns the stored result instead of a second commit. A network
 * error, 408, 429 or 5xx retries with backoff and honours `retry_after`. Any other refusal
 * ends the round with its reason. Retries that run out report `validation_unavailable`, since
 * no refusal ever arrived, and a commit whose round has already expired is never sent.
 */
export async function commitWithRetry(
  post: PairedPost,
  commit: PairedRoundCommit,
  options: CommitRetryOptions,
): Promise<PairedCommitResponse> {
  if (options.now() >= options.deadlineMs) throw new PairedClientError("refused", "round_expired");
  const serialized = JSON.stringify(commit.body);
  const response = await retryUntil<PairedHttpResponse>(
    async () => {
      let response: PairedHttpResponse;
      try {
        response = await post(serialized);
      } catch {
        return { retry: new PairedClientError("refused", "validation_unavailable") };
      }
      if (response.status >= 200 && response.status <= 299) return { value: response };
      const refusal = refusalOf(response);
      if (!isTransientStatus(response.status)) throw refusal;
      return {
        retry: new PairedClientError("refused", "validation_unavailable", {
          status: response.status,
        }),
        waitMs: (refusal.retryAfterSec ?? 0) * 1_000,
      };
    },
    options.deadlineMs,
    options,
  );
  return parseCommitResponse(response.body, commit);
}

/**
 * When to send a finalize again, or null to stop. `response` is null when none arrived.
 *
 * A resend is safe: the server consumes a session once, so a finalize that reached it is
 * refused on resend and never judged twice. A missing response, a stalled upload and a busy
 * or unreachable service are resent. A verdict, a refusal and a fault after consumption are
 * not.
 */
export function finalizeRetryAfterMs(
  response: PairedHttpResponse | null,
  attempt: number,
): number | null {
  if (response === null || response.status === 408) return backoffMs(attempt);
  if (response.status < 500 || reasonOf(response.body) === "technical_failure") return null;
  return Math.max(backoffMs(attempt), (retryAfterSecOf(response.body) ?? 0) * 1_000);
}

function orderedCommits(
  open: PairedOpenSession,
  commits: readonly PairedRoundCommit[],
): PairedRoundCommit[] {
  const ordered = [...commits].sort(
    (left, right) => left.body.round_index - right.body.round_index,
  );
  if (ordered.length !== open.rounds) {
    throw new RangeError(`Finalize needs ${open.rounds} committed rounds, got ${ordered.length}.`);
  }
  let previous = bytesToHex(initialCommitment(open));
  ordered.forEach((commit, index) => {
    if (commit.body.round_index !== index + 1) {
      throw new RangeError("Committed rounds must be 1 to N, each once.");
    }
    if (
      commit.body.session_id !== open.sessionId ||
      !equalBytes(commit.sessionNonce, open.sessionNonce)
    ) {
      throw new RangeError("A committed round belongs to another session.");
    }
    if (commit.body.previous_commitment !== previous) {
      throw new RangeError(`Round ${index + 1} does not extend the commitment chain.`);
    }
    previous = commit.body.commitment;
  });
  return ordered;
}

/** The session's final digest over the committed chain and its evidence manifest. */
export function computeFinalDigest(
  open: PairedOpenSession,
  commits: readonly PairedRoundCommit[],
): Uint8Array {
  const ordered = orderedCommits(open, commits);
  const manifest = evidenceManifest(
    ordered.map((commit) => ({ audioDigest: commit.audioDigest, pathDigest: commit.pathDigest })),
  );
  const last = ordered[ordered.length - 1]!;
  return finalDigest(open.sessionNonce, last.commitment, open.rounds, manifest);
}

export interface FinalizeInput {
  open: PairedOpenSession;
  commits: readonly PairedRoundCommit[];
  features: number[];
  f0Contour: number[];
  accelMagnitude: number[];
  captureTiming: PairedCaptureTiming;
  clientSignals: ClientSignals;
  baselineReset: boolean;
  /** A Play Integrity token over the attestation digest. */
  attestationToken?: string;
}

/** Builds the finalize request. Segments go in round order, as the rounds committed them. */
export function buildFinalizeBody(input: FinalizeInput): PairedFinalizeBody {
  const { open } = input;
  const ordered = orderedCommits(open, input.commits);
  const walletId = ordered[0]!.body.wallet_id;
  if (ordered.some((commit) => commit.body.wallet_id !== walletId)) {
    throw new RangeError("Every committed round must name the same wallet.");
  }
  const totalSamples = ordered.reduce((sum, commit) => sum + commit.segment.length / 2, 0);
  if (totalSamples > open.bounds.maxSessionSamples) {
    throw new RangeError(`A session holds at most ${open.bounds.maxSessionSamples} samples.`);
  }
  if (input.attestationToken !== undefined && input.attestationToken.length === 0) {
    throw new RangeError("An attestation token must not be empty.");
  }

  const body: PairedFinalizeBody = {
    capture_protocol: "paired",
    wallet_id: walletId,
    projection_version: PAIRED_PROJECTION_VERSION,
    session_id: open.sessionId,
    final_digest: bytesToHex(computeFinalDigest(open, ordered)),
    segments: ordered.map((commit) => ({
      round_index: commit.body.round_index,
      audio_b64: bytesToBase64(commit.segment),
      coarse_path_hex: bytesToHex(commit.coarsePath),
    })),
    features: input.features,
    f0_contour: input.f0Contour,
    accel_magnitude: input.accelMagnitude,
    capture_timing: input.captureTiming,
    client_signals: input.clientSignals,
    baseline_reset: input.baselineReset,
  };
  if (input.attestationToken !== undefined) {
    body.attestation = { platform: "play_integrity", token: input.attestationToken };
  }
  return body;
}

export type FinalizeReceiptPurpose = "mint" | "rebaseline" | "reset";

export interface FinalizeBinding {
  /** The transition the receipt must authorise. Absent for an update, which needs none. */
  purpose?: FinalizeReceiptPurpose;
  /** The wallet's 32 public key bytes. */
  wallet: Uint8Array;
  finalDigest: Uint8Array;
}

/** A finalize success body the wallet may act on. */
export interface FinalizeSuccess {
  remainingQuota: number | null;
  signedReceipt: SignedReceiptDto | null;
  /** 32 bytes of lowercase hex, or null when the validator returned none. */
  commitmentHex: string | null;
  saltHex: string | null;
  /** The tier the receipt signs: 0 open, 1 bound, 2 attested. Null without a receipt. */
  assuranceTier: number | null;
}

/** Why a finalize success body was refused. Each is a diagnostic code, never a server value. */
export type FinalizeRefusal = "receipt_missing" | "receipt_mismatch" | "commitment_malformed";

const RECEIPT_PURPOSES = { mint: 1, rebaseline: 2, reset: 3 } as const;

/** A 32-byte lowercase hex field: the string, null when absent, or undefined when malformed. */
function digestHexField(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && lowerHexBytes(value, DIGEST_BYTES) ? value : undefined;
}

/**
 * Checks a finalize success body before anything asks the wallet to sign. A transition needs
 * a version 3 receipt whose fields are strings and that binds this session's final digest,
 * this wallet, the transition, projection 1 and the returned commitment, which comes with its
 * salt. The tier is read from the signed receipt, never from the body. An update needs no
 * receipt and must not carry one.
 */
export function checkFinalizeSuccess(
  body: JsonRecord,
  binding: FinalizeBinding,
): FinalizeSuccess | FinalizeRefusal {
  const commitmentHex = digestHexField(body.commitment_hex);
  const saltHex = digestHexField(body.salt_hex);
  if (commitmentHex === undefined || saltHex === undefined) return "commitment_malformed";
  const remainingQuota = typeof body.remaining_quota === "number" ? body.remaining_quota : null;

  const receipt = body.signed_receipt;
  if (receipt === undefined) {
    if (binding.purpose) return "receipt_missing";
    return { remainingQuota, signedReceipt: null, commitmentHex, saltHex, assuranceTier: null };
  }
  const commitment = commitmentHex === null ? null : lowerHexBytes(commitmentHex, DIGEST_BYTES);
  if (
    !binding.purpose ||
    !isRecord(receipt) ||
    typeof receipt.validator_pubkey_hex !== "string" ||
    typeof receipt.message_hex !== "string" ||
    typeof receipt.signature_hex !== "string" ||
    !commitment ||
    saltHex === null
  ) {
    return "receipt_mismatch";
  }
  const signedReceipt: SignedReceiptDto = {
    validator_pubkey_hex: receipt.validator_pubkey_hex,
    message_hex: receipt.message_hex,
    signature_hex: receipt.signature_hex,
  };
  const decoded = decodeSignedReceipt(signedReceipt);
  if (
    !decoded ||
    decoded.version !== 3 ||
    decoded.assuranceTier === null ||
    !receiptMatchesBinding(signedReceipt, {
      purpose: RECEIPT_PURPOSES[binding.purpose],
      projectionVersion: PAIRED_PROJECTION_VERSION,
      wallet: binding.wallet,
      commitment,
      finalDigest: binding.finalDigest,
    })
  ) {
    return "receipt_mismatch";
  }
  return {
    remainingQuota,
    signedReceipt,
    commitmentHex,
    saltHex,
    assuranceTier: decoded.assuranceTier,
  };
}
