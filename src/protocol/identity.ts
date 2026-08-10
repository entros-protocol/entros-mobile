// Stage 8 — on-chain IdentityState reads.
//
// Hand-rolled DataView decoder rather than Anchor's BorshAccountsCoder.
// The latter is strict about total account size: existing devnet accounts
// minted before the `new_wallet: pubkey` field landed at the end of the
// IdentityState struct are 551 bytes, while the refreshed IDL describes
// 583 bytes — Anchor's coder rejects the truncated buffer and `.decode()`
// throws. The website at `entros.io/src/components/sections/dashboard-history.tsx`
// hit the same cross-version compatibility issue and uses the same raw-
// offset DataView pattern this module mirrors below.
//
// We still bundle the IDL elsewhere for instruction building (the wire
// format for outgoing args is stable). Only the ACCOUNT decode path uses
// fixed-offset reads so we transparently parse pre-realloc 551-byte and
// post-realloc 583-byte accounts identically.

import { type Connection, PublicKey } from "@solana/web3.js";
import { bytesToHex } from "@noble/ciphers/utils.js";

import { config } from "@/config";
import { devWarn } from "@/lib/log";
import type { IdentityState } from "@/state/types";

import { findIdentityPda } from "./pdas";

/** Byte offsets of every field inside an IdentityState account. Anchor's
 *  layout writes fields in declaration order with no padding for primitives
 *  beyond their natural alignment, and Solana account data starts with an
 *  8-byte discriminator. These constants must match
 *  `protocol-core/programs/entros-anchor/src/state.rs:IdentityState` field
 *  order verbatim — drift here = silently mis-decoded accounts. */
const OFFSET = {
  /** Discriminator is the first 8 bytes; everything below is offset from
   *  the start of the buffer. */
  OWNER: 8, // 32 bytes
  CREATION_TIMESTAMP: 40, // i64 LE
  LAST_VERIFICATION_TIMESTAMP: 48, // i64 LE
  VERIFICATION_COUNT: 56, // u32 LE
  TRUST_SCORE: 60, // u16 LE
  CURRENT_COMMITMENT: 62, // 32 bytes
  MINT: 94, // 32 bytes
  BUMP: 126, // u8
  RECENT_TIMESTAMPS: 127, // [i64; 52] = 416 bytes (older accounts may have [i64; 10] = 80 bytes here)
  LAST_RESET_TIMESTAMP: 543, // i64 LE (only present on accounts ≥ 551 bytes)
  NEW_WALLET: 551, // 32 bytes (only present on accounts ≥ 583 bytes)
  PROJECTION_VERSION: 583, // u16 LE (only present on accounts ≥ 585 bytes)
} as const;

/** Minimum account size that includes the verification counter — accounts
 *  smaller than this don't carry enough data to populate even the basic
 *  dashboard tiles. Older versions had 10 recent_timestamp slots; we tolerate
 *  those by switching the slot count below. */
const MIN_ACCOUNT_SIZE = 207;
/** Account sizes after each schema revision. We only need the post-reset
 *  size at runtime (it gates whether `last_reset_timestamp` is present);
 *  the post-`new_wallet` size is documented in the OFFSET map for clarity
 *  but isn't read anywhere — once a field follows a known offset, the data
 *  is either present or out-of-range and we let the per-read length checks
 *  handle absence. */
const SIZE_WITH_RESET = 551;
const RECENT_TIMESTAMPS_FULL = 52;
const RECENT_TIMESTAMPS_LEGACY = 10;

/** Direct camelCase mirror of the on-chain `IdentityState` struct as it
 *  reaches the AppState reducer. Mostly numeric primitives so the React tree
 *  re-renders cheaply. `recentTimestamps` is the activity-history source of
 *  truth — chronologically the slot wraps in protocol-core's circular buffer
 *  but the timestamps here are returned in chain-order (oldest first); the
 *  caller sorts/displays as needed. */
export interface OnChainIdentity {
  owner: string;
  creationTimestamp: number;
  lastVerificationTimestamp: number;
  verificationCount: number;
  trustScore: number;
  currentCommitment: Uint8Array;
  mint: string;
  lastResetTimestamp: number;
  /** All non-zero entries from `recent_timestamps[N]`, sorted descending
   *  (most recent first). N is 52 on current accounts, 10 on legacy. The
   *  array length never exceeds N regardless of how many verifications a
   *  wallet has had — older entries roll out of the circular buffer. */
  recentTimestamps: number[];
  projectionVersion: number;
}

/** Reads the user's `IdentityState` PDA. Tolerates the three account-size
 *  variants in the wild (legacy 207-byte minimum, post-reset 551-byte, and
 *  post-new-wallet 583-byte). Returns null if the account doesn't exist
 *  (first-time user pre-mint), the program ID env var is unset, or the
 *  account data is below the minimum size. Never throws — caller treats
 *  null as "no on-chain identity yet" and falls back to the cold-state UI. */
