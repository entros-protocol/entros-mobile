// Canonical transcript for paired-round sessions.
//
// Every digest is SHA-256 over length-prefixed fields: each field carries a four-byte
// big-endian length. Without the prefix, ("entros", "paired") and ("entrospaired", "")
// would hash to the same value, and bytes could move across a field boundary unnoticed.
// The validator, the browser SDK and this module must agree byte for byte, and each is
// checked against the same generated vector file.

import { sha256 } from "@noble/hashes/sha2.js";

export const PAIRED_ROUND_DOMAINS = {
  session: "entros/paired-round/v1/session\0",
  attempt: "entros/paired-round/v1/attempt\0",
  challenge: "entros/paired-round/v1/challenge\0",
  audio: "entros/paired-round/v1/audio\0",
  path: "entros/paired-round/v1/path\0",
  round: "entros/paired-round/v1/round\0",
  commitRequest: "entros/paired-round/v1/commit-request\0",
  final: "entros/paired-round/v1/final\0",
  attestation: "entros/attestation/v1\0",
} as const;

export const PAIRED_PROTOCOL_VERSION = 1;
export const PAIRED_ROUNDS = 3;
/** The only audio format. The label enters the audio digest, so a second format cannot
 *  reuse a digest computed for the first. */
export const PAIRED_AUDIO_FORMAT = "pcm_s16le_16000_mono";
export const PAIRED_SAMPLE_RATE = 16_000;
export const MAX_ROUND_SAMPLES = 192_000;
export const MAX_SESSION_SAMPLES = 576_000;
export const PATH_SCHEMA_VERSION = 1;
export const MIN_WAYPOINTS = 3;
export const MAX_WAYPOINTS = 5;
export const MIN_PATH_POINTS = 8;
export const MAX_PATH_POINTS = 64;
/** Path coordinates lie on an integer grid over the trace surface, 0 to 1000 inclusive. */
export const COORDINATE_MAX = 1_000;

const DIGEST_BYTES = 32;

export type PairedTier = "trace" | "speech_only";

export interface GridPoint {
  x: number;
  y: number;
}

export type PairedEncodingReason =
  | "waypoint_count_out_of_range"
  | "point_count_out_of_range"
  | "coordinate_out_of_range"
  | "tier_violation"
  | "malformed";

export class PairedEncodingError extends Error {
  readonly reason: PairedEncodingReason;

  constructor(reason: PairedEncodingReason) {
    super(reason);
    this.name = "PairedEncodingError";
    this.reason = reason;
  }
}

const textEncoder = new TextEncoder();

function domainBytes(domain: string): Uint8Array {
  return textEncoder.encode(domain);
}

const DOMAIN_BYTES = {
  session: domainBytes(PAIRED_ROUND_DOMAINS.session),
  attempt: domainBytes(PAIRED_ROUND_DOMAINS.attempt),
  challenge: domainBytes(PAIRED_ROUND_DOMAINS.challenge),
  audio: domainBytes(PAIRED_ROUND_DOMAINS.audio),
  path: domainBytes(PAIRED_ROUND_DOMAINS.path),
  round: domainBytes(PAIRED_ROUND_DOMAINS.round),
  commitRequest: domainBytes(PAIRED_ROUND_DOMAINS.commitRequest),
  final: domainBytes(PAIRED_ROUND_DOMAINS.final),
  attestation: domainBytes(PAIRED_ROUND_DOMAINS.attestation),
};

function lengthPrefix(length: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
}

/** Length-prefixed concatenation. Every field carries a four-byte big-endian length. */
export function encode(fields: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const field of fields) total += 4 + field.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const field of fields) {
    out.set(lengthPrefix(field.length), offset);
    out.set(field, offset + 4);
    offset += 4 + field.length;
  }
  return out;
}

