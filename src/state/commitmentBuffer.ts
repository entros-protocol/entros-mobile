// In-memory handoff slot for the post-Poseidon commitment that flows from
// /verify/processing to validation, encrypted baseline persistence, and
// on-chain submission.
//
// Mirrors `captureBuffer.ts` semantics: take-and-clear, never persisted,
// never serialised.
//
// PRIVACY:
// - The 256-bit fingerprint is NEVER stored here.
//   Only the post-Poseidon commitment and salt move forward. The fingerprint
//   reference is dropped immediately after `generateTBH` returns.
// - The salt is single-use within a session. It becomes long-lived only
//   inside the AES-256-GCM-encrypted baseline.

export interface PendingCommitment {
  commitment: bigint;
  salt: bigint;
  commitmentBytes: Uint8Array;
}

let pending: PendingCommitment | null = null;

export const setCommitment = (data: PendingCommitment): void => {
  pending = data;
};

export const takeCommitment = (): PendingCommitment | null => {
  const data = pending;
  pending = null;
  return data;
};

export const clearCommitment = (): void => {
  pending = null;
};