export async function fetchIdentityState(
  walletPubkey: PublicKey,
  connection: Connection,
  failClosed = false,
): Promise<OnChainIdentity | null> {
  const programId = config.programs.entrosAnchor;
  if (!programId) return null;

  const identityPda = findIdentityPda(walletPubkey, programId);

  let accountInfo;
  try {
    accountInfo = await connection.getAccountInfo(identityPda, "confirmed");
  } catch (err) {
    if (failClosed) throw err;
    devWarn("[Entros] getAccountInfo(identity) failed", err);
    return null;
  }
  if (!accountInfo) return null;
  if (accountInfo.data.length < MIN_ACCOUNT_SIZE) {
    if (failClosed) throw new Error("The on-chain identity account is truncated.");
    devWarn(
      `[Entros] IdentityState account too small (${accountInfo.data.length}B < ${MIN_ACCOUNT_SIZE}B)`,
    );
    return null;
  }

  try {
    const view = new DataView(
      accountInfo.data.buffer,
      accountInfo.data.byteOffset,
      accountInfo.data.byteLength,
    );

    const ownerBytes = accountInfo.data.subarray(OFFSET.OWNER, OFFSET.OWNER + 32);
    const owner = new PublicKey(ownerBytes).toBase58();

    const creationTimestamp = Number(view.getBigInt64(OFFSET.CREATION_TIMESTAMP, true));
    const lastVerificationTimestamp = Number(
      view.getBigInt64(OFFSET.LAST_VERIFICATION_TIMESTAMP, true),
    );
    const verificationCount = view.getUint32(OFFSET.VERIFICATION_COUNT, true);
    const trustScore = view.getUint16(OFFSET.TRUST_SCORE, true);

    const currentCommitment = new Uint8Array(
      accountInfo.data.subarray(OFFSET.CURRENT_COMMITMENT, OFFSET.CURRENT_COMMITMENT + 32),
    );
    const mintBytes = accountInfo.data.subarray(OFFSET.MINT, OFFSET.MINT + 32);
    const mint = new PublicKey(mintBytes).toBase58();

    // Legacy accounts (pre-realloc) carried 10 recent_timestamp slots.
    // Current accounts carry 52. We pick the larger when the account is
    // big enough to contain the full array; otherwise we read the legacy
    // 10 slots so the activity tab still shows something for old wallets.
    const slotCount =
      accountInfo.data.length >= OFFSET.LAST_RESET_TIMESTAMP
        ? RECENT_TIMESTAMPS_FULL
        : RECENT_TIMESTAMPS_LEGACY;
    const timestamps: number[] = [];
    for (let i = 0; i < slotCount; i += 1) {
      const offset = OFFSET.RECENT_TIMESTAMPS + i * 8;
      if (offset + 8 > accountInfo.data.length) break;
      const ts = Number(view.getBigInt64(offset, true));
      if (ts > 0) timestamps.push(ts);
    }
    timestamps.sort((a, b) => b - a);

    const lastResetTimestamp =
      accountInfo.data.length >= SIZE_WITH_RESET
        ? Number(view.getBigInt64(OFFSET.LAST_RESET_TIMESTAMP, true))
        : 0;
    const projectionVersion =
      accountInfo.data.length >= OFFSET.PROJECTION_VERSION + 2
        ? view.getUint16(OFFSET.PROJECTION_VERSION, true)
        : 0;

    return {
      owner,
      creationTimestamp,
      lastVerificationTimestamp,
      verificationCount,
      trustScore,
      currentCommitment,
      mint,
      lastResetTimestamp,
      projectionVersion,
      recentTimestamps: timestamps,
    };
  } catch (err) {
    if (failClosed) throw err;
    devWarn("[Entros] IdentityState decode failed", err);
    return null;
  }
}

/** Adapter: on-chain shape → AppState IdentityState shape. Returning a
 *  fresh object every call is intentional so reducer reference checks fire
 *  and React re-renders on the next render pass. The `0x`-prefixed hex
 *  commitment matches the mock format and what the existing dashboard
 *  truncates for display. `recentTimestamps` flows through as Date objects
 *  so the activity tab can render the chain's circular buffer directly. */
export function toAppStateIdentity(onChain: OnChainIdentity): IdentityState {
  return {
    hasAnchor: true,
    trustScore: onChain.trustScore,
    verifications: onChain.verificationCount,
    lastVerifiedAt:
      onChain.lastVerificationTimestamp > 0
        ? new Date(onChain.lastVerificationTimestamp * 1000)
        : null,
    commitment: `0x${bytesToHex(onChain.currentCommitment)}`,
    mint: onChain.mint,
    createdAt: new Date(onChain.creationTimestamp * 1000),
    recentTimestamps: onChain.recentTimestamps.map((t) => new Date(t * 1000)),
    lastResetAt:
      onChain.lastResetTimestamp > 0 ? new Date(onChain.lastResetTimestamp * 1000) : null,
  };
}