// Streams the encoding into the hasher. An audio digest covers up to 384 KB, so the
// intermediate buffer `encode` would build is worth skipping.
function digest(fields: readonly Uint8Array[]): Uint8Array {
  const hasher = sha256.create();
  for (const field of fields) {
    hasher.update(lengthPrefix(field.length));
    hasher.update(field);
  }
  return hasher.digest();
}

function assertUnsigned(value: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} must be an integer in [0, ${max}], got ${value}.`);
  }
}

function u16be(value: number): Uint8Array {
  assertUnsigned(value, 0xffff, "u16");
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function u32be(value: number): Uint8Array {
  assertUnsigned(value, 0xffff_ffff, "u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64be(value: number): Uint8Array {
  assertUnsigned(value, Number.MAX_SAFE_INTEGER, "u64");
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 0x1_0000_0000), false);
  view.setUint32(4, value >>> 0, false);
  return out;
}

/** The word enters the challenge digest as its exact ASCII dictionary entry. */
function asciiBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) throw new RangeError("A paired-round word must be ASCII.");
    out[index] = code;
  }
  return out;
}

function assertDigest(value: Uint8Array, label: string): void {
  if (value.length !== DIGEST_BYTES) {
    throw new RangeError(`${label} must be ${DIGEST_BYTES} bytes, got ${value.length}.`);
  }
}

export function attemptBindingDigest(
  serverAttemptId: Uint8Array,
  challengeNonce: Uint8Array,
): Uint8Array {
  return digest([DOMAIN_BYTES.attempt, serverAttemptId, challengeNonce]);
}

export function challengeDigest(
  sessionNonce: Uint8Array,
  roundIndex: number,
  roundNonce: Uint8Array,
  word: string,
  pathTarget: Uint8Array,
): Uint8Array {
  return digest([
    DOMAIN_BYTES.challenge,
    sessionNonce,
    u32be(roundIndex),
    roundNonce,
    asciiBytes(word),
    pathTarget,
  ]);
}

export function audioDigest(
  sessionNonce: Uint8Array,
  roundIndex: number,
  challenge: Uint8Array,
  audioFormat: string,
  segment: Uint8Array,
): Uint8Array {
  assertDigest(challenge, "challenge digest");
  return digest([
    DOMAIN_BYTES.audio,
    sessionNonce,
    u32be(roundIndex),
    challenge,
    asciiBytes(audioFormat),
    segment,
  ]);
}

export function pathDigest(
  sessionNonce: Uint8Array,
  roundIndex: number,
  challenge: Uint8Array,
  coarsePath: Uint8Array,
): Uint8Array {
  assertDigest(challenge, "challenge digest");
  return digest([DOMAIN_BYTES.path, sessionNonce, u32be(roundIndex), challenge, coarsePath]);
}

/** `C_0`. The chain starts at the session, so no round commitment stands alone. */
export function sessionCommitment(
  sessionNonce: Uint8Array,
  attemptBinding: Uint8Array,
  rounds: number,
  sessionExpiryUnixMs: number,
): Uint8Array {
  assertDigest(attemptBinding, "attempt binding");
  return digest([
    DOMAIN_BYTES.session,
    sessionNonce,
    attemptBinding,
    u32be(rounds),
    u64be(sessionExpiryUnixMs),
  ]);
}

export interface RoundCommitmentInput {
  sessionNonce: Uint8Array;
  roundIndex: number;
  roundNonce: Uint8Array;
  challengeDigest: Uint8Array;
  previousCommitment: Uint8Array;
  audioFormat: string;
  audioByteLength: number;
  audioDigest: Uint8Array;
  pathPointCount: number;
  pathDigest: Uint8Array;
}

/** `C_k`. It carries `C_{k-1}`, so the chain fixes the round order. */
export function roundCommitment(input: RoundCommitmentInput): Uint8Array {
  assertDigest(input.challengeDigest, "challenge digest");
  assertDigest(input.previousCommitment, "previous commitment");
  assertDigest(input.audioDigest, "audio digest");
  assertDigest(input.pathDigest, "path digest");
  return digest([
    DOMAIN_BYTES.round,
    input.sessionNonce,
    u32be(input.roundIndex),
    input.roundNonce,
    input.challengeDigest,
    input.previousCommitment,
    asciiBytes(input.audioFormat),
    u32be(input.audioByteLength),
    input.audioDigest,
    u32be(input.pathPointCount),
    input.pathDigest,
  ]);
}

export interface CommitRequestDigestInput {
  sessionNonce: Uint8Array;
  roundIndex: number;
  roundNonce: Uint8Array;
  challengeDigest: Uint8Array;
  previousCommitment: Uint8Array;
  commitment: Uint8Array;
  audioFormat: string;
  audioByteLength: number;
  pathPointCount: number;
}

/** What the server derives from a commit request. The idempotency key stays outside it,
 *  so a retry with the same key and the same fields is recognised as the same request. */
export function commitRequestDigest(input: CommitRequestDigestInput): Uint8Array {
  assertDigest(input.challengeDigest, "challenge digest");
  assertDigest(input.previousCommitment, "previous commitment");
  assertDigest(input.commitment, "commitment");
  return digest([
    DOMAIN_BYTES.commitRequest,
    input.sessionNonce,
    u32be(input.roundIndex),
    input.roundNonce,
    input.challengeDigest,
    input.previousCommitment,
    input.commitment,
    asciiBytes(input.audioFormat),
    u32be(input.audioByteLength),
    u32be(input.pathPointCount),
  ]);
}

export interface EvidenceEntry {
  audioDigest: Uint8Array;
  pathDigest: Uint8Array;
}

/** Audio and path digests in round order. Every entry is fixed width, so no separator. */
export function evidenceManifest(entries: readonly EvidenceEntry[]): Uint8Array {
  const out = new Uint8Array(entries.length * DIGEST_BYTES * 2);
  entries.forEach((entry, index) => {
    assertDigest(entry.audioDigest, "audio digest");
    assertDigest(entry.pathDigest, "path digest");
    out.set(entry.audioDigest, index * DIGEST_BYTES * 2);
    out.set(entry.pathDigest, index * DIGEST_BYTES * 2 + DIGEST_BYTES);
  });
  return out;
}

export function finalDigest(
  sessionNonce: Uint8Array,
  lastCommitment: Uint8Array,
  rounds: number,
  manifest: Uint8Array,
): Uint8Array {
  assertDigest(lastCommitment, "last commitment");
  return digest([DOMAIN_BYTES.final, sessionNonce, lastCommitment, u32be(rounds), manifest]);
}

export interface AttestationDigestInput {
  protocolVersion: number;
  sessionNonce: Uint8Array;
  attemptBinding: Uint8Array;
  finalDigest: Uint8Array;
  projectionVersion: number;
}

/** The value a platform integrity token binds. Its lowercase hex is the `requestHash`. */
export function attestationDigest(input: AttestationDigestInput): Uint8Array {
  assertDigest(input.attemptBinding, "attempt binding");
  assertDigest(input.finalDigest, "final digest");
  return digest([
    DOMAIN_BYTES.attestation,
    u16be(input.protocolVersion),
    input.sessionNonce,
    input.attemptBinding,
    input.finalDigest,
    u16be(input.projectionVersion),
  ]);
}

function checkCoordinates(points: readonly GridPoint[]): void {
  for (const point of points) {
    if (
      !Number.isInteger(point.x) ||
      !Number.isInteger(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x > COORDINATE_MAX ||
      point.y > COORDINATE_MAX
    ) {
      throw new PairedEncodingError("coordinate_out_of_range");
    }
  }
}

function writePoints(out: Uint8Array, offset: number, points: readonly GridPoint[]): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  points.forEach((point, index) => {
    view.setUint16(offset + index * 4, point.x, false);
    view.setUint16(offset + index * 4 + 2, point.y, false);
  });
}

function readPoints(bytes: Uint8Array, offset: number, count: number): GridPoint[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const points: GridPoint[] = [];
  for (let index = 0; index < count; index++) {
    points.push({
      x: view.getUint16(offset + index * 4, false),
      y: view.getUint16(offset + index * 4 + 2, false),
    });
  }
  return points;
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/** `version || waypoint_count || (x, y) ...`. The speech-only tier uses an empty target. */
export function encodePathTarget(tier: PairedTier, waypoints: readonly GridPoint[]): Uint8Array {
  if (tier === "speech_only") {
    if (waypoints.length === 0) return new Uint8Array(0);
    throw new PairedEncodingError("tier_violation");
  }
  if (!inRange(waypoints.length, MIN_WAYPOINTS, MAX_WAYPOINTS)) {
    throw new PairedEncodingError("waypoint_count_out_of_range");
  }
  checkCoordinates(waypoints);
  const out = new Uint8Array(2 + waypoints.length * 4);
  out[0] = PATH_SCHEMA_VERSION;
  out[1] = waypoints.length;
  writePoints(out, 2, waypoints);
  return out;
}

/** Reads a path target back. The count byte must match the body length exactly. */
export function decodePathTarget(tier: PairedTier, bytes: Uint8Array): GridPoint[] {
  if (tier === "speech_only") {
    if (bytes.length === 0) return [];
    throw new PairedEncodingError("tier_violation");
  }
  if (bytes.length < 2 || bytes[0] !== PATH_SCHEMA_VERSION) {
    throw new PairedEncodingError("malformed");
  }
  const count = bytes[1] ?? 0;
  if (!inRange(count, MIN_WAYPOINTS, MAX_WAYPOINTS)) {
    throw new PairedEncodingError("waypoint_count_out_of_range");
  }
  if (bytes.length !== 2 + count * 4) throw new PairedEncodingError("malformed");
  const waypoints = readPoints(bytes, 2, count);
  checkCoordinates(waypoints);
  return waypoints;
}

/** `version || point_count (u16be) || (x, y) ...`. The speech-only tier submits no path. */
export function encodeCoarsePath(tier: PairedTier, points: readonly GridPoint[]): Uint8Array {
  if (tier === "speech_only") {
    if (points.length === 0) return new Uint8Array(0);
    throw new PairedEncodingError("tier_violation");
  }
  if (!inRange(points.length, MIN_PATH_POINTS, MAX_PATH_POINTS)) {
    throw new PairedEncodingError("point_count_out_of_range");
  }
  checkCoordinates(points);
  const out = new Uint8Array(3 + points.length * 4);
  out[0] = PATH_SCHEMA_VERSION;
  new DataView(out.buffer).setUint16(1, points.length, false);
  writePoints(out, 3, points);
  return out;
}

/** Reads a coarse path back. A declared count that does not match the body is malformed. */
export function decodeCoarsePath(tier: PairedTier, bytes: Uint8Array): GridPoint[] {
  if (tier === "speech_only") {
    if (bytes.length === 0) return [];
    throw new PairedEncodingError("tier_violation");
  }
  if (bytes.length < 3 || bytes[0] !== PATH_SCHEMA_VERSION) {
    throw new PairedEncodingError("malformed");
  }
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(1, false);
  if (!inRange(count, MIN_PATH_POINTS, MAX_PATH_POINTS)) {
    throw new PairedEncodingError("point_count_out_of_range");
  }
  if (bytes.length !== 3 + count * 4) throw new PairedEncodingError("malformed");
  const points = readPoints(bytes, 3, count);
  checkCoordinates(points);
  return points;
}

/** A path under the speech-only tier and a missing path under the trace tier both fail. */
export function checkTierPointCount(tier: PairedTier, pointCount: number): void {
  const valid =
    tier === "speech_only"
      ? pointCount === 0
      : Number.isInteger(pointCount) && inRange(pointCount, MIN_PATH_POINTS, MAX_PATH_POINTS);
  if (!valid) throw new PairedEncodingError("tier_violation");
}
