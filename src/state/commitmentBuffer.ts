// In-memory handoff slot for the post-Poseidon commitment that flows from
// /verify/processing to forward stages (validation in Stage 4, encrypted
// baseline in Stage 5, on-chain mint_anchor in Stage 7).
//
// Mirrors `captureBuffer.ts` semantics: take-and-clear, never persisted,
// never serialised.
//
// PRIVACY:
// - The 256-bit fingerprint is NEVER stored here. By Stage 3 contract,
//   only the post-Poseidon commitment + salt move forward; the fingerprint
//   reference is dropped immediately after `generateTBH` returns.
// - The salt is single-use within a session. It becomes long-lived only
//   when Stage 5 lands and persists the AES-256-GCM-encrypted baseline.

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
