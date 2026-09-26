// Server responses for a paired session, built from the shared vectors' trace
// session so every reveal carries a challenge digest the client accepts.

import { bytesToHex } from "@noble/hashes/utils.js";

import { parseCommitResponse, type PairedRoundCommit } from "@/paired/client";
import { traceSession, type RoundEntryVector } from "@/paired/__tests__/vectors";

export const SESSION = traceSession();
export const SESSION_ID = "8f14e45fceea167a5a36dedd4bea2543";
export const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

export function roundEntry(index: number): RoundEntryVector {
  const round = SESSION.roundEntries[index - 1];
  if (!round) throw new Error(`The trace session has no round ${index}.`);
  return round;
}

export function revealJson(round: RoundEntryVector): Record<string, unknown> {
  return {
    round_index: round.index,
    round_nonce: round.roundNonceHex,
    word: round.word,
    path_target_hex: round.pathTargetHex,
    challenge_digest: round.challengeDigestHex,
    expires_in_ms: 120_000,
  };
}

export function openJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "paired",
    protocol_version: 1,
    session_id: SESSION_ID,
    session_nonce: SESSION.sessionNonceHex,
    attempt_binding: SESSION.attemptBindingDigestHex,
    rounds: 3,
    tier: "trace",
    session_expiry_unix_ms: SESSION.sessionExpiryUnixMs,
    expires_in_ms: 600_000,
    audio_format: "pcm_s16le_16000_mono",
    bounds: {
      max_round_samples: 192_000,
      max_session_samples: 576_000,
      min_path_points: 8,
      max_path_points: 64,
    },
    reveal: revealJson(roundEntry(1)),
    ...overrides,
  };
}

/** The server's answer to a commit, echoing the client's own commitment. */
export function acceptJson(commit: PairedRoundCommit): Record<string, unknown> {
  const index = commit.body.round_index;
  const next = SESSION.roundEntries[index];
  return {
    state: next ? "awaiting_commit" : "ready_to_finalize",
    accepted_round: index,
    commitment: bytesToHex(commit.commitment),
    replayed: false,
    ...(next ? { reveal: revealJson(next) } : {}),
    session_expires_in_ms: 590_000,
  };
}

export function accept(commit: PairedRoundCommit) {
  return parseCommitResponse(acceptJson(commit), commit);
}
