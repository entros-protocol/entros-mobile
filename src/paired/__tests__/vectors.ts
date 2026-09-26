// Loads the shared paired-round vectors. The file is a byte-identical copy of the
// generator's output, pinned by SHA-256 so a drifted copy fails here as well as in the
// workspace copy check.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";

export const PAIRED_ROUND_VECTORS_PATH = resolve(
  __dirname,
  "fixtures",
  "paired-round-vectors.json",
);
export const EXPECTED_PAIRED_ROUND_VECTORS_SHA256 =
  "cb88f752aed0e29a0f2321e85a2ff3006e3c1f65a933d2c729c069574445e63d";

type Pair = [number, number];

export interface RoundEntryVector {
  index: number;
  roundNonceHex: string;
  word: string;
  pathTargetHex: string;
  pathTargetWaypoints: Pair[];
  coarsePathHex: string;
  coarsePathPoints: Pair[];
  pathPointCount: number;
  audioFormat: string;
  audioSegmentHex: string;
  audioByteLength: number;
  challengeDigestHex: string;
  audioDigestHex: string;
  pathDigestHex: string;
  previousCommitmentHex: string;
  commitmentHex: string;
  requestDigestHex: string;
}

export interface SessionVector {
  name: string;
  tier: "trace" | "speech_only";
  sessionNonceHex: string;
  serverAttemptIdHex: string;
  originalChallengeNonceHex: string;
  sessionExpiryUnixMs: number;
  rounds: number;
  attemptBindingDigestHex: string;
  sessionCommitmentHex: string;
  roundEntries: RoundEntryVector[];
  evidenceManifestHex: string;
  finalDigestHex: string;
}

export type InvalidEncodingVector =
  | { name: string; encoding: "pathTarget"; waypoints: Pair[]; reason: string }
  | { name: string; encoding: "coarsePath"; points: Pair[]; reason: string }
  | {
      name: string;
      encoding: "tier";
      tier: "trace" | "speech_only";
      pointCount: number;
      reason: string;
    };

export interface CommitRecomputeVector {
  name: string;
  sessionNonceHex: string;
  roundIndex: number;
  roundNonceHex: string;
  challengeDigestHex: string;
  previousCommitmentHex: string;
  audioFormat: string;
  audioByteLength: number;
  audioDigestHex: string;
  pathPointCount: number;
  pathDigestHex: string;
  expectedCommitmentHex: string;
  matchesAcceptedCommitment: boolean;
}

export interface RoundWindowVector {
  name: string;
  roundStart: number;
  roundEnd: number;
  voicedRuns: Pair[];
  windowStart: number;
  windowEnd: number;
}

export interface AnalysisSignalVector {
  name: string;
  segmentsPcm16Hex: string[];
  sampleCount: number;
  rms: number;
  gain: number;
  signalF32LeSha256Hex: string;
}

export interface TrackerRunVector {
  startFrame: number;
  endFrame: number;
  voicedFrames: number;
  gapFrames: number;
  qualifies: boolean;
}

export interface TrackerSequenceVector {
  name: string;
  priorLevels: [number, number][];
  traceRequired: boolean;
  waypoints: Pair[];
  levels: [number, number][];
  reaches: [number, number, number][];
  decisions: [string, number][];
  completedAtFrame: number | null;
  finalRuns: TrackerRunVector[];
}

export interface CoarsePathVector {
  name: string;
  /** Surface width and height in pixels. */
  surface: [number, number];
  /** Pressed trace points: x and y in surface pixels, then milliseconds. */
  trace: [number, number, number][];
  outline: Pair[];
}

export interface PathScoringVector {
  name: string;
  waypoints: Pair[];
  outline: Pair[];
  reached: number;
  inOrder: boolean;
}

export interface AttestationVector {
  name: string;
  protocolVersion: number;
  sessionNonceHex: string;
  attemptBindingDigestHex: string;
  finalDigestHex: string;
  projectionVersion: number;
  digestHex: string;
  requestHash: string;
}

export interface ReceiptVectors {
  walletHex: string;
  commitmentHex: string;
  validatedAt: number;
  projectionVersion: number;
  finalDigestHex: string;
  v3: { purpose: number; assuranceTier: number; messageHex: string }[];
  v2: { purpose: number; messageHex: string };
  invalid: { name: string; messageHex: string }[];
}

export interface PairedRoundVectors {
  schema: string;
  domains: Record<string, string>;
  constants: Record<string, number | string>;
  tracker: Record<string, number>;
  levelling: { targetRms: number; minRms: number; maxGain: number };
  sessions: SessionVector[];
  invalidEncodings: InvalidEncodingVector[];
  separation: {
    leftFields: string[];
    rightFields: string[];
    naiveConcatenationMatches: boolean;
    encodedLeftHex: string;
    encodedRightHex: string;
    encodedDigestsDiffer: boolean;
  };
  commitRecompute: CommitRecomputeVector[];
  roundWindows: RoundWindowVector[];
  pcm16: { samples: number[]; pcm16Hex: string; decoded: number[] };
  analysisSignal: AnalysisSignalVector[];
  trackerSequences: TrackerSequenceVector[];
  coarsePaths: CoarsePathVector[];
  pathScoring: PathScoringVector[];
  attestation: AttestationVector[];
  receipts: ReceiptVectors;
}

export const pairedRoundVectorBytes: Uint8Array = new Uint8Array(
  readFileSync(PAIRED_ROUND_VECTORS_PATH),
);

export const vectors = JSON.parse(
  new TextDecoder().decode(pairedRoundVectorBytes),
) as PairedRoundVectors;

export function bytes(hex: string): Uint8Array {
  return hexToBytes(hex);
}

export function points(pairs: readonly Pair[]): { x: number; y: number }[] {
  return pairs.map(([x, y]) => ({ x, y }));
}

export function traceSession(): SessionVector {
  const session = vectors.sessions.find((candidate) => candidate.tier === "trace");
  if (!session) throw new Error("The vectors carry no trace-tier session.");
  return session;
}
